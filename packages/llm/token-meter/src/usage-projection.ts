/**
 * Pure folds for durable provider-reported token usage and context occupancy.
 */

import { z } from 'zod'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-llm-retry/types'
import type { RequestContextPricing, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { ContextPressureProjection, TokenUsageProjection } from './projection.ts'
import { costOf } from './pricing.ts'
import { foldSurfaceProjection } from './surface-projection.ts'

const zeroBuckets = (): RouteBuckets => ({
  uncachedInputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
})

const bucketsFrom = (usage: TokenUsage): RouteBuckets => ({
  uncachedInputTokens: usage.inputTokens,
  outputTokens: usage.outputTokens,
  cacheReadTokens: usage.cacheReadTokens ?? 0,
  cacheWriteTokens: usage.cacheWriteTokens ?? 0,
})

const bucketsEqual = (left: RouteBuckets, right: RouteBuckets): boolean =>
  left.uncachedInputTokens === right.uncachedInputTokens
  && left.outputTokens === right.outputTokens
  && left.cacheReadTokens === right.cacheReadTokens
  && left.cacheWriteTokens === right.cacheWriteTokens

const addReplacing = (
  totals: RouteBuckets,
  previous: RouteBuckets | undefined,
  next: RouteBuckets,
): RouteBuckets => ({
  uncachedInputTokens: totals.uncachedInputTokens - (previous?.uncachedInputTokens ?? 0) + next.uncachedInputTokens,
  outputTokens: totals.outputTokens - (previous?.outputTokens ?? 0) + next.outputTokens,
  cacheReadTokens: totals.cacheReadTokens - (previous?.cacheReadTokens ?? 0) + next.cacheReadTokens,
  cacheWriteTokens: totals.cacheWriteTokens - (previous?.cacheWriteTokens ?? 0) + next.cacheWriteTokens,
})

const bucketsSchema = z.object({
  uncachedInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
}).strict()

/**
 * Wire view schema for {@link TokenUsageProjection}: the flat totals plus the
 * optional `costUsd`. The `transform` re-materializes the object so an absent
 * `costUsd` is a missing key, not an explicit `undefined`
 * (`exactOptionalPropertyTypes`).
 */
const projectionSchema: z.ZodType<TokenUsageProjection> = bucketsSchema.extend({
  costUsd: z.number().nonnegative().optional(),
}).strict().transform((view): TokenUsageProjection => ({
  uncachedInputTokens: view.uncachedInputTokens,
  outputTokens: view.outputTokens,
  cacheReadTokens: view.cacheReadTokens,
  cacheWriteTokens: view.cacheWriteTokens,
  ...view.costUsd === undefined ? {} : { costUsd: view.costUsd },
}))

const ratesSchema = z.object({
  inputPerMTok: z.number().nonnegative(),
  outputPerMTok: z.number().nonnegative(),
  cacheReadPerMTok: z.number().nonnegative(),
  cacheWritePerMTok: z.number().nonnegative(),
}).strict()

/**
 * The token-usage unit's state schema — the one definition of the state
 * shape; the state type is inferred from it.
 *
 * The session cost estimate accumulates as a running scalar: each usage sample
 * (net of any replacement) is priced at the rates in force when it lands, so
 * a session that switches models still totals correctly without a per-route
 * ledger. `unpriceable` latches when a billed sample lands with no known rates.
 */
const tokenUsageStateSchema = z.object({
  totals: bucketsSchema,
  last: z.object({
    turn: z.number().int().nonnegative(),
    step: z.number().int().nonnegative(),
    buckets: bucketsSchema,
  }).nullable(),
  /** Rates in force for the next usage sample, from the last `request/context` that carried them; null when unknown. */
  currentRates: ratesSchema.nullable(),
  /** Running session cost in USD; meaningful only while `unpriceable` is false. */
  costUsd: z.number().nonnegative(),
  /** Whether any billed sample landed with no rates, which suppresses the session cost. */
  unpriceable: z.boolean(),
  /** Whether at least one sample was priced, so an untouched session reports no cost rather than `$0`. */
  hasPricedUsage: z.boolean(),
}).strict()

type TokenUsageState = z.infer<typeof tokenUsageStateSchema>
type RouteBuckets = z.infer<typeof bucketsSchema>

const pressureSchema: z.ZodType<ContextPressureProjection> = z.object({
  pressureTokens: z.number().int().nonnegative().optional(),
  projectedTokens: z.number().int().nonnegative().optional(),
  contextWindow: z.number().int().positive().optional(),
}).strict().transform(({ pressureTokens, projectedTokens, contextWindow }) => ({
  ...pressureTokens === undefined ? {} : { pressureTokens },
  ...projectedTokens === undefined ? {} : { projectedTokens },
  ...contextWindow === undefined ? {} : { contextWindow },
}))

/** Prompt-side pressure of one request: input plus cache traffic, no output. */
const pressureFrom = (usage: TokenUsage): number =>
  usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)

/** The usage a chunk or finalized message reports for its step, if any. */
const usageOf = (event: SessionEvent): TokenUsage | undefined =>
  event.type === 'assistant/chunk' && event.data.chunk.type === 'usage'
    ? event.data.chunk.usage
    : event.type === 'assistant/message'
      ? event.data.usage
      : undefined

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    tokenUsage: TokenUsageState
    contextPressure: ContextPressureState
  }
}

/** The context-pressure state schema and source of its inferred type. */
const contextPressureStateSchema = z.object({
  contextWindow: z.number().int().positive().optional(),
  pressureTokens: z.number().int().nonnegative().optional(),
  surfaceTokens: z.number().int().nonnegative(),
  sampledSurfaceTokens: z.number().int().nonnegative().optional(),
  claim: z.object({
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
    tokens: z.number().int().nonnegative(),
  }).optional(),
}).strict()

type ContextPressureState = z.infer<typeof contextPressureStateSchema>

/** Sum of the four buckets; a sample with a positive total is billed traffic. */
const bucketTotal = (b: RouteBuckets): number =>
  b.uncachedInputTokens + b.outputTokens + b.cacheReadTokens + b.cacheWriteTokens

/** Rates the fold carries in state, matching {@link RequestContextPricing}. */
type Rates = z.infer<typeof ratesSchema>

/** Copy `request/context` price rates into the fold's own structure. */
const ratesFrom = (pricing: RequestContextPricing): Rates => ({
  inputPerMTok: pricing.inputPerMTok,
  outputPerMTok: pricing.outputPerMTok,
  cacheReadPerMTok: pricing.cacheReadPerMTok,
  cacheWritePerMTok: pricing.cacheWritePerMTok,
})

/**
 * Token-meter's session projection unit.
 *
 * Usage chunks provide an early sample that survives a later request failure;
 * an assistant message provides the final sample for the same attempt. A
 * repeated sample replaces that attempt's earlier value instead of double
 * counting it, while `llm/retry-started` closes the replacement slot so the
 * retried attempt adds to the total. The single `last` slot relies on the
 * session-log invariant that usage reports for one attempt are adjacent.
 *
 * `request/context` sets `currentRates` for the next sample. Each sample's net
 * token movement is priced at those rates and added to a running `costUsd`;
 * `request/context` only re-anchors between attempts, so the rates for a
 * replacement match the rates its earlier sample was priced at. The flat
 * `totals` stay unchanged for consumers that only want token counts.
 */
export const tokenUsageProjectionDefinition = {
  key: 'tokenUsage',
  stateVersion: 4,
  stateSchema: tokenUsageStateSchema,
  init: (): TokenUsageState => ({
    totals: zeroBuckets(),
    last: null,
    currentRates: null,
    costUsd: 0,
    unpriceable: false,
    hasPricedUsage: false,
  }),
  apply: (state, event) => {
    if (event.type === 'request/context') {
      const pricing: RequestContextPricing | undefined = event.data.pricing
      return { ...state, currentRates: pricing === undefined ? null : ratesFrom(pricing) }
    }
    if (event.type === 'llm/retry-started') {
      return state.last?.turn === event.data.turn && state.last.step === event.data.step
        ? { ...state, last: null }
        : state
    }
    let turn: number
    let step: number
    let usage: TokenUsage
    if (event.type === 'assistant/chunk' && event.data.chunk.type === 'usage') {
      ;({ turn, step } = event.data)
      usage = event.data.chunk.usage
    } else if (event.type === 'assistant/message' && event.data.usage !== undefined) {
      ;({ turn, step, usage } = event.data)
    } else {
      return state
    }

    const buckets = bucketsFrom(usage)
    const sameAttempt = state.last !== null && state.last.turn === turn && state.last.step === step
    const previous = sameAttempt ? state.last?.buckets : undefined
    if (previous !== undefined && bucketsEqual(previous, buckets)) return state

    const rates = state.currentRates
    const netBilled = bucketTotal(buckets) - (previous === undefined ? 0 : bucketTotal(previous))
    const priced = rates !== null
    return {
      totals: addReplacing(state.totals, previous, buckets),
      last: { turn, step, buckets },
      currentRates: rates,
      costUsd: priced
        ? state.costUsd + costOf(buckets, rates)
          - (previous === undefined ? 0 : costOf(previous, rates))
        : state.costUsd,
      unpriceable: state.unpriceable || (!priced && netBilled > 0),
      hasPricedUsage: state.hasPricedUsage || (priced && netBilled > 0),
    }
  },
  wire: {
    viewSchema: projectionSchema,
    view: (state): TokenUsageProjection => ({
      ...state.totals,
      ...state.unpriceable || !state.hasPricedUsage ? {} : { costUsd: state.costUsd },
    }),
  },
} satisfies ProjectionDefinition<'tokenUsage', TokenUsageState>

/**
 * Token-meter's context-occupancy projection unit.
 *
 * Independent last-wins slots: the newest usage sample supplies the provider
 * numerator, the newest `request/context` record the denominator. Both are
 * whole values, so replay order alone decides the result and no cross-field
 * consistency is claimed — the pair is explicitly not one atomic request
 * observation (see {@link ContextPressureProjection}).
 *
 * `pressureTokens` is prompt-side only, so it holds still while a turn streams
 * and steps forward once the next request reports its usage. Because nothing
 * but a request reports usage, it also cannot see a compaction: the fold
 * therefore carries a running surface total alongside it and publishes
 * `projectedTokens` — the sample plus the surface's signed movement since it
 * was taken — so occupancy answers for the next request rather than the last
 * one. The total rides {@link foldSurfaceProjection}, so the state stays O(1)
 * and a replacement shrinks it by its logged shadow price. A replacement
 * without a claim preserves the previous total. A usage sample is stamped
 * BEFORE the same event joins the surface, so an `assistant/message` anchors
 * against the surface its own request saw.
 */
export const contextPressureProjectionDefinition = {
  key: 'contextPressure',
  stateVersion: 4,
  stateSchema: contextPressureStateSchema,
  init: () => ({ surfaceTokens: 0 }),
  apply: (state, event) => {
    const fold = foldSurfaceProjection(state.claim, event)
    let next = state
    if (event.type === 'request/context') {
      const contextWindow = event.data.contextWindow
      if (contextWindow !== state.contextWindow) {
        if (contextWindow !== undefined) {
          next = { ...next, contextWindow }
        } else {
          const { contextWindow: _removed, ...withoutContextWindow } = next
          next = withoutContextWindow
        }
      }
    }
    const usage = usageOf(event)
    if (usage !== undefined) {
      const pressureTokens = pressureFrom(usage)
      if (pressureTokens !== next.pressureTokens || next.sampledSurfaceTokens !== next.surfaceTokens) {
        next = { ...next, pressureTokens, sampledSurfaceTokens: next.surfaceTokens }
      }
    }
    if (fold.deltaTokens !== 0) {
      next = { ...next, surfaceTokens: next.surfaceTokens + fold.deltaTokens }
    }
    // A defined fold.claim is always freshly built, so presence decides claim
    // bookkeeping: no claim before or after this event leaves `next` as is.
    if (state.claim === undefined && fold.claim === undefined) return next
    const { claim: _expired, ...withoutClaim } = next
    return fold.claim === undefined ? withoutClaim : { ...withoutClaim, claim: fold.claim }
  },
  wire: {
    viewSchema: pressureSchema,
    view: ({ contextWindow, pressureTokens, surfaceTokens, sampledSurfaceTokens }) => ({
      ...contextWindow === undefined ? {} : { contextWindow },
      ...pressureTokens === undefined ? {} : { pressureTokens },
      ...pressureTokens === undefined || sampledSurfaceTokens === undefined
        ? {}
        : { projectedTokens: Math.max(0, pressureTokens + surfaceTokens - sampledSurfaceTokens) },
    }),
  },
} satisfies ProjectionDefinition<'contextPressure', ContextPressureState>
