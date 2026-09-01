import { describe, expect, it } from 'vitest'
import {
  formatPricePair, formatPricePerMTok, formatTokenCount, formatUsd,
} from '../src/client/format.ts'

describe('formatTokenCount', () => {
  it('renders sub-thousand counts unchanged', () => {
    expect(formatTokenCount(0)).toBe('0')
    expect(formatTokenCount(512)).toBe('512')
    expect(formatTokenCount(999)).toBe('999')
  })

  it('renders thousands with a K suffix, rounding non-integers', () => {
    expect(formatTokenCount(1000)).toBe('1K')
    expect(formatTokenCount(4096)).toBe('4K')
    expect(formatTokenCount(64000)).toBe('64K')
    expect(formatTokenCount(128000)).toBe('128K')
    expect(formatTokenCount(200704)).toBe('201K')
  })

  it('renders millions with an M suffix, one decimal for non-integers', () => {
    expect(formatTokenCount(1_000_000)).toBe('1M')
    expect(formatTokenCount(2_000_000)).toBe('2M')
    expect(formatTokenCount(1_048_576)).toBe('1M')
    expect(formatTokenCount(1_500_000)).toBe('1.5M')
  })
})

describe('formatPricePerMTok', () => {
  it('renders an exact zero as $0', () => {
    expect(formatPricePerMTok(0)).toBe('$0')
  })

  it('renders cents with two decimals and whole dollars without', () => {
    expect(formatPricePerMTok(0.14)).toBe('$0.14')
    expect(formatPricePerMTok(1.1)).toBe('$1.10')
    expect(formatPricePerMTok(2)).toBe('$2')
    expect(formatPricePerMTok(15)).toBe('$15')
  })

  it('keeps up to four decimals for sub-cent rates', () => {
    expect(formatPricePerMTok(0.0028)).toBe('$0.0028')
    expect(formatPricePerMTok(0.001)).toBe('$0.001')
  })
})

describe('formatPricePair', () => {
  it('joins input and output prices with a slash', () => {
    expect(formatPricePair(0.14, 0.28)).toBe('$0.14 / $0.28')
    expect(formatPricePair(0.27, 1.1)).toBe('$0.27 / $1.10')
  })
})

describe('formatUsd', () => {
  it('renders a balance with two decimals and thousands grouping', () => {
    expect(formatUsd(12.4)).toBe('$12.40')
    expect(formatUsd(1240)).toBe('$1,240.00')
    expect(formatUsd(0.03)).toBe('$0.03')
  })

  it('collapses zero and sub-cent amounts', () => {
    expect(formatUsd(0)).toBe('$0')
    expect(formatUsd(0.004)).toBe('< $0.01')
  })
})
