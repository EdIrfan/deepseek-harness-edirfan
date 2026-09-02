import { afterEach, describe, expect, it, vi } from 'vitest'
import { openRouterAccountBalance } from '../src/account.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

/** A `fetch` stub recording requests and answering with one canned reply. */
function stubFetch(reply: () => Response): RequestInit[] {
  const requests: RequestInit[] = []
  vi.stubGlobal('fetch', async (_url: string | URL, init?: RequestInit) => {
    requests.push(init ?? {})
    return reply()
  })
  return requests
}

const OPENROUTER = 'https://openrouter.ai/api/v1'
const key = async (): Promise<string> => 'sk-or-test'
const signal = (): AbortSignal => AbortSignal.timeout(2_000)

describe('openRouterAccountBalance', () => {
  it('reads limit_remaining from GET /api/v1/key', async () => {
    const requests = stubFetch(() => new Response(
      JSON.stringify({ data: { limit_remaining: 12.4, usage: 3.1 } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ))

    const balance = await openRouterAccountBalance({ baseURL: OPENROUTER, resolveKey: key, signal: signal() })

    expect(balance).toEqual({ balanceUsd: 12.4 })
    expect(new Headers(requests[0]?.headers).get('authorization')).toBe('Bearer sk-or-test')
  })

  it('returns an empty object when the key reports no cap', async () => {
    stubFetch(() => new Response(
      JSON.stringify({ data: { limit_remaining: null, label: 'k' } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ))

    await expect(openRouterAccountBalance({ baseURL: OPENROUTER, resolveKey: key, signal: signal() }))
      .resolves.toEqual({})
  })

  it('resolves undefined for a non-OpenRouter endpoint without calling fetch', async () => {
    const requests = stubFetch(() => new Response('{}', { status: 200 }))

    await expect(openRouterAccountBalance({
      baseURL: 'https://api.deepseek.com', resolveKey: key, signal: signal(),
    })).resolves.toBeUndefined()
    await expect(openRouterAccountBalance({
      baseURL: 'https://openrouter.ai.evil.test/api/v1', resolveKey: key, signal: signal(),
    })).resolves.toBeUndefined()
    expect(requests).toHaveLength(0)
  })

  it('resolves undefined when the route carries no key', async () => {
    const requests = stubFetch(() => new Response('{}', { status: 200 }))

    await expect(openRouterAccountBalance({
      baseURL: OPENROUTER, resolveKey: async () => undefined, signal: signal(),
    })).resolves.toBeUndefined()
    expect(requests).toHaveLength(0)
  })

  it('throws ACCOUNT_QUERY_FAILED on a non-2xx reply', async () => {
    stubFetch(() => new Response('unauthorized', { status: 401 }))

    await expect(openRouterAccountBalance({ baseURL: OPENROUTER, resolveKey: key, signal: signal() }))
      .rejects.toMatchObject({ code: 'ACCOUNT_QUERY_FAILED' })
  })

  it('throws ABORTED when the signal is already aborted', async () => {
    stubFetch(() => new Response('{}', { status: 200 }))

    await expect(openRouterAccountBalance({
      baseURL: OPENROUTER, resolveKey: key, signal: AbortSignal.abort(),
    })).rejects.toMatchObject({ code: 'ABORTED' })
  })
})
