/**
 * Pure per-bucket cost arithmetic for the token meter. Multiplies exact
 * provider-reported token counts by the per-million-token rates a request
 * logged on its `request/context` event. No I/O, no state.
 * @module @deepseek-ai/dsh-token-meter/pricing
 */

import type { RequestContextPricing } from '@deepseek-ai/dsh-session/types'

/** Exact token counts for one priced request bucket set. */
export interface CostBuckets {
  readonly uncachedInputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
}

/**
 * USD cost of one bucket set under one route's rates. Rates are USD per one
 * million tokens, so each term divides by 1e6.
 * @param buckets - non-negative token counts.
 * @param rates - the route's logged per-million-token rates.
 * @returns the summed cost in USD (may be 0).
 */
export function costOf(buckets: CostBuckets, rates: RequestContextPricing): number {
  return (
    buckets.uncachedInputTokens * rates.inputPerMTok
    + buckets.outputTokens * rates.outputPerMTok
    + buckets.cacheReadTokens * rates.cacheReadPerMTok
    + buckets.cacheWriteTokens * rates.cacheWritePerMTok
  ) / 1_000_000
}
