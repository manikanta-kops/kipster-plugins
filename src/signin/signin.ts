import { randomBytes, randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  auth,
  discoverOAuthServerInfo,
  type FetchLike,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type OAuthTokens,
  type StoredOAuthClientInformation,
} from '@modelcontextprotocol/client'
import {
  data,
  server,
  toolLabel,
  type Plugin,
  type SignIn,
} from '../catalogue/types.ts'
import type { Account, Accounts } from '../accounts/accounts.ts'
import { identify } from '../accounts/identity.ts'
import { connectMcp } from '../mcp/client.ts'
import type { SecretStore } from '../secrets/store.ts'
import { returnAddress, type Settings } from '../state/settings.ts'
import { applyAddress } from './address.ts'
import { guardedFetch, withTestOrigin } from './fetch.ts'

export class SignInError extends Error {
  readonly code:
    | 'unknown-sign-in'
    | 'expired'
    | 'denied'
    | 'invalid-address'
    | 'no-sign-in-method'
    | 'invalid-return-address'
    | 'loopback-only'
    | 'failed'
  constructor(code: SignInError['code'], message: string) {
    super(message)
    this.code = code
  }
}
export type StartResult =
  | {
      status: 'redirect'
      id: string
      method: SignIn
      authorizationUrl: string
      serverUrl: string
      expiresAt: string
    }
  | { status: 'needs-client-metadata-document' }
export interface Completed {
  id: string
  plugin: string
  account: Account
  duplicate: boolean
}
export type SignInStatus =
  | { status: 'pending'; plugin: string }
  | { status: 'completed'; result: Completed }
  | { status: 'failed'; plugin: string; code: SignInError['code'] }
  | { status: 'unknown' }
export interface SignInOptions {
  accounts: Accounts
  secrets: SecretStore
  settings: Settings
  // Port of the local HTTP server that mounts the callback handler.
  port: number
  pendingTtlMs?: number
  now?: () => number
  // Test only: replace service origins with an HTTP 127.0.0.1 fixture origin.
  testOnlyBaseUrl?: string
}

interface Pending {
  id: string
  plugin: Plugin
  state: string
  serverUrl: string
  connectUrl: string
  provider: SessionProvider
}
interface Entry {
  status: SignInStatus
  // Kept until the browser returns with this sign-in's state.
  pending?: Pending
  // When a waiting sign-in expires, or when a settled one is forgotten.
  until: number
}
// One OAuthClientProvider per pending sign-in; the SDK runs discovery, DCR or
// CIMD, PKCE S256, the code exchange and RFC 9207 issuer checks through it.
class SessionProvider implements OAuthClientProvider {
  readonly redirectUrl: string
  readonly clientMetadataUrl?: string
  readonly state: () => string
  #discovery: OAuthDiscoveryState
  #client?: StoredOAuthClientInformation
  #verifier = ''
  #tokens?: OAuthTokens
  authorizationUrl?: URL
  readonly #registrations?: { secrets: SecretStore; name: string }
  constructor(options: {
    redirectUrl: string
    clientMetadataUrl?: string
    state: string
    discovery: OAuthDiscoveryState
    registrations?: { secrets: SecretStore; name: string }
  }) {
    this.redirectUrl = options.redirectUrl
    this.clientMetadataUrl = options.clientMetadataUrl
    this.state = () => options.state
    this.#discovery = options.discovery
    this.#registrations = options.registrations
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Kipster Plugins',
      client_uri: 'https://github.com/manikanta-kops/kipster-plugins',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }
  }
  get client() {
    return this.#client
  }
  async clientInformation() {
    if (!this.#client && this.#registrations) {
      const stored = await this.#registrations.secrets.get(
        this.#registrations.name,
      )
      if (stored) this.#client = JSON.parse(stored)
    }
    return this.#client
  }
  async saveClientInformation(info: StoredOAuthClientInformation) {
    this.#client = info
    // Reuse DCR registrations so sign-ins do not leave clients at the service.
    if (this.#registrations)
      await this.#registrations.secrets.set(
        this.#registrations.name,
        JSON.stringify(info),
      )
  }
  tokens() {
    return this.#tokens
  }
  saveTokens(tokens: OAuthTokens) {
    this.#tokens = tokens
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url
  }
  saveCodeVerifier(verifier: string) {
    this.#verifier = verifier
  }
  codeVerifier() {
    return this.#verifier
  }
  discoveryState() {
    return this.#discovery
  }
  saveDiscoveryState(state: OAuthDiscoveryState) {
    this.#discovery = state
  }
  async invalidateCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery',
  ) {
    if (scope === 'all' || scope === 'client') {
      this.#client = undefined
      if (this.#registrations)
        await this.#registrations.secrets.delete(this.#registrations.name)
    }
    if (scope === 'all' || scope === 'tokens') this.#tokens = undefined
  }
}

const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]'])
const isLoopback = (url: URL) => loopbackHosts.has(url.hostname)
// Where the service sends the browser back: HTTPS, or HTTP on this computer.
// Whoever serves that address forwards the request's query to GET /callback.
function validReturnAddress(value: string): string {
  const url = URL.canParse(value) ? new URL(value) : undefined
  if (
    !url ||
    url.hash ||
    url.search ||
    url.username ||
    url.password ||
    !(
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && isLoopback(url))
    )
  )
    throw new SignInError(
      'invalid-return-address',
      'The return address must be an HTTPS URL, or HTTP on 127.0.0.1 or localhost, with no query or fragment',
    )
  return url.href
}

const page = (title: string, text: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><p>${text}</p>`
const escape = (value: string) =>
  value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

export class SignInManager {
  readonly #options: SignInOptions
  readonly #fetch: FetchLike
  readonly #now: () => number
  readonly #signIns = new Map<string, Entry>()
  readonly redirectUrl: string
  constructor(options: SignInOptions) {
    this.#options = options
    this.#fetch = guardedFetch({ testOnlyBaseUrl: options.testOnlyBaseUrl })
    this.#now = options.now ?? Date.now
    this.redirectUrl = returnAddress(options.port)
  }
  get #ttl() {
    return this.#options.pendingTtlMs ?? 10 * 60_000
  }
  #sweep() {
    for (const [id, entry] of this.#signIns) {
      if (entry.until > this.#now()) continue
      if (entry.pending) this.#expire(entry, entry.pending)
      else this.#signIns.delete(id)
    }
  }
  #settle(entry: Entry, status: SignInStatus) {
    entry.pending = undefined
    entry.status = status
    entry.until = this.#now() + this.#ttl
  }
  #expire(entry: Entry, pending: Pending) {
    const plugin = data(pending.plugin).id
    this.#settle(entry, { status: 'failed', plugin, code: 'expired' })
  }
  // Starts a sign-in: discovery, then DCR when offered, otherwise CIMD when
  // the client metadata URL is set. Returns the URL to open in the browser.
  async start(
    plugin: Plugin,
    options: { address?: string; returnAddress?: string } = {},
  ): Promise<StartResult> {
    this.#sweep()
    const ext = data(plugin)
    const redirectUrl =
      options.returnAddress === undefined
        ? this.redirectUrl
        : validReturnAddress(options.returnAddress)
    let serverUrl = server(plugin).url
    if (ext.needsAddress) {
      if (!options.address)
        throw new SignInError('invalid-address', 'This plugin needs an address')
      try {
        serverUrl = applyAddress(serverUrl, options.address)
      } catch (error) {
        throw new SignInError(
          'invalid-address',
          error instanceof Error ? error.message : 'Address is invalid',
        )
      }
    }
    const connectUrl = withTestOrigin(serverUrl, this.#options.testOnlyBaseUrl)
    let info
    try {
      info = await discoverOAuthServerInfo(connectUrl, { fetchFn: this.#fetch })
    } catch {
      throw new SignInError('failed', 'Sign-in discovery failed')
    }
    const metadata = info.authorizationServerMetadata
    if (!metadata?.code_challenge_methods_supported?.includes('S256'))
      throw new SignInError(
        'no-sign-in-method',
        'The service does not offer S256 PKCE sign-in',
      )
    let method: SignIn
    if (metadata.registration_endpoint) method = 'dcr'
    else if (metadata.client_id_metadata_document_supported === true) {
      if (!this.#options.settings.clientMetadataUrl)
        return { status: 'needs-client-metadata-document' }
      // The published client metadata document lists only loopback addresses.
      if (!isLoopback(new URL(redirectUrl)))
        throw new SignInError(
          'loopback-only',
          'This service accepts sign-in only on the computer running the plugin server',
        )
      method = 'cimd'
    } else
      throw new SignInError(
        'no-sign-in-method',
        'The service offers neither DCR nor CIMD',
      )
    const state = randomBytes(32).toString('base64url')
    const provider = new SessionProvider({
      redirectUrl,
      state,
      discovery: info,
      ...(method === 'cimd'
        ? { clientMetadataUrl: this.#options.settings.clientMetadataUrl }
        : {
            registrations: {
              secrets: this.#options.secrets,
              name: `client:${ext.id}:${metadata.issuer}:${redirectUrl}`,
            },
          }),
    })
    try {
      await auth(provider, { serverUrl: connectUrl, fetchFn: this.#fetch })
    } catch {
      throw new SignInError('failed', 'Sign-in could not start')
    }
    const url = provider.authorizationUrl
    if (!url) throw new SignInError('failed', 'Sign-in could not start')
    // A second account: ask for the service's account picker where advertised.
    const prompts = (metadata as { prompt_values_supported?: unknown })
      .prompt_values_supported
    if (
      Array.isArray(prompts) &&
      prompts.includes('select_account') &&
      this.#options.accounts.list(ext.id).length
    )
      url.searchParams.set(
        'prompt',
        [url.searchParams.get('prompt'), 'select_account']
          .filter(Boolean)
          .join(' '),
      )
    const id = randomUUID()
    const expiresAt = this.#now() + this.#ttl
    this.#signIns.set(id, {
      status: { status: 'pending', plugin: ext.id },
      pending: { id, plugin, state, serverUrl, connectUrl, provider },
      until: expiresAt,
    })
    return {
      status: 'redirect',
      id,
      method,
      authorizationUrl: url.href,
      serverUrl,
      expiresAt: new Date(expiresAt).toISOString(),
    }
  }
  status(id: string): SignInStatus {
    this.#sweep()
    return this.#signIns.get(id)?.status ?? { status: 'unknown' }
  }
  // Completes a sign-in from the URL the browser was sent back to.
  async complete(callbackUrl: string | URL): Promise<Completed> {
    const url = new URL(callbackUrl, this.redirectUrl)
    const state = url.searchParams.get('state')
    const entry = [...this.#signIns.values()].find(
      (candidate) => candidate.pending?.state === state,
    )
    const pending = entry?.pending
    if (!entry || !pending)
      throw new SignInError(
        'unknown-sign-in',
        'This sign-in is unknown or has expired',
      )
    if (entry.until <= this.#now()) {
      this.#expire(entry, pending)
      throw new SignInError('expired', 'This sign-in has expired')
    }
    // Single use. The status stays pending while the code is exchanged.
    this.#settle(entry, entry.status)
    try {
      const result = await this.#exchange(pending, url)
      this.#settle(entry, { status: 'completed', result })
      return result
    } catch (error) {
      const failure =
        error instanceof SignInError
          ? error
          : new SignInError('failed', 'Sign-in failed')
      const plugin = data(pending.plugin).id
      this.#settle(entry, { status: 'failed', plugin, code: failure.code })
      throw failure
    }
  }
  async #exchange(pending: Pending, url: URL): Promise<Completed> {
    const error = url.searchParams.get('error')
    if (error)
      throw error === 'access_denied'
        ? new SignInError('denied', 'Sign-in was declined at the service')
        : new SignInError('failed', 'The service reported a sign-in error')
    const code = url.searchParams.get('code')
    if (!code) throw new SignInError('failed', 'The service returned no code')
    const { provider, plugin } = pending
    await auth(provider, {
      serverUrl: pending.connectUrl,
      authorizationCode: code,
      iss: url.searchParams.get('iss') ?? undefined,
      fetchFn: this.#fetch,
    })
    const tokens = provider.tokens()
    const client = provider.client
    const discovery = provider.discoveryState()
    const metadata = discovery.authorizationServerMetadata
    if (!tokens || !client || !metadata)
      throw new SignInError('failed', 'Sign-in returned no tokens')
    const ext = data(plugin)
    const identity = await identify({
      issuer: metadata.issuer,
      clientId: client.client_id,
      accessToken: tokens.access_token,
      idToken: tokens.id_token,
      metadata: metadata as Record<string, unknown>,
      // Called automatically, so only a tool reviewed as read.
      tool:
        ext.identity && toolLabel(plugin, ext.identity.tool) === 'read'
          ? ext.identity
          : undefined,
      fetch: this.#fetch,
      connect: () =>
        connectMcp(
          { type: server(plugin).type, url: pending.connectUrl },
          { token: async () => tokens.access_token, fetch: this.#fetch },
        ),
    })
    const resource = discovery.resourceMetadata?.resource
    const { account, duplicate } = await this.#options.accounts.save({
      plugin: ext.id,
      issuer: metadata.issuer,
      // OpenID subjects and identity tool ids are separate namespaces.
      subject:
        identity.subject &&
        `${identity.source === 'tool' ? 'tool' : 'oidc'}:${identity.subject}`,
      identitySource: identity.source,
      label: identity.label,
      fallbackLabel: ext.name,
      serverUrl: pending.serverUrl,
      oauth: {
        authorizationServerUrl: discovery.authorizationServerUrl,
        metadata,
        ...(resource ? { resource } : {}),
      },
      client,
      tokens,
    })
    return { id: pending.id, plugin: ext.id, account, duplicate }
  }
  // node:http handler for GET /callback; the plugin server mounts it.
  callbackHandler() {
    return async (req: IncomingMessage, res: ServerResponse) => {
      let status = 200
      let body: string
      try {
        const { account, duplicate } = await this.complete(req.url ?? '/')
        body = page(
          'Signed in',
          `${duplicate ? 'Reconnected' : 'Signed in as'} ${escape(account.label)}. You can close this window.`,
        )
      } catch (error) {
        status = 400
        body = page(
          'Sign-in failed',
          escape(
            error instanceof SignInError ? error.message : 'Sign-in failed',
          ),
        )
      }
      res
        .writeHead(status, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
        })
        .end(body)
    }
  }
}
