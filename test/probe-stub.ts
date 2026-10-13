import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import type { AddressInfo } from 'node:net'
export interface StubSettings {
  endpoint?: '/mcp' | '/sse'
  methods?: ('dcr' | 'cimd')[]
  pkce?: boolean
  status?: number
  missingMetadata?: boolean
  header?: boolean
  issuerPath?: string
  resourceAtRoot?: boolean
  discovery?: 'oauth' | 'openid-insert' | 'openid-append'
  slowMs?: number
  metadataSlowMs?: number
  failFirst?: number
  resourceMismatch?: boolean
  // Advertised resource: a path on the stub origin, or an absolute URL.
  resource?: string
  stream?: boolean
  issuerMismatch?: boolean
  invalidJson?: boolean
  unsafeMetadata?: boolean
  // Origin used in the URLs the stub publishes, for tests that route HTTPS
  // hosts to it; default its own loopback origin.
  origin?: string
  // Issuer published in authorization metadata; default the stub's issuer.
  issuer?: string
  // Redirects answered before anything else: path to status and Location.
  redirects?: Record<string, { status: number; location?: string }>
}
export async function stub(
  t: { after: (fn: () => Promise<void>) => void },
  settings: StubSettings = {},
) {
  const hits: {
    method: string
    path: string
    body: string
    authorization?: string
    userAgent?: string
  }[] = []
  let own = ''
  let active = 0
  let peak = 0
  let initialCount = 0
  const server = createServer(async (req, res) => {
    active++
    peak = Math.max(peak, active)
    res.once('close', () => {
      active--
    })
    let body = ''
    for await (const chunk of req) body += String(chunk)
    const path = req.url!
    hits.push({
      method: req.method!,
      path,
      body,
      authorization: req.headers.authorization,
      userAgent: req.headers['user-agent'],
    })
    const redirect = settings.redirects?.[path]
    if (redirect) {
      res
        .writeHead(
          redirect.status,
          redirect.location ? { Location: redirect.location } : {},
        )
        .end('secret-vendor-body')
      return
    }
    const base = settings.origin ?? own
    const endpoint = settings.endpoint ?? '/mcp'
    const resourcePath =
      '/.well-known/oauth-protected-resource' +
      (settings.resourceAtRoot ? '' : endpoint)
    const issuerPath = settings.issuerPath ?? ''
    const issuer = base + issuerPath
    const methods = settings.methods ?? ['dcr']
    const discovery = settings.discovery ?? 'oauth'
    const authPath =
      discovery === 'oauth'
        ? '/.well-known/oauth-authorization-server' + issuerPath
        : discovery === 'openid-insert'
          ? '/.well-known/openid-configuration' + issuerPath
          : issuerPath + '/.well-known/openid-configuration'
    // The endpoint also answers with a trailing slash, as a redirect target.
    if (['/mcp', '/sse', '/mcp/', '/sse/'].includes(path)) {
      initialCount++
      if (settings.slowMs) await delay(settings.slowMs)
      const status =
        initialCount <= (settings.failFirst ?? 0)
          ? 503
          : (settings.status ?? 401)
      res.writeHead(status, {
        ...(settings.header === false
          ? {}
          : {
              'WWW-Authenticate': `Bearer resource_metadata="${base}${resourcePath}"`,
            }),
        ...(settings.stream ? { 'Content-Type': 'text/event-stream' } : {}),
      })
      // An open event stream never ends on its own; the probe must cancel it.
      if (settings.stream) res.write(': secret-vendor-body\n\n')
      else res.end('secret-vendor-body')
    } else if (path === resourcePath && !settings.missingMetadata) {
      res.setHeader('Content-Type', 'application/json')
      res.flushHeaders()
      if (settings.metadataSlowMs) await delay(settings.metadataSlowMs)
      if (settings.invalidJson) {
        res.end('secret-vendor-body-not-json')
        return
      }
      res.end(
        JSON.stringify({
          resource:
            settings.resource === undefined
              ? base + (settings.resourceMismatch ? '/wrong' : endpoint)
              : settings.resource.startsWith('/') || settings.resource === ''
                ? base + settings.resource
                : settings.resource,
          authorization_servers: [
            settings.unsafeMetadata ? 'http://example.com/secret' : issuer,
          ],
        }),
      )
    } else if (path === authPath && !settings.missingMetadata) {
      res.setHeader('Content-Type', 'application/json')
      res.end(
        JSON.stringify({
          issuer: settings.issuerMismatch
            ? base + '/wrong'
            : (settings.issuer ?? issuer),
          // Enough for the MCP SDK's sign-in to start; the probe ignores them.
          authorization_endpoint: base + '/authorize',
          token_endpoint: base + '/token',
          response_types_supported: ['code'],
          ...(methods.includes('dcr')
            ? { registration_endpoint: base + '/register' }
            : {}),
          client_id_metadata_document_supported: methods.includes('cimd'),
          code_challenge_methods_supported:
            settings.pkce === false ? ['plain'] : ['S256'],
        }),
      )
    } else if (path === '/register' && req.method === 'POST') {
      // Only the sign-in in agreement tests registers; the probe never does.
      res.writeHead(201, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ...JSON.parse(body), client_id: 'stub-client' }))
    } else res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  own = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  async function close() {
    if (!server.listening) return
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
  t.after(close)
  return {
    base: own,
    hits,
    close,
    get peak() {
      return peak
    },
  }
}
