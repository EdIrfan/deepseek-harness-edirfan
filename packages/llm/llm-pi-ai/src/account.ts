/**
 * Live account-balance lookup for a configured route whose provider bills a
 * prepaid balance. Only OpenRouter is implemented: its `GET /api/v1/key`
 * endpoint reports the key's remaining spend cap and is not itself token-billed.
 * Any other endpoint resolves to `undefined` — "not applicable", not a failure.
 * @module dsh-llm-pi-ai/account
 */

import { attributionHeaders, LlmError } from '@deepseek-ai/dsh-llm'
import type { LlmProviderAccountBalance } from '@deepseek-ai/dsh-llm'
import { readBoundedText } from './http-body.ts'

/** External spec: the host whose `/api/v1/key` endpoint this module reads. */
const OPENROUTER_HOST = 'openrouter.ai'

/** `LlmError` code for a real network or auth failure during the balance query. */
const ACCOUNT_QUERY_FAILED = 'ACCOUNT_QUERY_FAILED'

/** One request to resolve a route's account balance. */
export interface OpenRouterAccountRequest {
  /** The route's resolved endpoint base (a model's `baseUrl`, or a profile override). */
  readonly baseURL: string | undefined
  /** Resolve the route's API key, or `undefined` when it authenticates ambiently. */
  readonly resolveKey: () => Promise<string | undefined>
  /** Caller lifetime; abort ends the query. */
  readonly signal: AbortSignal
}

/** The `data` object of an OpenRouter `GET /api/v1/key` reply, the field this module reads. */
interface KeyReplyData {
  limit_remaining?: unknown
}

/**
 * Whether `baseURL` points at OpenRouter. Exact host match against
 * {@link OPENROUTER_HOST}: a `startsWith`/`endsWith` check would accept
 * `openrouter.ai.evil.test` or `notopenrouter.ai`.
 */
function isOpenRouter(baseURL: string | undefined): boolean {
  if (baseURL === undefined || baseURL.length === 0) return false
  try {
    return new URL(baseURL).host === OPENROUTER_HOST
  } catch {
    // A base that is not a parseable URL cannot be OpenRouter's documented
    // endpoint; the request that uses it will fail on its own terms.
    return false
  }
}

/** A finite non-negative number field, or `undefined` when absent or unusable. */
function money(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** Whether a thrown value is `fetch`/stream abort or timeout, not a transport fault. */
function isAbort(error: unknown): boolean {
  return error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

/**
 * Resolve one OpenRouter route's account balance, or `undefined` when the route
 * is not OpenRouter or carries no key.
 * @param request - the route's endpoint, key resolver, and caller lifetime.
 * @returns `{ balanceUsd }` when the key reports a cap, `{}` when it does not,
 *   or `undefined` when the query does not apply to this route.
 * @throws {LlmError} `ACCOUNT_QUERY_FAILED` on a non-2xx reply or a network
 *   error; `ABORTED` when the signal aborts.
 */
export async function openRouterAccountBalance(
  request: OpenRouterAccountRequest,
): Promise<LlmProviderAccountBalance | undefined> {
  if (!isOpenRouter(request.baseURL)) return undefined
  const key = await request.resolveKey()
  if (key === undefined || key.length === 0) return undefined
  if (request.signal.aborted) {
    throw new LlmError('account balance query aborted by caller', 'ABORTED')
  }

  const url = `https://${OPENROUTER_HOST}/api/v1/key`
  let response: Response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${key}`,
        ...attributionHeaders(),
      },
      signal: request.signal,
    })
  } catch (error: unknown) {
    if (isAbort(error)) {
      throw new LlmError('account balance query aborted by caller', 'ABORTED', { cause: error })
    }
    throw new LlmError(`could not reach ${url}`, ACCOUNT_QUERY_FAILED, { cause: error })
  }
  if (!response.ok) {
    await response.body?.cancel()
    throw new LlmError(`${url} answered ${response.status}`, ACCOUNT_QUERY_FAILED, { status: response.status })
  }

  let payload: unknown
  try {
    payload = JSON.parse(await readBoundedText(response, url, ACCOUNT_QUERY_FAILED))
  } catch (error: unknown) {
    if (isAbort(error)) {
      throw new LlmError('account balance query aborted by caller', 'ABORTED', { cause: error })
    }
    throw new LlmError(`${url} did not answer with JSON`, ACCOUNT_QUERY_FAILED, { cause: error })
  }

  const data = (payload as { data?: KeyReplyData } | null)?.data ?? {}
  const balanceUsd = money(data.limit_remaining)
  return balanceUsd === undefined ? {} : { balanceUsd }
}
