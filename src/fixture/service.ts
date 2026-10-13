import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  createMcpHandler,
  fromJsonSchema,
  McpServer,
  type AuthInfo,
} from '@modelcontextprotocol/server'
import { toNodeHandler } from '@modelcontextprotocol/node'

// Level 1 stand-in for a class A service: OAuth authorization server, protected
// resource and MCP server on one loopback origin. Test data only.
export interface FixtureUser {
  id: string
  login: string
  email: string
}
export const fixtureUsers: FixtureUser[] = [
  { id: 'u-1001', login: 'alice', email: 'alice@fixture.test' },
  { id: 'u-1002', login: 'bob', email: 'bob@fixture.test' },
]
export type FixtureIdentity = 'userinfo' | 'id-token' | 'tool' | 'none'
export interface FixtureSettings {
  dcr: boolean
  cimd: boolean
  // userinfo: userinfo_endpoint; id-token: id_token in token responses;
  // tool and none: neither (the whoami tool always exists).
  identity: FixtureIdentity
  accessTokenTtl: number
}
export interface FixtureOptions extends Partial<FixtureSettings> {
  port?: number
  // Adds `echo`, which declares its own `account` argument, and a tool whose
  // name is too long to proxy.
  extraTools?: boolean
  // Resolves a CIMD client_id URL to its document. No default network fetch.
  clientMetadata?: (url: string) => Promise<unknown>
}
export interface FixtureStats {
  registrations: number
  clientMetadataFetches: number
  authorizationCodeGrants: number
  refreshGrants: number
  revocations: number
  authorizeRequests: URLSearchParams[]
}
interface Client {
  id: string
  secret?: string
  redirectUris: string[]
}
interface Grant {
  user: FixtureUser
  clientId: string
  resource?: string
  scope?: string
  revoked: boolean
}
export interface Fixture {
  url: string
  mcpUrl: string
  settings: FixtureSettings
  stats: FixtureStats
  // Every access and refresh token issued, for at-rest checks in tests.
  issuedTokens(): string[]
  // Revokes every grant of a user, as if they disconnected the app at the service.
  revokeUser(login: string): void
  // Forgets every registered client, as if the service deleted them.
  forgetClients(): void
  // Expires every access token issued so far; refresh tokens keep working.
  expireAccessTokens(): void
  notes(login: string): string[]
  close(): Promise<void>
}

const s256 = (verifier: string) =>
  createHash('sha256').update(verifier).digest('base64url')
const token = (prefix: string) =>
  `${prefix}-${randomBytes(24).toString('base64url')}`
// RFC 8252 section 7.3: loopback redirect URIs match regardless of port.
function redirectMatches(registered: string, requested: string): boolean {
  if (registered === requested) return true
  try {
    const a = new URL(registered)
    const b = new URL(requested)
    return (
      a.protocol === 'http:' &&
      b.protocol === 'http:' &&
      ['127.0.0.1', '[::1]', 'localhost'].includes(a.hostname) &&
      a.hostname === b.hostname &&
      a.pathname === b.pathname &&
      a.search === b.search
    )
  } catch {
    return false
  }
}
async function body(req: IncomingMessage): Promise<string> {
  let text = ''
  for await (const chunk of req) {
    text += String(chunk)
    if (text.length > 65_536) throw new Error('Request body too large')
  }
  return text
}
function json(res: ServerResponse, status: number, value: unknown) {
  res
    .writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    })
    .end(JSON.stringify(value))
}
const oauthError = (res: ServerResponse, status: number, error: string) =>
  json(res, status, { error })

export async function startFixture(
  options: FixtureOptions = {},
): Promise<Fixture> {
  const settings: FixtureSettings = {
    dcr: options.dcr ?? true,
    cimd: options.cimd ?? true,
    identity: options.identity ?? 'userinfo',
    accessTokenTtl: options.accessTokenTtl ?? 3600,
  }
  const stats: FixtureStats = {
    registrations: 0,
    clientMetadataFetches: 0,
    authorizationCodeGrants: 0,
    refreshGrants: 0,
    revocations: 0,
    authorizeRequests: [],
  }
  const clients = new Map<string, Client>()
  const codes = new Map<
    string,
    {
      grant: Grant
      redirectUri: string
      challenge: string
      expires: number
    }
  >()
  const accessTokens = new Map<string, { grant: Grant; expires: number }>()
  const refreshTokens = new Map<string, Grant>()
  const issued: string[] = []
  const notes = new Map<string, string[]>()
  let base = ''

  function issue(grant: Grant) {
    const access = token('fixture-at')
    const refresh = token('fixture-rt')
    issued.push(access, refresh)
    accessTokens.set(access, {
      grant,
      expires: Date.now() + settings.accessTokenTtl * 1000,
    })
    refreshTokens.set(refresh, grant)
    const now = Math.floor(Date.now() / 1000)
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: settings.accessTokenTtl,
      refresh_token: refresh,
      ...(grant.scope ? { scope: grant.scope } : {}),
      ...(settings.identity === 'id-token'
        ? {
            // Unsigned is enough here: clients accept id_token only from the
            // direct token response (OpenID Connect Core 3.1.3.7).
            id_token: [
              { alg: 'none', typ: 'JWT' },
              {
                iss: base,
                aud: grant.clientId,
                sub: grant.user.id,
                email: grant.user.email,
                preferred_username: grant.user.login,
                iat: now,
                exp: now + 300,
              },
            ]
              .map((part) =>
                Buffer.from(JSON.stringify(part)).toString('base64url'),
              )
              .concat('')
              .join('.'),
          }
        : {}),
    }
  }
  function bearer(req: IncomingMessage) {
    const match = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? '')
    const entry = match ? accessTokens.get(match[1]!) : undefined
    return entry && !entry.grant.revoked && entry.expires > Date.now()
      ? { token: match![1]!, grant: entry.grant }
      : undefined
  }
  async function client(id: string): Promise<Client | undefined> {
    const registered = clients.get(id)
    if (registered) return registered
    if (!settings.cimd || !id.startsWith('https://') || !options.clientMetadata)
      return undefined
    stats.clientMetadataFetches++
    try {
      const doc = (await options.clientMetadata(id)) as {
        client_id?: unknown
        redirect_uris?: unknown
      }
      if (
        doc?.client_id !== id ||
        !Array.isArray(doc.redirect_uris) ||
        !doc.redirect_uris.every((uri) => typeof uri === 'string')
      )
        return undefined
      return { id, redirectUris: doc.redirect_uris as string[] }
    } catch {
      return undefined
    }
  }
  function clientAuthenticated(
    req: IncomingMessage,
    form: URLSearchParams,
    found: Client,
  ): boolean {
    if (!found.secret) return true
    const basic = /^Basic (\S+)$/i.exec(req.headers.authorization ?? '')
    if (basic) {
      const [id, secret] = Buffer.from(basic[1]!, 'base64')
        .toString()
        .split(':')
        .map(decodeURIComponent)
      return id === found.id && secret === found.secret
    }
    return form.get('client_secret') === found.secret
  }

  const mcp = toNodeHandler(
    createMcpHandler(({ authInfo }) => {
      const user = authInfo?.extra?.user as FixtureUser
      const server = new McpServer({
        name: 'kipster-fixture',
        version: '1.0.0',
      })
      server.registerTool(
        'whoami',
        {
          description: 'Report the signed-in fixture user.',
          annotations: { readOnlyHint: true },
        },
        async () => ({
          content: [{ type: 'text', text: JSON.stringify(user) }],
          structuredContent: { ...user },
        }),
      )
      server.registerTool(
        'create_note',
        {
          description: 'Save a note for the signed-in fixture user.',
          inputSchema: fromJsonSchema<{ text: string }>({
            type: 'object',
            properties: { text: { type: 'string', minLength: 1 } },
            required: ['text'],
          }),
        },
        async ({ text }) => {
          const list = notes.get(user.login) ?? []
          list.push(text)
          notes.set(user.login, list)
          const note = { id: list.length, text, owner: user.login }
          return {
            content: [{ type: 'text', text: JSON.stringify(note) }],
            structuredContent: note,
          }
        },
      )
      if (options.extraTools) {
        server.registerTool(
          'echo',
          {
            description: 'Echo the account argument and the signed-in user.',
            inputSchema: fromJsonSchema<{ account: string }>({
              type: 'object',
              properties: { account: { type: 'string' } },
              required: ['account'],
            }),
          },
          async ({ account }) => ({
            content: [
              {
                type: 'text',
                text: JSON.stringify({ account, user: user.login }),
              },
            ],
          }),
        )
        server.registerTool(
          `report_${'x'.repeat(60)}`,
          { description: 'A tool whose proxied name would be too long.' },
          async () => ({ content: [{ type: 'text', text: 'long' }] }),
        )
      }
      return server
    }),
  )

  const handlers: Record<
    string,
    (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<unknown>
  > = {
    'GET /.well-known/oauth-protected-resource/mcp': async (_req, res) =>
      json(res, 200, {
        resource: `${base}/mcp`,
        authorization_servers: [base],
        scopes_supported: ['notes'],
        bearer_methods_supported: ['header'],
      }),
    'GET /.well-known/oauth-authorization-server': async (_req, res) =>
      json(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        revocation_endpoint: `${base}/revoke`,
        ...(settings.dcr ? { registration_endpoint: `${base}/register` } : {}),
        ...(settings.identity === 'userinfo'
          ? { userinfo_endpoint: `${base}/userinfo` }
          : {}),
        client_id_metadata_document_supported: settings.cimd,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: [
          'none',
          'client_secret_basic',
          'client_secret_post',
        ],
        scopes_supported: ['notes'],
        prompt_values_supported: ['consent', 'select_account'],
        authorization_response_iss_parameter_supported: true,
      }),
    'POST /register': async (req, res) => {
      if (!settings.dcr) return res.writeHead(404).end()
      let metadata: {
        redirect_uris?: unknown
        token_endpoint_auth_method?: unknown
      }
      try {
        metadata = JSON.parse(await body(req))
      } catch {
        return oauthError(res, 400, 'invalid_client_metadata')
      }
      const uris = metadata.redirect_uris
      if (
        !Array.isArray(uris) ||
        !uris.length ||
        !uris.every((uri) => typeof uri === 'string' && URL.canParse(uri))
      )
        return oauthError(res, 400, 'invalid_redirect_uri')
      stats.registrations++
      const method =
        typeof metadata.token_endpoint_auth_method === 'string'
          ? metadata.token_endpoint_auth_method
          : 'client_secret_basic'
      const registered: Client = {
        id: randomUUID(),
        redirectUris: uris as string[],
        ...(method === 'none' ? {} : { secret: token('fixture-cs') }),
      }
      clients.set(registered.id, registered)
      json(res, 201, {
        ...metadata,
        client_id: registered.id,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        token_endpoint_auth_method: method,
        ...(registered.secret
          ? { client_secret: registered.secret, client_secret_expires_at: 0 }
          : {}),
      })
    },
    'GET /authorize': async (_req, res, url) => {
      const q = url.searchParams
      stats.authorizeRequests.push(q)
      const found = await client(q.get('client_id') ?? '')
      const redirectUri = q.get('redirect_uri') ?? ''
      // Without a trusted redirect URI, errors are shown, never redirected.
      if (!found) return oauthError(res, 400, 'invalid_client')
      if (!found.redirectUris.some((uri) => redirectMatches(uri, redirectUri)))
        return oauthError(res, 400, 'invalid_redirect_uri')
      const back = new URL(redirectUri)
      const state = q.get('state')
      if (state) back.searchParams.set('state', state)
      back.searchParams.set('iss', base)
      const fail = (error: string) => {
        back.searchParams.set('error', error)
        res.writeHead(302, { Location: back.href }).end()
      }
      if (q.get('response_type') !== 'code')
        return fail('unsupported_response_type')
      if (q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge'))
        return fail('invalid_request')
      const login = q.get('user')
      if (!login) {
        // Consent page for a person using the CLI; tests pass ?user= instead.
        const links = fixtureUsers
          .map((u) => {
            const choice = new URL(url.href, base)
            choice.searchParams.set('user', u.login)
            return `<li><a href="${choice.pathname}${choice.search.replaceAll('&', '&amp;')}">Sign in as ${u.login}</a></li>`
          })
          .join('')
        res
          .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          .end(`<!doctype html><title>Fixture sign-in</title><ul>${links}</ul>`)
        return
      }
      if (login === 'deny') return fail('access_denied')
      const user = fixtureUsers.find((u) => u.login === login)
      if (!user) return fail('access_denied')
      const code = token('fixture-code')
      codes.set(code, {
        grant: {
          user,
          clientId: found.id,
          resource: q.get('resource') ?? undefined,
          scope: q.get('scope') ?? undefined,
          revoked: false,
        },
        redirectUri,
        challenge: q.get('code_challenge')!,
        expires: Date.now() + 60_000,
      })
      back.searchParams.set('code', code)
      res.writeHead(302, { Location: back.href }).end()
    },
    'POST /token': async (req, res) => {
      const form = new URLSearchParams(await body(req))
      const basicId = /^Basic (\S+)$/i.exec(req.headers.authorization ?? '')
      const clientId =
        form.get('client_id') ??
        (basicId
          ? decodeURIComponent(
              Buffer.from(basicId[1]!, 'base64').toString().split(':')[0]!,
            )
          : '')
      const found = await client(clientId)
      if (!found || !clientAuthenticated(req, form, found))
        return oauthError(res, 401, 'invalid_client')
      if (form.get('grant_type') === 'authorization_code') {
        const code = codes.get(form.get('code') ?? '')
        codes.delete(form.get('code') ?? '')
        if (
          !code ||
          code.expires < Date.now() ||
          code.grant.clientId !== found.id ||
          code.redirectUri !== form.get('redirect_uri') ||
          s256(form.get('code_verifier') ?? '') !== code.challenge
        )
          return oauthError(res, 400, 'invalid_grant')
        stats.authorizationCodeGrants++
        return json(res, 200, issue(code.grant))
      }
      if (form.get('grant_type') === 'refresh_token') {
        stats.refreshGrants++
        const old = form.get('refresh_token') ?? ''
        const grant = refreshTokens.get(old)
        // Rotation: a refresh token works once.
        refreshTokens.delete(old)
        if (!grant || grant.revoked || grant.clientId !== found.id)
          return oauthError(res, 400, 'invalid_grant')
        return json(res, 200, issue(grant))
      }
      oauthError(res, 400, 'unsupported_grant_type')
    },
    'POST /revoke': async (req, res) => {
      const form = new URLSearchParams(await body(req))
      const value = form.get('token') ?? ''
      const grant = refreshTokens.get(value) ?? accessTokens.get(value)?.grant
      if (grant) {
        grant.revoked = true
        stats.revocations++
      }
      res.writeHead(200).end()
    },
    'GET /userinfo': async (req, res) => {
      if (settings.identity !== 'userinfo') return res.writeHead(404).end()
      const auth = bearer(req)
      if (!auth) return res.writeHead(401).end()
      const { user } = auth.grant
      json(res, 200, {
        sub: user.id,
        email: user.email,
        preferred_username: user.login,
      })
    },
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', base)
      if (url.pathname === '/mcp') {
        const auth = bearer(req)
        if (
          !auth ||
          (auth.grant.resource && auth.grant.resource !== `${base}/mcp`)
        ) {
          res
            .writeHead(401, {
              'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
            })
            .end()
          return
        }
        const info: AuthInfo = {
          token: auth.token,
          clientId: auth.grant.clientId,
          scopes: auth.grant.scope?.split(' ') ?? [],
          extra: { user: auth.grant.user },
        }
        Object.assign(req, { auth: info })
        await mcp(req, res)
        return
      }
      const handler = handlers[`${req.method} ${url.pathname}`]
      if (handler) await handler(req, res, url)
      else res.writeHead(404).end()
    } catch {
      if (!res.headersSent) res.writeHead(500)
      res.end()
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, '127.0.0.1', resolve)
  })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    url: base,
    mcpUrl: `${base}/mcp`,
    settings,
    stats,
    issuedTokens: () => [...issued],
    revokeUser(login) {
      for (const grant of refreshTokens.values())
        if (grant.user.login === login) grant.revoked = true
      for (const { grant } of accessTokens.values())
        if (grant.user.login === login) grant.revoked = true
    },
    forgetClients: () => clients.clear(),
    expireAccessTokens() {
      for (const entry of accessTokens.values()) entry.expires = 0
    },
    notes: (login) => [...(notes.get(login) ?? [])],
    async close() {
      if (!server.listening) return
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    },
  }
}
