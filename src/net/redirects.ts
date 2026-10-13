// One redirect rule for the plugin server's guarded fetch and the probe, so
// they cannot drift. Each hop is fetched with `redirect: 'manual'` and checked
// like the first request: HTTPS without URL credentials, or only the explicit
// test-only loopback origin.
// - GET or HEAD without credentials (public metadata discovery) follows 301,
//   302, 303, 307 and 308 to any allowed origin.
// - Every other request follows only 307 and 308 within its origin and
//   re-sends the same method, headers and body, so a bearer token or client
//   secret never leaves the origin it was issued for.
export const maxRedirects = 5
export class RedirectError extends Error {}

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
export interface RedirectOptions {
  // An origin from testOnlyOrigin that every hop must stay on; otherwise HTTPS.
  testOnlyOrigin?: string
  // Treat the request as carrying credentials even without a credential header.
  credentials?: boolean
  fetch?: typeof fetch
}
const redirectStatuses = new Set([301, 302, 303, 307, 308])
const credentialHeaders = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'dpop',
]
const replayable = (body: RequestInit['body']) =>
  body == null ||
  typeof body === 'string' ||
  body instanceof URLSearchParams ||
  body instanceof Blob ||
  body instanceof ArrayBuffer ||
  ArrayBuffer.isView(body)

// Fetches `input`, following redirects by the rule above. Returns the final
// response, its URL and how many redirects were followed; a redirect the rule
// refuses throws RedirectError. Error messages name at most an origin.
export async function followRedirects(
  input: string | URL,
  init: RequestInit = {},
  options: RedirectOptions = {},
): Promise<{ response: Response; url: URL; redirects: number }> {
  const base = options.fetch ?? fetch
  const method = (init.method ?? 'GET').toUpperCase()
  const headers = new Headers(init.headers)
  const strict =
    options.credentials ||
    (method !== 'GET' && method !== 'HEAD') ||
    credentialHeaders.some((name) => headers.has(name))
  let url = new URL(input)
  const seen = new Set([url.href])
  for (let redirects = 0; ; redirects++) {
    const response = await base(url, { ...init, redirect: 'manual' })
    if (!redirectStatuses.has(response.status))
      return { response, url, redirects }
    await response.body?.cancel()
    const location = response.headers.get('location')
    if (!location)
      throw new RedirectError(
        `HTTP ${response.status} redirect has no Location header`,
      )
    let target: URL
    try {
      target = new URL(location, url)
    } catch {
      throw new RedirectError('Redirect Location is not a valid URL')
    }
    if (target.username || target.password)
      throw new RedirectError('Redirect target contains credentials')
    if (
      options.testOnlyOrigin
        ? target.origin !== options.testOnlyOrigin
        : target.protocol !== 'https:'
    )
      throw new RedirectError(
        options.testOnlyOrigin
          ? 'Redirect left the test-only loopback origin'
          : 'Redirect target is not HTTPS',
      )
    if (redirects === maxRedirects)
      throw new RedirectError(`More than ${maxRedirects} redirects`)
    if (seen.has(target.href)) throw new RedirectError('Redirect loop')
    if (strict) {
      if (response.status !== 307 && response.status !== 308)
        throw new RedirectError(
          `HTTP ${response.status} redirect refused for a request with credentials or a body`,
        )
      if (target.origin !== url.origin)
        throw new RedirectError(
          `Redirect to another origin (${target.origin}) refused for a request with credentials or a body`,
        )
      if (!replayable(init.body))
        throw new RedirectError(
          'Redirect refused: the request body cannot be re-sent',
        )
    }
    seen.add(target.href)
    url = target
  }
}
