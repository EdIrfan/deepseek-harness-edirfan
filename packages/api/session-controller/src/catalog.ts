/** Shared projection of the live LLM registry into the browser model catalog. */

import type { Context } from '@deepseek-ai/cordis'
import type {
  ModelCatalog,
  ModelProviderAccount,
  ModelReasoning,
  ModelSelection,
} from './types.ts'

/**
 * How long a resolved provider-account balance is reused before the next
 * catalog build re-queries it. A politeness bound on an external endpoint, not
 * a deployment knob: OpenRouter's balance moves slowly and the catalog rebuilds
 * on every adapter, settings, or credential change.
 */
const ACCOUNT_TTL_MS = 60_000

/** Per-catalog-build deadline for one provider-account balance query. */
const ACCOUNT_QUERY_TIMEOUT_MS = 4_000

interface AccountCacheEntry {
  readonly at: number
  readonly value: ModelProviderAccount | undefined
}

/** Process-wide cache of the last resolved account balance per provider route. */
const accountCache = new Map<string, AccountCacheEntry>()

/**
 * Drop the provider-account cache. For tests only: production relies on the
 * {@link ACCOUNT_TTL_MS} window, and there is no runtime reason to invalidate
 * early.
 */
export function resetAccountCacheForTests(): void {
  accountCache.clear()
}

/**
 * Resolve one provider's live account balance, cached for {@link ACCOUNT_TTL_MS}.
 * A failure or timeout is cosmetic: it resolves to `undefined` and is cached
 * briefly so a broken endpoint does not re-slow every catalog build. A `catch`
 * here is deliberate — the balance is decoration, and the group must load
 * without it.
 * @param ctx - Host context carrying the LLM registry.
 * @param provider - the provider route id.
 * @returns the account figures, or `undefined` when unavailable or not applicable.
 */
async function resolveAccount(ctx: Context, provider: string): Promise<ModelProviderAccount | undefined> {
  const cached = accountCache.get(provider)
  if (cached !== undefined && Date.now() - cached.at < ACCOUNT_TTL_MS) return cached.value
  let value: ModelProviderAccount | undefined
  try {
    const balance = await ctx.llm.providerAccountBalance(provider, AbortSignal.timeout(ACCOUNT_QUERY_TIMEOUT_MS))
    value = balance === undefined
      ? undefined
      : {
        ...balance.balanceUsd === undefined ? {} : { balanceUsd: balance.balanceUsd },
        ...balance.usageUsd === undefined ? {} : { usageUsd: balance.usageUsd },
      }
  } catch {
    // A network error, a non-2xx reply, or the 4s timeout: the balance is a
    // display extra, so the group still loads without it. Cached as `undefined`
    // so the failing endpoint is not re-queried on the next few builds.
    value = undefined
  }
  accountCache.set(provider, { at: Date.now(), value })
  return value
}

/**
 * Build the browser model catalog without requiring a Session.
 * @param ctx - Host context carrying the live LLM registry.
 * @param defaultSelection - deployment default used before a Session selects a model.
 * @returns successful non-empty provider groups and isolated provider failures.
 */
export async function buildModelCatalog(
  ctx: Context,
  defaultSelection: ModelSelection = ctx.agentDefaultModel.currentSelection(),
): Promise<ModelCatalog> {
  const providers = ctx.llm.listProviders()
  const catalog = await Promise.all(providers.map(async (provider) => {
    try {
      const models = await ctx.llm.listModels(provider.id)
      const entries = await Promise.all(models.map(async (model) => {
        const resolved = await ctx.llm.resolveModelInfo(provider.id, model.id)
        const reasoning: ModelReasoning | undefined = resolved.reasoning === undefined
          ? undefined
          : {
            efforts: resolved.reasoning.efforts.map(effort => ({
              id: effort.id,
              name: effort.name,
              ...(effort.description === undefined ? {} : { description: effort.description }),
            })),
            ...(resolved.reasoning.defaultEffort === undefined
              ? {}
              : { defaultEffort: resolved.reasoning.defaultEffort }),
          }
        return {
          id: model.id,
          name: model.name,
          ...(model.description === undefined ? {} : { description: model.description }),
          ...(reasoning === undefined ? {} : { reasoning }),
          ...(resolved.context?.contextWindow === undefined
            ? {}
            : { contextWindow: resolved.context.contextWindow }),
          ...(resolved.pricing === undefined ? {} : {
            pricing: {
              inputPerMTok: resolved.pricing.inputPerMTok,
              outputPerMTok: resolved.pricing.outputPerMTok,
              cacheReadPerMTok: resolved.pricing.cacheReadPerMTok,
              cacheWritePerMTok: resolved.pricing.cacheWritePerMTok,
            },
          }),
        }
      }))
      const account = await resolveAccount(ctx, provider.id)
      return {
        kind: 'group' as const,
        group: {
          id: provider.id,
          name: provider.name,
          models: entries,
          ...(account === undefined ? {} : { account }),
        },
      }
    } catch (error) {
      return {
        kind: 'failure' as const,
        failure: {
          id: provider.id,
          name: provider.name,
          message: error instanceof Error ? error.message : String(error),
        },
      }
    }
  }))
  return {
    default: { ...defaultSelection },
    routableProviders: providers.map(provider => provider.id),
    groups: catalog.flatMap(item => item.kind === 'group' ? [item.group] : [])
      .filter(group => group.models.length > 0),
    failures: catalog.flatMap(item => item.kind === 'failure' ? [item.failure] : []),
  }
}
