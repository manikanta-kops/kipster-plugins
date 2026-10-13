import type { FetchLike } from '@modelcontextprotocol/client'

export function testOnlyOrigin(value: string): string {
  const base = new URL(value)
  if (
    base.protocol !== 'http:' ||
    base.hostname !== '127.0.0.1' ||
    base.username ||
    base.password ||
    base.pathname !== '/' ||
    base.search ||
    base.hash
  )
    throw new Error('Test-only base URL must be an HTTP 127.0.0.1 origin')
  return base.origin
}
// Every sign-in, refresh, identity and revocation request goes through this
// guard: HTTPS without credentials in production, or only the explicit
// test-only loopback origin. Redirects are refused, with a 15-second timeout.
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
    const url = new URL(input instanceof Request ? input.url : String(input))
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
    return base(input, {
      ...init,
      redirect: 'error',
      ...(signals.length ? { signal: AbortSignal.any(signals) } : {}),
    })
  }
}
export const withTestOrigin = (url: string, testOnlyBaseUrl?: string) =>
  testOnlyBaseUrl
    ? new URL(
        new URL(url).pathname + new URL(url).search,
        testOnlyOrigin(testOnlyBaseUrl),
      ).href
    : url
