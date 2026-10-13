import type { FetchLike } from '@modelcontextprotocol/client'
import { followRedirects, testOnlyOrigin } from '../net/redirects.ts'

export { testOnlyOrigin }

// Every sign-in, refresh, identity and revocation request goes through this
// guard: HTTPS without credentials in production, or only the explicit
// test-only loopback origin. Redirects follow the shared rule in
// src/net/redirects.ts, each hop checked the same way; the 15-second timeout
// covers the whole chain.
export function guardedFetch(
  options: { testOnlyBaseUrl?: string; fetch?: typeof fetch } = {},
): FetchLike {
  return guard(options, 15_000)
}
// The same guard for upstream MCP connections, without the timeout: their
// event streams stay open as long as the connection does.
export function upstreamFetch(
  options: { testOnlyBaseUrl?: string; fetch?: typeof fetch } = {},
): FetchLike {
  return guard(options)
}
function guard(
  options: { testOnlyBaseUrl?: string; fetch?: typeof fetch },
  timeoutMs?: number,
): FetchLike {
  const origin = options.testOnlyBaseUrl
    ? testOnlyOrigin(options.testOnlyBaseUrl)
    : undefined
  const base = options.fetch ?? fetch
  return async (input, init) => {
    const url = new URL(input)
    if (url.username || url.password)
      throw new Error('Sign-in URLs must not contain credentials')
    if (origin ? url.origin !== origin : url.protocol !== 'https:')
      throw new Error(
        origin
          ? 'Test sign-in attempted to leave its loopback origin'
          : 'Sign-in requires HTTPS',
      )
    const timeout =
      timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs)
    const signals = [init?.signal, timeout].filter(
      (signal): signal is AbortSignal => Boolean(signal),
    )
    const { response } = await followRedirects(
      url,
      {
        ...init,
        ...(signals.length ? { signal: AbortSignal.any(signals) } : {}),
      },
      { testOnlyOrigin: origin, fetch: base },
    )
    return response
  }
}
export const withTestOrigin = (url: string, testOnlyBaseUrl?: string) =>
  testOnlyBaseUrl
    ? new URL(
        new URL(url).pathname + new URL(url).search,
        testOnlyOrigin(testOnlyBaseUrl),
      ).href
    : url
