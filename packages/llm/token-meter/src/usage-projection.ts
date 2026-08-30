/**
 * Pure folds for durable provider-reported token usage and context occupancy.
 */

import { z } from 'zod'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-llm-retry/types'
import type { RequestContextPricing, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type {
  ContextPressureProjection, TokenUsageProjection, TokenUsageRouteSpend,
} from './projection.ts'
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

const routeSpendSchema = z.object({
  provider: z.string(),
  model: z.string(),
  uncachedInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative().optional(),
}).strict().transform((route): TokenUsageRouteSpend => ({
  provider: route.provider,
  model: route.model,
  uncachedInputTokens: route.uncachedInputTokens,
  outputTokens: route.outputTokens,
  cacheReadTokens: route.cacheReadTokens,
  cacheWriteTokens: route.cacheWriteTokens,
  ...route.costUsd === undefined ? {} : { costUsd: route.costUsd },
}))

/**
 * Wire view schema for {@link TokenUsageProjection}: the flat totals plus the
 * optional cost fields. The `transform` re-materializes the object so an absent
 * `costUsd` / `byRoute` is a missing key, not an explicit `undefined`
 * (`exactOptionalPropertyTypes`).
 */
const projectionSchema: z.ZodType<TokenUsageProjection> = bucketsSchema.extend({
  costUsd: z.number().nonnegative().optional(),
  byRoute: z.array(routeSpendSchema).optional(),
}).strict().transform((view): TokenUsageProjection => ({
  uncachedInputTokens: view.uncachedInputTokens,
  outputTokens: view.outputTokens,
  cacheReadTokens: view.cacheReadTokens,
  cacheWriteTokens: view.cacheWriteTokens,
  ...view.costUsd === undefined ? {} : { costUsd: view.costUsd },
  ...view.byRoute === undefined ? {} : { byRoute: view.byRoute },
}))

const ratesSchema = z.object({
  inputPerMTok: z.number().nonnegative(),
  outputPerMTok: z.number().nonnegative(),
  cacheReadPerMTok: z.number().nonnegative(),
  cacheWritePerMTok: z.number().nonnegative(),
}).strict()

/** One route's cumulative buckets and its last-seen rates, in the projection state. */
const routeStateSchema = z.object({
  provider: z.string(),
  model: z.string(),
  buckets: bucketsSchema,
  rates: ratesSchema.optional(),
}).strict()

/**
 * The token-usage unit's state schema — the one definition of the state
 * shape; the state type is inferred from it.
 */
const tokenUsageStateSchema = z.object({
  totals: bucketsSchema,
  last: z.object({
    turn: z.number().int().nonnegative(),
    step: z.number().int().nonnegative(),
    routeKey: z.string().nullable(),
    buckets: bucketsSchema,
  }).nullable(),
  /** Route the folder attributes the next usage sample to (last `request/context`). */
  currentRoute: z.object({ provider: z.string(), model: z.string() }).nullable(),
  /** Per-route accumulation, keyed by `"provider\0model"`; first-seen order preserved by insertion. */
  byRoute: z.record(z.string(), routeStateSchema),
  /** Whether any usage sample landed with no attributable route (suppresses the session cost). */
  hasUnattributed: z.boolean(),
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

/** `"provider\0model"` key for the per-route accumulation map. */
const routeMapKey = (provider: string, model: string): string => `${provider}\0${model}`

/** Sum of the four buckets; used to decide whether a route contributed billed tokens. */
const bucketTotal = (b: RouteBuckets): number =>
  b.uncachedInputTokens + b.outputTokens + b.cacheReadTokens + b.cacheWriteTokens

/**
 * Project the state's per-route accumulation into the wire view: one entry per
 * route in first-seen order, each with its own cost estimate when the route
 * logged rates, plus a whole-session `costUsd` present only when every route
 * that billed tokens has rates and nothing landed unattributed.
 */
function costView(state: TokenUsageState): Pick<TokenUsageProjection, 'costUsd' | 'byRoute'> {
  const entries = Object.values(state.byRoute)
  if (entries.length === 0 && !state.hasUnattributed) return {}
  const byRoute: TokenUsageRouteSpend[] = entries.map((route) => {
    const spend: TokenUsageRouteSpend = {
      provider: route.provider,
      model: route.model,
      uncachedInputTokens: route.buckets.uncachedInputTokens,
      outputTokens: route.buckets.outputTokens,
      cacheReadTokens: route.buckets.cacheReadTokens,
      cacheWriteTokens: route.buckets.cacheWriteTokens,
    }
    return route.rates === undefined
      ? spend
      : { ...spend, costUsd: costOf(route.buckets, route.rates) }
  })
  const priceable = !state.hasUnattributed
    && entries.every(route => route.rates !== undefined || bucketTotal(route.buckets) === 0)
  const costUsd = priceable
    ? entries.reduce((sum, route) => route.rates === undefined
      ? sum
      : sum + costOf(route.buckets, route.rates), 0)
    : undefined
  return {
    ...byRoute.length === 0 ? {} : { byRoute },
    ...costUsd === undefined ? {} : { costUsd },
  }
}

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
 * `request/context` sets the route the next usage sample is attributed to and,
 * when it carried price rates, stamps those rates on that route. The wire view
 * derives a per-route spend breakdown and a whole-session cost estimate; the
 * flat `totals` stay unchanged for consumers that only want token counts.
 */
export const tokenUsageProjectionDefinition = {
  key: 'tokenUsage',
  stateVersion: 3,
  stateSchema: tokenUsageStateSchema,
  init: (): TokenUsageState => ({
    totals: zeroBuckets(), last: null, currentRoute: null, byRoute: {}, hasUnattributed: false,
  }),
  apply: (state, event) => {
    if (event.type === 'request/context') {
      const { provider, model } = event.data
      const key = routeMapKey(provider, model)
      const pricing: RequestContextPricing | undefined = event.data.pricing
      const existing = state.byRoute[key]
      const route = {
        provider,
        model,
        buckets: existing?.buckets ?? zeroBuckets(),
        ...(pricing === undefined ? existing?.rates === undefined ? {} : { rates: existing.rates } : {
          rates: {
            inputPerMTok: pricing.inputPerMTok,
            outputPerMTok: pricing.outputPerMTok,
            cacheReadPerMTok: pricing.cacheReadPerMTok,
            cacheWritePerMTok: pricing.cacheWritePerMTok,
          },
        }),
      }
      return { ...state, currentRoute: { provider, model }, byRoute: { ...state.byRoute, [key]: route } }
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

    const routeKey = state.currentRoute === null
      ? null
      : routeMapKey(state.currentRoute.provider, state.currentRoute.model)
    // A repeated sample replaces within the same route it was first added to.
    const previousRouteKey = sameAttempt ? state.last?.routeKey ?? null : null

    const nextByRoute = { ...state.byRoute }
    if (routeKey !== null && state.currentRoute !== null) {
      const existing = nextByRoute[routeKey] ?? {
        provider: state.currentRoute.provider, model: state.currentRoute.model, buckets: zeroBuckets(),
      }
      const previousForRoute = previousRouteKey === routeKey ? previous : undefined
      nextByRoute[routeKey] = {
        ...existing,
        buckets: addReplacing(existing.buckets, previousForRoute, buckets),
      }
    }

    return {
      totals: addReplacing(state.totals, previous, buckets),
      last: { turn, step, routeKey, buckets },
      currentRoute: state.currentRoute,
      byRoute: nextByRoute,
      hasUnattributed: state.hasUnattributed || routeKey === null,
    }
  },
  wire: {
    viewSchema: projectionSchema,
    view: (state): TokenUsageProjection => ({ ...state.totals, ...costView(state) }),
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
