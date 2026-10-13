import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Catalogue } from '../catalogue/loader.ts'
import { Accounts } from '../accounts/accounts.ts'
import type { KeyBackend } from '../secrets/store.ts'
import { SignInManager } from '../signin/signin.ts'
import { guardedFetch, testOnlyOrigin } from '../signin/fetch.ts'
import { openHome } from '../state/home.ts'
import { callbackPath, loadSettings, type Settings } from '../state/settings.ts'
import { ApiError, control, sendError, sendJson } from './control.ts'
import { Gateway } from './gateway.ts'
import { mcpEndpoint } from './mcp.ts'
import { loadToken, tokenMatches } from './token.ts'
import { controlApiVersions, serverVersion } from './version.ts'

export interface ServeOptions {
  // 0 picks a free port.
  port: number
  home: string
  catalogue: string
  keyBackend: KeyBackend
  // Test only: every outbound request goes to this HTTP 127.0.0.1 origin.
  testOnlyBaseUrl?: string
  env?: NodeJS.ProcessEnv
  settings?: Settings
  listTimeoutMs?: number
  catalogueReconcileMs?: number
  log?: (line: string) => void
}
export interface PluginServer {
  url: string
  port: number
  token: string
  http: Server
  accounts: Accounts
  gateway: Gateway
  catalogue: Catalogue
  close(): Promise<void>
}

const loopback = new Set(['127.0.0.1', 'localhost', '[::1]'])
// Browsers send Origin; only loopback pages may reach the token-protected routes.
function originAllowed(req: IncomingMessage) {
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return loopback.has(new URL(origin).hostname)
  } catch {
    return false
  }
}

// The plugin server: /health, /callback, the control API under /v1 and the
// MCP endpoint at /mcp, on 127.0.0.1 only.
export async function startServer(
  options: ServeOptions,
): Promise<PluginServer> {
  if (options.testOnlyBaseUrl) testOnlyOrigin(options.testOnlyBaseUrl)
  const settings = options.settings ?? loadSettings(options.env)
  const home = await openHome(options.home, { keyBackend: options.keyBackend })
  let token: string
  try {
    token = await loadToken(options.home, options.env)
  } catch (error) {
    home.close()
    throw error
  }
  const http = createServer()
  try {
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject)
      http.listen(options.port, '127.0.0.1', () => {
        http.off('error', reject)
        resolve()
      })
    })
  } catch (error) {
    home.close()
    throw error
  }
  const port = (http.address() as AddressInfo).port
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`])
  const accounts = new Accounts(home, {
    fetch: guardedFetch({ testOnlyBaseUrl: options.testOnlyBaseUrl }),
  })
  const signIn = new SignInManager({
    accounts,
    secrets: home.secrets,
    settings,
    port,
    testOnlyBaseUrl: options.testOnlyBaseUrl,
  })
  const gateway = new Gateway({
    accounts,
    testOnlyBaseUrl: options.testOnlyBaseUrl,
    listTimeoutMs: options.listTimeoutMs,
  })
  const catalogue = new Catalogue(
    options.catalogue,
    50,
    options.catalogueReconcileMs ?? 1000,
  )
  // The catalogue rescans every second; report each invalid folder once.
  const reported = new Map<string, string>()
  catalogue.on('change', (plugins) => {
    for (const plugin of plugins.values()) reported.delete(plugin.folder)
    gateway.setPlugins(plugins)
  })
  catalogue.on('invalid', ({ folder, reason }) => {
    if (reported.get(folder) === reason) return
    reported.set(folder, reason)
    options.log?.(`Catalogue: ${folder}: ${reason}`)
  })
  await catalogue.start()
  const mcp = mcpEndpoint(gateway)
  const callback = signIn.callbackHandler()
  const ctx = { plugins: () => gateway.plugins, accounts, signIn }

  http.on('request', (req, res) => {
    void (async () => {
      // DNS rebinding defence on every route.
      if (!hosts.has(req.headers.host ?? ''))
        return sendError(
          res,
          new ApiError(403, 'forbidden-host', 'Host is not allowed'),
        )
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
      if (url.pathname === '/health')
        return req.method === 'GET'
          ? sendJson(res, 200, {
              status: 'ok',
              version: serverVersion,
              controlApiVersions,
            })
          : sendError(
              res,
              new ApiError(405, 'method-not-allowed', 'Method not allowed'),
            )
      if (url.pathname === callbackPath)
        return req.method === 'GET'
          ? callback(req, res)
          : sendError(
              res,
              new ApiError(405, 'method-not-allowed', 'Method not allowed'),
            )
      if (!tokenMatches(req.headers.authorization, token)) {
        res.setHeader('WWW-Authenticate', 'Bearer')
        return sendError(
          res,
          new ApiError(401, 'unauthorized', 'A valid bearer token is required'),
        )
      }
      if (!originAllowed(req))
        return sendError(
          res,
          new ApiError(403, 'forbidden-origin', 'Origin is not allowed'),
        )
      if (url.pathname === '/mcp') return mcp.handle(req, res)
      if (url.pathname === '/v1' || url.pathname.startsWith('/v1/'))
        return control(ctx, req, res, url)
      sendError(res, new ApiError(404, 'not-found', 'Not found'))
    })().catch(() => {
      if (!res.headersSent)
        sendError(res, new ApiError(500, 'internal', 'Internal error'))
      else res.end()
    })
  })

  let closing: Promise<void> | undefined
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    token,
    http,
    accounts,
    gateway,
    catalogue,
    close() {
      closing ??= (async () => {
        catalogue.close()
        const stopped = new Promise<void>((resolve) =>
          http.close(() => resolve()),
        )
        await mcp.close()
        await gateway.close()
        http.closeAllConnections()
        await stopped
        home.close()
      })()
      return closing
    },
  }
}
