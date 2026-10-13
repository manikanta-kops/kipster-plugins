import { EventEmitter } from 'node:events'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  CallToolResult,
  Client,
  FetchLike,
  Tool,
} from '@modelcontextprotocol/client'
import {
  availability,
  data,
  server,
  toolLabel,
  type Plugin,
} from '../catalogue/types.ts'
import {
  AccountError,
  type Account,
  type AccountChange,
  type Accounts,
} from '../accounts/accounts.ts'
import { connectMcp } from '../mcp/client.ts'
import { upstreamFetch, withTestOrigin } from '../signin/fetch.ts'

export const accessKey = 'app.kipster/access'
export const accountKey = 'app.kipster/account'
export const pluginKey = 'app.kipster/plugin'
export const resolutionKey = 'app.kipster/resolution'
const toolName = /^[A-Za-z0-9_-]{1,64}$/
// Upstream failures are retried after this long; good listings stay until a change.
const failureTtlMs = 30_000

export interface SkippedTool {
  name: string
  reason: string
}
interface Listing {
  accountId: string
  tools?: Tool[]
  error?: string
}
interface Upstream {
  plugin: string
  signature: string
  client: Promise<Client>
}
export interface GatewayOptions {
  accounts: Accounts
  // Test only: force every upstream request to this HTTP 127.0.0.1 origin.
  testOnlyBaseUrl?: string
  fetch?: FetchLike
  // Time allowed to connect and list one plugin's upstream tools.
  listTimeoutMs?: number
}
// What a kip sees of one account.
export const accountSummary = (account: Account) => ({
  id: account.id,
  label: account.label,
  status: account.status,
  default: account.isDefault,
})

const signature = (plugin: Plugin) =>
  JSON.stringify([plugin.manifest, plugin.mcp])

// Serves catalogue plugins' upstream tools under <plugin>__<tool>, with the
// account argument and read/write labels, plus the discovery tools. Emits
// 'toolsChanged' when the tool set may have changed.
export class Gateway extends EventEmitter<{ toolsChanged: [] }> {
  readonly #accounts: Accounts
  readonly #fetch: FetchLike
  readonly #testOnlyBaseUrl?: string
  readonly #listTimeoutMs: number
  #plugins = new Map<string, Plugin>()
  #signatures = new Map<string, string>()
  readonly #listings = new Map<string, Promise<Listing>>()
  readonly #upstreams = new Map<string, Upstream>()
  #closed = false
  readonly #onAccountChange = ({ plugin, id, kind }: AccountChange) => {
    this.#listings.delete(plugin)
    // Other accounts' clients stay open, so their calls in flight continue.
    if (kind === 'reconnected' || kind === 'status' || kind === 'removed')
      this.#drop(id)
    // A default changes neither the tools nor their schemas.
    if (kind !== 'default') this.#changed()
  }
  constructor(options: GatewayOptions) {
    super()
    this.#accounts = options.accounts
    this.#testOnlyBaseUrl = options.testOnlyBaseUrl
    this.#fetch =
      options.fetch ??
      upstreamFetch({ testOnlyBaseUrl: options.testOnlyBaseUrl })
    this.#listTimeoutMs = options.listTimeoutMs ?? 10_000
    this.#accounts.on('change', this.#onAccountChange)
  }
  get plugins(): ReadonlyMap<string, Plugin> {
    return this.#plugins
  }
  // Applies a catalogue snapshot; only real differences invalidate and notify.
  setPlugins(plugins: ReadonlyMap<string, Plugin>): void {
    const next = new Map<string, string>()
    for (const [id, plugin] of plugins) next.set(id, signature(plugin))
    let changed = false
    for (const id of new Set([...this.#signatures.keys(), ...next.keys()]))
      if (this.#signatures.get(id) !== next.get(id)) {
        changed = true
        this.#invalidate(id)
      }
    this.#plugins = new Map(plugins)
    this.#signatures = next
    if (changed) this.#changed()
  }
  #changed() {
    if (!this.#closed) this.emit('toolsChanged')
  }
  #invalidate(plugin: string) {
    this.#listings.delete(plugin)
    for (const [id, upstream] of this.#upstreams)
      if (upstream.plugin === plugin) this.#drop(id)
  }
  #drop(accountId: string) {
    const upstream = this.#upstreams.get(accountId)
    if (!upstream) return
    this.#upstreams.delete(accountId)
    void upstream.client.then(
      (client) => client.close(),
      () => {},
    )
  }
  #available(id: string): Plugin | undefined {
    const plugin = this.#plugins.get(id)
    return plugin && availability(plugin).available ? plugin : undefined
  }
  // The listing account: the default when working, else the first working one.
  #listingAccount(plugin: string): Account | undefined {
    const working = this.#accounts
      .list(plugin)
      .filter((a) => a.status === 'working')
    return working.find((a) => a.isDefault) ?? working[0]
  }
  #client(plugin: Plugin, account: Account): Promise<Client> {
    const sig = this.#signatures.get(data(plugin).id) ?? signature(plugin)
    const existing = this.#upstreams.get(account.id)
    if (existing && existing.signature === sig) return existing.client
    if (existing) this.#drop(account.id)
    // The token each 401 was sent with, so concurrent 401s share one refresh.
    const sent = new WeakMap<Response, string>()
    const fetch: FetchLike = async (input, init) => {
      const response = await this.#fetch(input, init)
      if (response.status === 401) {
        const header = new Headers(
          init?.headers ?? (input instanceof Request ? input.headers : {}),
        ).get('authorization')
        const token = /^Bearer (\S+)$/i.exec(header ?? '')?.[1]
        if (token) sent.set(response, token)
      }
      return response
    }
    const client = connectMcp(
      {
        type: server(plugin).type,
        url: withTestOrigin(account.serverUrl, this.#testOnlyBaseUrl),
      },
      {
        fetch,
        token: () => this.#accounts.accessToken(account.id),
        onUnauthorized: async ({ response }) => {
          await this.#accounts.refresh(account.id, sent.get(response))
        },
      },
    )
    const upstream = { plugin: data(plugin).id, signature: sig, client }
    this.#upstreams.set(account.id, upstream)
    client.catch(() => {
      if (this.#upstreams.get(account.id) === upstream)
        this.#upstreams.delete(account.id)
    })
    return client
  }
  async #withTimeout<T>(work: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('The service did not answer in time')),
            this.#listTimeoutMs,
          )
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  // Upstream tools of one plugin, cached until the plugin or its accounts change.
  #listing(plugin: Plugin): Promise<Listing> | undefined {
    const id = data(plugin).id
    const account = this.#listingAccount(id)
    if (!account) return undefined
    const cached = this.#listings.get(id)
    if (cached) return cached
    const pending = (async (): Promise<Listing> => {
      try {
        const client = await this.#withTimeout(this.#client(plugin, account))
        const { tools } = await this.#withTimeout(
          client.listTools(undefined, { timeout: this.#listTimeoutMs }),
        )
        return { accountId: account.id, tools }
      } catch (error) {
        this.#drop(account.id)
        return {
          accountId: account.id,
          error:
            error instanceof AccountError && error.code === 'reconnect-needed'
              ? 'The account needs reconnecting'
              : 'The service could not list its tools',
        }
      }
    })()
    this.#listings.set(id, pending)
    void pending.then((listing) => {
      if (listing.error && this.#listings.get(id) === pending)
        setTimeout(() => {
          if (this.#listings.get(id) === pending) this.#listings.delete(id)
        }, failureTtlMs).unref()
    })
    return pending
  }
  // Exposed tools of one plugin and the upstream tools that cannot be exposed.
  #expose(
    plugin: Plugin,
    tools: Tool[],
  ): { tools: Tool[]; skipped: SkippedTool[] } {
    const id = data(plugin).id
    const accounts = this.#accounts.list(id)
    const exposed: Tool[] = []
    const skipped: SkippedTool[] = []
    for (const tool of tools) {
      const name = `${id}__${tool.name}`
      if (!toolName.test(name)) {
        skipped.push({
          name: tool.name,
          reason: 'Name is not letters, digits, _ or - within 64 characters',
        })
        continue
      }
      const selector = selectorKey(tool)
      if (!selector) {
        skipped.push({
          name: tool.name,
          reason: 'Declares both account and kipster_account arguments',
        })
        continue
      }
      const label = toolLabel(plugin, tool.name)
      const schema = structuredClone(tool.inputSchema) as Tool['inputSchema']
      if (accounts.length >= 2)
        schema.properties = {
          ...schema.properties,
          [selector]: {
            type: 'string',
            enum: accounts.map((a) => a.label),
            description: `Which ${data(plugin).name} account to use. Leave it out to use the default account.`,
          },
        }
      exposed.push({
        name,
        ...(tool.title ? { title: tool.title } : {}),
        ...(tool.description ? { description: tool.description } : {}),
        inputSchema: schema,
        ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
        // Upstream hints are untrusted; only our label counts.
        annotations: {
          ...(tool.annotations?.title ? { title: tool.annotations.title } : {}),
          readOnlyHint: label === 'read',
        },
        _meta: { [accessKey]: label, [pluginKey]: id },
      })
    }
    return { tools: exposed, skipped }
  }
  // Every proxied tool. A failing or slow plugin is left out, never fatal.
  async listTools(): Promise<Tool[]> {
    const plugins = [...this.#plugins.values()].filter(
      (p) => availability(p).available,
    )
    const results = await Promise.all(
      plugins.map(async (plugin) => {
        const listing = await this.#listing(plugin)
        return listing?.tools ? this.#expose(plugin, listing.tools).tools : []
      }),
    )
    return results.flat()
  }
  // Calls <plugin>__<tool> with the resolved account; undefined when unknown.
  async callTool(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<CallToolResult | undefined> {
    const split = name.indexOf('__')
    if (split < 1) return undefined
    const plugin = this.#available(name.slice(0, split))
    if (!plugin) return undefined
    const id = data(plugin).id
    const upstreamName = name.slice(split + 2)
    const listing = await this.#listing(plugin)
    const upstreamTool = listing?.tools?.find((t) => t.name === upstreamName)
    if (listing?.tools) {
      if (!upstreamTool) return undefined
      const exposed = this.#expose(plugin, [upstreamTool])
      if (!exposed.tools.length) return undefined
    }
    const selector = upstreamTool ? selectorKey(upstreamTool)! : 'account'
    const { [selector]: requested, ...rest } = args
    if (requested !== undefined && typeof requested !== 'string')
      return failure(`The ${selector} argument must be an account label`, {
        result: 'invalid-account',
      })
    const resolution = this.#accounts.resolve(
      id,
      requested === undefined ? {} : { requested },
    )
    if (resolution.result === 'no-account')
      return failure(
        `No ${data(plugin).name} account is connected. Ask the person to connect one.`,
        { result: 'no-account', candidates: [] },
      )
    if (resolution.result === 'unknown-account')
      return failure(
        `There is no ${data(plugin).name} account "${resolution.requested}". Use one of: ${resolution.candidates.join(', ')}.`,
        resolution,
      )
    if (resolution.result === 'ambiguous')
      return failure(
        `More than one ${data(plugin).name} account could be used. Pass ${selector} as one of: ${resolution.candidates.join(', ')}, or ask the person which one.`,
        resolution,
      )
    const { account } = resolution
    const named = { id: account.id, label: account.label }
    const reconnect = () =>
      failure(
        `The ${data(plugin).name} account ${account.label} needs reconnecting. Ask the person to sign in again.`,
        {
          result: 'reconnect-needed',
          candidates: this.#accounts.list(id).map((a) => a.label),
        },
        named,
      )
    if (account.status === 'reconnect-needed') return reconnect()
    let result: CallToolResult
    try {
      const client = await this.#client(plugin, account)
      result = (await client.callTool({
        name: upstreamName,
        arguments: rest,
      })) as CallToolResult
    } catch (error) {
      this.#drop(account.id)
      if (
        (error instanceof AccountError && error.code === 'reconnect-needed') ||
        this.#accounts.get(account.id)?.status === 'reconnect-needed'
      )
        return reconnect()
      return failure(
        `The ${data(plugin).name} service could not run ${upstreamName}.`,
        { result: 'upstream-error' },
        named,
      )
    }
    return withAccount(result, named)
  }
  // plugin_list: connected plugins with their accounts; optionally all of them.
  pluginList(includeUnconnected = false) {
    return [...this.#plugins.values()]
      .map((plugin) => {
        const ext = data(plugin)
        const accounts = this.#accounts.list(ext.id).map(accountSummary)
        return {
          id: ext.id,
          name: ext.name,
          category: ext.category,
          available: availability(plugin).available,
          connected: accounts.length > 0,
          accounts,
        }
      })
      .filter((p) => p.connected || includeUnconnected)
      .sort((a, b) => a.id.localeCompare(b.id))
  }
  // plugin_get: one plugin's state, accounts, skills and tools.
  async pluginGet(id: string) {
    const plugin = this.#plugins.get(id)
    if (!plugin) return undefined
    const ext = data(plugin)
    const available = availability(plugin)
    const accounts = this.#accounts.list(id).map(accountSummary)
    const listing = available.available
      ? await this.#listing(plugin)
      : undefined
    let tools: { name: string; access: 'read' | 'write' }[]
    let skipped: SkippedTool[] = []
    let source: 'service' | 'reviewed'
    if (listing?.tools) {
      const exposed = this.#expose(plugin, listing.tools)
      tools = exposed.tools.map((t) => ({
        name: t.name,
        access: t._meta![accessKey] as 'read' | 'write',
      }))
      skipped = exposed.skipped
      source = 'service'
    } else {
      tools = Object.entries(ext.tools).map(([name, access]) => ({
        name: `${id}__${name}`,
        access,
      }))
      source = 'reviewed'
    }
    return {
      id,
      name: ext.name,
      description: plugin.manifest.description,
      category: ext.category,
      website: ext.website,
      available: available.available,
      ...(available.reason ? { unavailableReason: available.reason } : {}),
      probe: ext.probe ?? null,
      verification: ext.verification ?? null,
      testedWithRealAccount: ext.verification === 'account',
      needsAddress: ext.needsAddress,
      accounts,
      skills: await skills(plugin.folder),
      tools,
      toolsSource: source,
      ...(listing?.error ? { toolsError: listing.error } : {}),
      skippedTools: skipped,
    }
  }
  async close(): Promise<void> {
    this.#closed = true
    this.#accounts.off('change', this.#onAccountChange)
    const clients = [...this.#upstreams.values()].map((u) => u.client)
    this.#upstreams.clear()
    this.#listings.clear()
    await Promise.all(
      clients.map((c) => c.then((client) => client.close()).catch(() => {})),
    )
  }
}

// Our account selector is `account`, or `kipster_account` when the upstream
// tool declares its own `account` argument; undefined when both are taken.
function selectorKey(tool: Tool): string | undefined {
  const properties = tool.inputSchema.properties ?? {}
  if (!Object.hasOwn(properties, 'account')) return 'account'
  if (!Object.hasOwn(properties, 'kipster_account')) return 'kipster_account'
  return undefined
}
function failure(
  text: string,
  details: Record<string, unknown>,
  account?: { id: string; label: string },
): CallToolResult {
  return withAccount(
    {
      content: [{ type: 'text', text }],
      isError: true,
      _meta: { [resolutionKey]: details },
    },
    account,
  )
}
function withAccount(
  result: CallToolResult,
  account?: { id: string; label: string },
): CallToolResult {
  if (!account) return result
  return {
    ...result,
    content: [
      ...(result.content ?? []),
      { type: 'text', text: `Account: ${account.label}` },
    ],
    _meta: { ...result._meta, [accountKey]: account },
  }
}
// Skill names: folders under skills/ that hold a SKILL.md.
async function skills(folder: string): Promise<string[]> {
  let entries: string[]
  try {
    entries = await readdir(join(folder, 'skills'))
  } catch {
    return []
  }
  const found: string[] = []
  for (const entry of entries.sort())
    try {
      if ((await stat(join(folder, 'skills', entry, 'SKILL.md'))).isFile())
        found.push(entry)
    } catch {
      // Not a skill folder.
    }
  return found
}
