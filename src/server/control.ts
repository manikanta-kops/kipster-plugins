import type { IncomingMessage, ServerResponse } from 'node:http'
import { availability, data, type Plugin } from '../catalogue/types.ts'
import { AccountError, type Accounts } from '../accounts/accounts.ts'
import { SignInError, type SignInManager } from '../signin/signin.ts'
import { serverName, serverVersion } from './version.ts'

// Flags for additive changes; clients check a flag before using a feature.
export const capabilities = [
  'plugins',
  'sign-in',
  'accounts',
  'mcp',
  'return-address',
]

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}
export function sendJson(res: ServerResponse, status: number, value: unknown) {
  res
    .writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    })
    .end(JSON.stringify(value))
}
export const sendError = (res: ServerResponse, error: ApiError) =>
  sendJson(res, error.status, {
    error: { code: error.code, message: error.message },
  })

async function readBody(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  let text = ''
  for await (const chunk of req) {
    text += String(chunk)
    if (text.length > 65_536)
      throw new ApiError(413, 'too-large', 'Request body is too large')
  }
  if (!text.trim()) return {}
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new ApiError(400, 'invalid-request', 'Request body is not JSON')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new ApiError(400, 'invalid-request', 'Request body must be an object')
  return value as Record<string, unknown>
}
const accountStatus: Record<AccountError['code'], number> = {
  'not-found': 404,
  'invalid-label': 400,
  'reconnect-needed': 409,
  'refresh-failed': 502,
}
const signInStatus: Record<SignInError['code'], number> = {
  'unknown-sign-in': 404,
  expired: 410,
  denied: 403,
  'invalid-address': 400,
  'no-sign-in-method': 422,
  'invalid-return-address': 400,
  'loopback-only': 422,
  failed: 502,
}
export function apiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error
  if (error instanceof AccountError)
    return new ApiError(accountStatus[error.code], error.code, error.message)
  if (error instanceof SignInError)
    return new ApiError(signInStatus[error.code], error.code, error.message)
  return new ApiError(500, 'internal', 'Internal error')
}

export interface ControlContext {
  plugins: () => ReadonlyMap<string, Plugin>
  accounts: Accounts
  signIn: SignInManager
}
function summary(plugin: Plugin, accounts: Accounts) {
  const ext = data(plugin)
  const state = availability(plugin)
  return {
    id: ext.id,
    name: ext.name,
    description: plugin.manifest.description,
    category: ext.category,
    website: ext.website,
    signIn: ext.signIn,
    available: state.available,
    ...(state.reason ? { unavailableReason: state.reason } : {}),
    probe: ext.probe ?? null,
    verification: ext.verification ?? null,
    needsAddress: ext.needsAddress,
    ...(ext.addressPrompt ? { addressPrompt: ext.addressPrompt } : {}),
    accountCount: accounts.list(ext.id).length,
  }
}
type Route = (
  ctx: ControlContext,
  params: string[],
  req: IncomingMessage,
  url: URL,
) => Promise<[number, unknown]> | [number, unknown]

function plugin(ctx: ControlContext, id: string): Plugin {
  const found = ctx.plugins().get(id)
  if (!found) throw new ApiError(404, 'unknown-plugin', 'Unknown plugin')
  return found
}
function account(ctx: ControlContext, id: string) {
  const found = ctx.accounts.get(id)
  if (!found) throw new ApiError(404, 'not-found', 'Account not found')
  return found
}
const routes: [string, RegExp, Route][] = [
  [
    'GET',
    /^\/v1$/,
    () => [
      200,
      {
        version: 'v1',
        server: { name: serverName, version: serverVersion },
        capabilities,
      },
    ],
  ],
  [
    'GET',
    /^\/v1\/plugins$/,
    (ctx) => [
      200,
      {
        plugins: [...ctx.plugins().values()]
          .map((p) => summary(p, ctx.accounts))
          .sort((a, b) => a.id.localeCompare(b.id)),
      },
    ],
  ],
  [
    'GET',
    /^\/v1\/plugins\/([^/]+)$/,
    (ctx, [id]) => {
      const found = plugin(ctx, id!)
      return [
        200,
        {
          plugin: {
            ...summary(found, ctx.accounts),
            accounts: ctx.accounts.list(id),
          },
        },
      ]
    },
  ],
  [
    'POST',
    /^\/v1\/plugins\/([^/]+)\/sign-in$/,
    async (ctx, [id], req) => {
      const body = await readBody(req)
      const found = plugin(ctx, id!)
      const state = availability(found)
      if (!state.available)
        throw new ApiError(
          409,
          'plugin-unavailable',
          state.reason ?? 'This plugin is unavailable',
        )
      if (body.address !== undefined && typeof body.address !== 'string')
        throw new ApiError(400, 'invalid-request', 'address must be a string')
      if (
        body.returnAddress !== undefined &&
        typeof body.returnAddress !== 'string'
      )
        throw new ApiError(
          400,
          'invalid-request',
          'returnAddress must be a string',
        )
      return [
        200,
        await ctx.signIn.start(found, {
          ...(body.address === undefined ? {} : { address: body.address }),
          ...(body.returnAddress === undefined
            ? {}
            : { returnAddress: body.returnAddress }),
        }),
      ]
    },
  ],
  [
    'GET',
    /^\/v1\/sign-ins\/([^/]+)$/,
    (ctx, [id]) => {
      const status = ctx.signIn.status(id!)
      if (status.status === 'unknown')
        throw new ApiError(
          404,
          'unknown-sign-in',
          'This sign-in is unknown or has expired',
        )
      if (status.status === 'completed') {
        const { plugin: p, account: a, duplicate } = status.result
        return [
          200,
          {
            id,
            status: 'completed',
            plugin: p,
            account: ctx.accounts.get(a.id) ?? a,
            duplicate,
          },
        ]
      }
      return [200, { id, ...status }]
    },
  ],
  [
    'PUT',
    /^\/v1\/plugins\/([^/]+)\/default-account$/,
    async (ctx, [id], req) => {
      const body = await readBody(req)
      if (body.account !== null && typeof body.account !== 'string')
        throw new ApiError(
          400,
          'invalid-request',
          'account must be an account id or null',
        )
      ctx.accounts.setDefault(id!, body.account ?? undefined)
      return [200, { plugin: id, defaultAccount: body.account }]
    },
  ],
  [
    'DELETE',
    /^\/v1\/plugins\/([^/]+)\/default-account$/,
    (ctx, [id]) => {
      ctx.accounts.setDefault(id!, undefined)
      return [200, { plugin: id, defaultAccount: null }]
    },
  ],
  [
    'GET',
    /^\/v1\/accounts$/,
    (ctx, _params, _req, url) => {
      const filter = url.searchParams.get('plugin')
      return [
        200,
        { accounts: ctx.accounts.list(filter === null ? undefined : filter) },
      ]
    },
  ],
  [
    'GET',
    /^\/v1\/accounts\/([^/]+)$/,
    (ctx, [id]) => [200, { account: account(ctx, id!) }],
  ],
  [
    'PATCH',
    /^\/v1\/accounts\/([^/]+)$/,
    async (ctx, [id], req) => {
      const body = await readBody(req)
      account(ctx, id!)
      if (typeof body.label !== 'string')
        throw new ApiError(400, 'invalid-request', 'label must be a string')
      return [200, { account: ctx.accounts.rename(id!, body.label) }]
    },
  ],
  [
    'DELETE',
    /^\/v1\/accounts\/([^/]+)$/,
    async (ctx, [id]) => {
      account(ctx, id!)
      const { revoked } = await ctx.accounts.remove(id!)
      return [200, { removed: true, revoked }]
    },
  ],
]

// Answers one /v1 request with JSON. Responses never hold tokens or secrets.
export async function control(
  ctx: ControlContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  try {
    let pathMatched = false
    for (const [method, pattern, route] of routes) {
      const match = pattern.exec(url.pathname)
      if (!match) continue
      pathMatched = true
      if (method !== req.method) continue
      let params: string[]
      try {
        params = match.slice(1).map((p) => decodeURIComponent(p))
      } catch {
        throw new ApiError(400, 'invalid-request', 'Malformed path')
      }
      const [status, body] = await route(ctx, params, req, url)
      return sendJson(res, status, body)
    }
    throw pathMatched
      ? new ApiError(405, 'method-not-allowed', 'Method not allowed')
      : new ApiError(404, 'not-found', 'Not found')
  } catch (error) {
    if (!res.headersSent) sendError(res, apiError(error))
  }
}
