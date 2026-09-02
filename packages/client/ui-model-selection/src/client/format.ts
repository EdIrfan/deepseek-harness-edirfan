/**
 * Compact display helpers for model-row metadata (context window, and — with
 * later plans — price and credit figures). Presentation-only: these format
 * numbers the Host already resolved; they never fetch or compute state.
 * @module @deepseek-ai/dsh-client-ui-model-selection/format
 */

/**
 * Render a token count as a short magnitude label: `4096` becomes `4K`,
 * `128000` becomes `128K`, `1048576` becomes `1M`. Counts below 1000 render
 * unchanged. The label is deliberately lossy; surface the exact value in a
 * `title` attribute when it is needed.
 * @param tokens - a positive token count.
 * @returns the compact label.
 */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${trimTrailingZero((tokens / 1_000_000).toFixed(1))}M`
  }
  if (tokens >= 1000) {
    return `${Math.round(tokens / 1000)}K`
  }
  return String(tokens)
}

/** Drop a `.0` fraction so `1.0` renders as `1` while `1.5` is kept. */
function trimTrailingZero(fixed: string): string {
  return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed
}

/**
 * Render one USD-per-million-tokens rate as a short price: `0.14` becomes
 * `$0.14`, `1.1` becomes `$1.10`, `2` becomes `$2`, a sub-cent rate keeps up to
 * four decimals (`$0.0025`), and an exact zero becomes `$0`.
 * @param perMTok - a non-negative USD rate per one million tokens.
 * @returns the price label without the `/MTok` suffix (callers add the unit).
 */
export function formatPricePerMTok(perMTok: number): string {
  if (perMTok === 0) return '$0'
  if (perMTok < 0.01) return `$${perMTok.toFixed(4).replace(/0+$/, '')}`
  if (Number.isInteger(perMTok)) return `$${perMTok}`
  return `$${perMTok.toFixed(2)}`
}

/**
 * Render an input/output price pair as `$0.14 / $0.28` for a model row.
 * @param inputPerMTok - USD per million input tokens.
 * @param outputPerMTok - USD per million output tokens.
 * @returns the compact `in / out` pair.
 */
export function formatPricePair(inputPerMTok: number, outputPerMTok: number): string {
  return `${formatPricePerMTok(inputPerMTok)} / ${formatPricePerMTok(outputPerMTok)}`
}

/**
 * Render a dollar amount for a provider-account balance: `$12.40`, `$1,240.00`
 * with grouping above a thousand, `< $0.01` for a tiny positive, `$0` for zero.
 * @param usd - a non-negative dollar amount.
 * @returns the display string.
 */
export function formatBalanceUsd(usd: number): string {
  if (usd === 0) return '$0'
  if (usd < 0.01) return '< $0.01'
  return `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
