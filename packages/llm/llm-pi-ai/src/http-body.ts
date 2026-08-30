/**
 * Bounded reply-body reader shared by the endpoint interrogations this package
 * runs against caller-supplied URLs (model discovery, provider account state).
 * The URL is whatever a deployment configured, so the ceiling holds on the
 * bytes actually read rather than on the length the server claims.
 * @module dsh-llm-pi-ai/http-body
 */

import { LlmError } from '@deepseek-ai/dsh-llm'

/** Reply bodies larger than this are refused rather than truncated. */
export const MAX_HTTP_BODY_BYTES = 4 * 1024 * 1024

/**
 * Read a reply body as text, refusing one that outgrows {@link MAX_HTTP_BODY_BYTES}.
 * A declared `content-length` is checked first so an honest server is turned
 * away without transferring anything; the accumulated total is what actually
 * enforces the bound, because a server that under-declares or streams tells us
 * nothing up front.
 * @param response - a 2xx `fetch` response.
 * @param url - the requested URL, for the overflow diagnostic.
 * @param code - the `LlmError` code to raise on overflow.
 * @returns the decoded body text.
 * @throws {LlmError} with `code` when the body exceeds the ceiling.
 */
export async function readBoundedText(response: Response, url: string, code: string): Promise<string> {
  const oversized = (): LlmError =>
    new LlmError(`${url} answered with more than ${MAX_HTTP_BODY_BYTES} bytes`, code)
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > MAX_HTTP_BODY_BYTES) {
    await response.body?.cancel()
    throw oversized()
  }
  /* v8 ignore next -- fetch always exposes a body stream on a 2xx Response; the null guard is defensive. */
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_HTTP_BODY_BYTES) throw oversized()
      chunks.push(value)
    }
  } finally {
    /* v8 ignore next 4 -- cancel() after a completed or abandoned read settles without rejecting; unobserved best-effort cleanup. */
    await reader.cancel().catch(() => {
      // Cancel after a drained read, or after this function walked away from an
      // oversized one, is cleanup; the reply is already decided either way.
    })
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(body)
}
