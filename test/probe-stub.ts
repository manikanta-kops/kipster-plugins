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
  issuerMismatch?: boolean
  redirect?: boolean
  invalidJson?: boolean
  unsafeMetadata?: boolean
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
  let base = ''
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
    if (path === '/mcp' || path === '/sse') {
      initialCount++
      if (settings.slowMs) await delay(settings.slowMs)
      if (settings.redirect) {
        res.writeHead(307, { Location: base + '/register' }).end()
        return
      }
      const status =
        initialCount <= (settings.failFirst ?? 0)
          ? 503
          : (settings.status ?? 401)
      res
        .writeHead(
          status,
          settings.header === false
            ? {}
            : {
                'WWW-Authenticate': `Bearer resource_metadata="${base}${resourcePath}"`,
              },
        )
        .end()
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
          resource: base + (settings.resourceMismatch ? '/wrong' : endpoint),
          authorization_servers: [
            settings.unsafeMetadata ? 'http://example.com/secret' : issuer,
          ],
        }),
      )
    } else if (path === authPath && !settings.missingMetadata) {
      res.setHeader('Content-Type', 'application/json')
      res.end(
        JSON.stringify({
          issuer: settings.issuerMismatch ? base + '/wrong' : issuer,
          ...(methods.includes('dcr')
            ? { registration_endpoint: base + '/register' }
            : {}),
          client_id_metadata_document_supported: methods.includes('cimd'),
          code_challenge_methods_supported:
            settings.pkce === false ? ['plain'] : ['S256'],
        }),
      )
    } else res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  async function close() {
    if (!server.listening) return
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
  t.after(close)
  return {
    base,
    hits,
    close,
    get peak() {
      return peak
    },
  }
}
