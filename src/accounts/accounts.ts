import { randomUUID } from 'node:crypto'
import {
  OAuthError,
  refreshAuthorization,
  type AuthorizationServerMetadata,
  type FetchLike,
  type OAuthClientInformationMixed,
  type OAuthTokens,
} from '@modelcontextprotocol/client'
import type { Home } from '../state/home.ts'
import { guardedFetch } from '../signin/fetch.ts'
import type { IdentitySource } from './identity.ts'
import {
  resolveAccount,
  type ResolveInput,
  type Resolution,
} from './resolve.ts'

export type AccountStatus = 'working' | 'reconnect-needed'
export interface Account {
  id: string
  plugin: string
  label: string
  issuer: string
  identityVerified: boolean
  identitySource: IdentitySource
  status: AccountStatus
  isDefault: boolean
  serverUrl: string
  createdAt: string
  updatedAt: string
}
// Non-secret OAuth details needed to refresh and revoke without rediscovery.
export interface OAuthDetails {
  authorizationServerUrl: string
  metadata?: AuthorizationServerMetadata
  resource?: string
}
interface Credentials {
  client: OAuthClientInformationMixed
  tokens: Omit<OAuthTokens, 'expires_in' | 'id_token'> & { expiresAt?: number }
}
export class AccountError extends Error {
  readonly code:
    'not-found' | 'reconnect-needed' | 'invalid-label' | 'refresh-failed'
  constructor(code: AccountError['code'], message: string) {
    super(message)
    this.code = code
  }
}
interface Row {
  id: string
  plugin: string
  issuer: string
  identity_source: IdentitySource
  label: string
  server_url: string
  oauth: string
  status: AccountStatus
  created_at: string
  updated_at: string
  is_default: number
}
const select = `SELECT a.*, (s.default_account IS NOT NULL) AS is_default FROM accounts a
  LEFT JOIN plugin_settings s ON s.plugin = a.plugin AND s.default_account = a.id`
const toAccount = (row: Row): Account => ({
  id: row.id,
  plugin: row.plugin,
  label: row.label,
  issuer: row.issuer,
  identityVerified: row.identity_source !== 'none',
  identitySource: row.identity_source,
  status: row.status,
  isDefault: Boolean(row.is_default),
  serverUrl: row.server_url,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})
const secretName = (id: string) => `account:${id}`
// Refresh this long before the access token's stated expiry.
const skewMs = 60_000

export function checkLabel(label: string): string {
  const value = label.trim()
  if (!value || value.length > 64 || /[\p{Cc}]/u.test(value))
    throw new AccountError(
      'invalid-label',
      'Labels have 1 to 64 characters and no control characters',
    )
  return value
}

export class Accounts {
  readonly #home: Home
  readonly #fetch: FetchLike
  readonly #now: () => number
  readonly #refreshing = new Map<string, Promise<string>>()
  readonly #locks = new Map<string, Promise<unknown>>()
  constructor(
    home: Home,
    options: { fetch?: FetchLike; now?: () => number } = {},
  ) {
    this.#home = home
    this.#fetch = options.fetch ?? guardedFetch()
    this.#now = options.now ?? Date.now
  }
  #row(id: string): Row | undefined {
    return this.#home.db.prepare(`${select} WHERE a.id = ?`).get(id) as
      Row | undefined
  }
  #required(id: string): Row {
    const row = this.#row(id)
    if (!row) throw new AccountError('not-found', 'Account not found')
    return row
  }
  #stamp = () => new Date(this.#now()).toISOString()
  // Serializes token writes per account: refresh, reconnect and removal.
  #exclusive<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.#locks.get(id) ?? Promise.resolve()).then(fn, fn)
    const tail = run.catch(() => {})
    this.#locks.set(id, tail)
    void tail.then(() => {
      if (this.#locks.get(id) === tail) this.#locks.delete(id)
    })
    return run
  }
  list(plugin?: string): Account[] {
    const rows = (plugin === undefined
      ? this.#home.db
          .prepare(`${select} ORDER BY a.plugin, a.created_at, a.rowid`)
          .all()
      : this.#home.db
          .prepare(
            `${select} WHERE a.plugin = ? ORDER BY a.created_at, a.rowid`,
          )
          .all(plugin)) as unknown as Row[]
    return rows.map(toAccount)
  }
  get(id: string): Account | undefined {
    const row = this.#row(id)
    return row && toAccount(row)
  }
  #uniqueLabel(plugin: string, wanted: string, except?: string): string {
    const taken = new Set(
      this.list(plugin)
        .filter((a) => a.id !== except)
        .map((a) => a.label.toLowerCase()),
    )
    const base = checkLabel(wanted.trim().slice(0, 58) || 'Account')
    let label = base
    for (let n = 2; taken.has(label.toLowerCase()); n++) label = `${base} ${n}`
    return label
  }
  #credentials(tokens: OAuthTokens, client: OAuthClientInformationMixed) {
    const { expires_in, id_token: _idToken, ...rest } = tokens
    const credentials: Credentials = {
      client,
      tokens: {
        ...rest,
        ...(expires_in === undefined
          ? {}
          : { expiresAt: this.#now() + expires_in * 1000 }),
      },
    }
    return JSON.stringify(credentials)
  }
  // Keyed by plugin + issuer + stable subject. The same account again keeps its
  // label, gets the new tokens and is reported as a duplicate.
  async save(input: {
    plugin: string
    issuer: string
    subject?: string
    identitySource: IdentitySource
    label?: string
    fallbackLabel: string
    serverUrl: string
    oauth: OAuthDetails
    client: OAuthClientInformationMixed
    tokens: OAuthTokens
  }): Promise<{ account: Account; duplicate: boolean }> {
    const db = this.#home.db
    const credentials = this.#credentials(input.tokens, input.client)
    const existing =
      input.subject === undefined
        ? undefined
        : (db
            .prepare(
              'SELECT id FROM accounts WHERE plugin = ? AND issuer = ? AND subject = ?',
            )
            .get(input.plugin, input.issuer, input.subject) as
            { id: string } | undefined)
    if (existing)
      return this.#exclusive(existing.id, async () => {
        if (!this.#row(existing.id))
          throw new AccountError('not-found', 'Account was removed')
        await this.#home.secrets.set(secretName(existing.id), credentials)
        db.prepare(
          "UPDATE accounts SET server_url = ?, oauth = ?, status = 'working', updated_at = ? WHERE id = ?",
        ).run(
          input.serverUrl,
          JSON.stringify(input.oauth),
          this.#stamp(),
          existing.id,
        )
        return { account: this.get(existing.id)!, duplicate: true }
      })
    const id = randomUUID()
    const now = this.#stamp()
    db.prepare(
      `INSERT INTO accounts (id, plugin, issuer, subject, identity_source, label, server_url, oauth, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'working', ?, ?)`,
    ).run(
      id,
      input.plugin,
      input.issuer,
      input.subject ?? `unverified:${randomUUID()}`,
      input.subject === undefined ? 'none' : input.identitySource,
      this.#uniqueLabel(input.plugin, input.label ?? input.fallbackLabel),
      input.serverUrl,
      JSON.stringify(input.oauth),
      now,
      now,
    )
    try {
      await this.#home.secrets.set(secretName(id), credentials)
    } catch (error) {
      db.prepare('DELETE FROM accounts WHERE id = ?').run(id)
      throw error
    }
    return { account: this.get(id)!, duplicate: false }
  }
  rename(id: string, label: string): Account {
    const row = this.#required(id)
    const value = checkLabel(label)
    if (
      this.list(row.plugin).some(
        (a) => a.id !== id && a.label.toLowerCase() === value.toLowerCase(),
      )
    )
      throw new AccountError('invalid-label', 'Another account has this label')
    this.#home.db
      .prepare('UPDATE accounts SET label = ?, updated_at = ? WHERE id = ?')
      .run(value, this.#stamp(), id)
    return this.get(id)!
  }
  // Sets (or with undefined clears) the plugin's default account.
  setDefault(plugin: string, id: string | undefined): void {
    if (id !== undefined && this.#required(id).plugin !== plugin)
      throw new AccountError('not-found', 'Account not found for this plugin')
    this.#home.db
      .prepare(
        'INSERT INTO plugin_settings (plugin, default_account) VALUES (?, ?) ON CONFLICT (plugin) DO UPDATE SET default_account = excluded.default_account',
      )
      .run(plugin, id ?? null)
  }
  resolve(
    plugin: string,
    input: Omit<ResolveInput<Account>, 'accounts' | 'defaultId'> = {},
  ): Resolution<Account> {
    const accounts = this.list(plugin)
    return resolveAccount({
      ...input,
      accounts,
      defaultId: accounts.find((a) => a.isDefault)?.id,
    })
  }
  async #read(id: string): Promise<Credentials> {
    const value = await this.#home.secrets.get(secretName(id))
    if (!value) {
      this.#mark(id, 'reconnect-needed')
      throw new AccountError('reconnect-needed', 'Account has no stored tokens')
    }
    return JSON.parse(value) as Credentials
  }
  #mark(id: string, status: AccountStatus) {
    this.#home.db
      .prepare('UPDATE accounts SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, this.#stamp(), id)
  }
  // A usable access token, refreshed first when it has expired.
  async accessToken(id: string): Promise<string> {
    const row = this.#required(id)
    if (row.status === 'reconnect-needed')
      throw new AccountError('reconnect-needed', 'Account needs reconnecting')
    const { tokens } = await this.#read(id)
    if (
      tokens.expiresAt === undefined ||
      this.#now() < tokens.expiresAt - skewMs
    )
      return tokens.access_token
    return this.refresh(id, tokens.access_token)
  }
  // Refreshes under a per-account lock: concurrent callers share one request.
  // With stale, a token another caller already replaced is returned instead.
  refresh(id: string, stale?: string): Promise<string> {
    let pending = this.#refreshing.get(id)
    if (!pending) {
      pending = this.#exclusive(id, () => this.#refresh(id, stale)).finally(
        () => this.#refreshing.delete(id),
      )
      this.#refreshing.set(id, pending)
    }
    return pending
  }
  async #refresh(id: string, stale?: string): Promise<string> {
    const row = this.#required(id)
    const credentials = await this.#home.secrets
      .get(secretName(id))
      .then((value) => (value ? (JSON.parse(value) as Credentials) : undefined))
    // Another caller or a reconnect already replaced the stale token.
    if (
      credentials &&
      stale !== undefined &&
      credentials.tokens.access_token !== stale
    )
      return credentials.tokens.access_token
    if (!credentials?.tokens.refresh_token) {
      this.#mark(id, 'reconnect-needed')
      throw new AccountError('reconnect-needed', 'Account needs reconnecting')
    }
    const oauth = JSON.parse(row.oauth) as OAuthDetails
    let tokens: OAuthTokens
    try {
      tokens = await refreshAuthorization(oauth.authorizationServerUrl, {
        metadata: oauth.metadata,
        clientInformation: credentials.client,
        refreshToken: credentials.tokens.refresh_token,
        resource: oauth.resource,
        fetchFn: this.#fetch,
      })
    } catch (error) {
      // Revoked grant, or a client registration the service no longer knows.
      if (
        error instanceof OAuthError &&
        ['invalid_grant', 'invalid_client', 'unauthorized_client'].includes(
          error.code,
        )
      ) {
        this.#mark(id, 'reconnect-needed')
        throw new AccountError('reconnect-needed', 'Account needs reconnecting')
      }
      throw new AccountError('refresh-failed', 'Token refresh failed')
    }
    await this.#home.secrets.set(
      secretName(id),
      this.#credentials(tokens, credentials.client),
    )
    this.#mark(id, 'working')
    return tokens.access_token
  }
  // Revokes at the service where supported (best effort), then deletes the
  // account and its secrets.
  async remove(id: string): Promise<{ revoked: boolean }> {
    this.#required(id)
    return this.#exclusive(id, () => this.#remove(id))
  }
  async #remove(id: string): Promise<{ revoked: boolean }> {
    const row = this.#required(id)
    const oauth = JSON.parse(row.oauth) as OAuthDetails
    let revoked = false
    const endpoint = (
      oauth.metadata as { revocation_endpoint?: unknown } | undefined
    )?.revocation_endpoint
    const credentials = await this.#read(id).catch(() => undefined)
    if (typeof endpoint === 'string' && credentials) {
      const { client, tokens } = credentials
      for (const [value, hint] of [
        [tokens.refresh_token, 'refresh_token'],
        [tokens.access_token, 'access_token'],
      ] as const) {
        if (!value) continue
        try {
          const form = new URLSearchParams({
            token: value,
            token_type_hint: hint,
            client_id: client.client_id,
            ...(client.client_secret
              ? { client_secret: client.client_secret }
              : {}),
          })
          const response = await this.#fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: form.toString(),
          })
          await response.body?.cancel()
          revoked ||= response.ok
        } catch {
          // Removal must still succeed when the service is unreachable.
        }
      }
    }
    await this.#home.secrets.delete(secretName(id))
    this.#home.db.prepare('DELETE FROM accounts WHERE id = ?').run(id)
    return { revoked }
  }
}
