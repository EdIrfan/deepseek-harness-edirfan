import { describe, expect, it } from 'vitest'
import { costOf } from '../src/pricing.ts'

const RATES = {
  inputPerMTok: 0.3, outputPerMTok: 1.5, cacheReadPerMTok: 0.03, cacheWritePerMTok: 0.375,
}

describe('costOf', () => {
  it('multiplies each bucket by its per-million rate and sums', () => {
    // 1000*0.3 + 500*1.5 + 200*0.03 + 100*0.375, all / 1e6
    const expected = (1000 * 0.3 + 500 * 1.5 + 200 * 0.03 + 100 * 0.375) / 1_000_000
    expect(costOf({
      uncachedInputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 200,
      cacheWriteTokens: 100,
    }, RATES)).toBeCloseTo(expected, 15)
  })

  it('returns 0 for all-zero buckets or all-zero rates', () => {
    expect(costOf({
      uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    }, RATES)).toBe(0)
    expect(costOf({
      uncachedInputTokens: 9, outputTokens: 9, cacheReadTokens: 9, cacheWriteTokens: 9,
    }, {
      inputPerMTok: 0, outputPerMTok: 0, cacheReadPerMTok: 0, cacheWritePerMTok: 0,
    })).toBe(0)
  })
})
