import { setTimeout as delay } from 'node:timers/promises'
import {
  data,
  server,
  type Plugin,
  type Probe,
  type SignIn,
} from '../catalogue/types.ts'
import { secureUrl } from '../catalogue/validate.ts'
import { writeJson } from '../json.ts'
import { join } from 'node:path'

export interface ProbeOptions {
  clientMetadataUrl?: string
  timeoutMs?: number
  backoffMs?: number
  // Explicit isolation escape hatch: only HTTP 127.0.0.1, never arbitrary HTTP.
  testOnlyBaseUrl?: string
}
class CheckFailure extends Error {
  readonly result: 'unreachable' | 'error'
  constructor(result: 'unreachable' | 'error', reason: string) {
    super(reason)
    this.result = result
  }
}
const userAgent =
  'kipster-plugins-probe/0.1 (+https://github.com/manikanta-kops/kipster-plugins)'
function allowedUrl(value: string, options: ProbeOptions): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new CheckFailure('error', 'Discovery returned an invalid URL')
  }
  if (url.username || url.password || url.hash)
    throw new CheckFailure(
      'error',
      'Discovery URL contains credentials or a fragment',
    )
  if (options.testOnlyBaseUrl) {
    const base = new URL(options.testOnlyBaseUrl)
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
    if (url.origin !== base.origin)
      throw new CheckFailure(
        'error',
        'Test discovery attempted to leave its loopback origin',
      )
  } else if (url.protocol !== 'https:')
    throw new CheckFailure('error', 'Discovery requires HTTPS')
  return url
}
async function request(
  url: string,
  init: RequestInit,
  json: boolean,
  options: ProbeOptions,
): Promise<{
  status: number
  header: string | null
  body?: Record<string, unknown>
}> {
  allowedUrl(url, options)
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(),
      options.timeoutMs ?? 10_000,
    )
    try {
      const response = await fetch(url, {
        ...init,
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'User-Agent': userAgent, ...init.headers },
      })
      if (response.status >= 500) {
        await response.body?.cancel()
        throw new CheckFailure(
          'unreachable',
          'Service returned HTTP 5xx after three attempts',
        )
      }
      const result: {
        status: number
        header: string | null
        body?: Record<string, unknown>
      } = {
        status: response.status,
        header: response.headers.get('www-authenticate'),
      }
      if (json && response.ok) {
        // Bound both body size and total request time; never include vendor text in reports.
        const reader = response.body?.getReader()
        const chunks: Uint8Array[] = []
        let size = 0
        if (!reader)
          throw new CheckFailure(
            'error',
            'Discovery returned an empty document',
          )
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          size += chunk.value.length
          if (size > 1_048_576) {
            await reader.cancel()
            throw new CheckFailure('error', 'Discovery document is too large')
          }
          chunks.push(chunk.value)
        }
        let body: unknown
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {
          throw new CheckFailure('error', 'Discovery returned invalid JSON')
        }
        if (!body || typeof body !== 'object' || Array.isArray(body))
          throw new CheckFailure(
            'error',
            'Discovery returned a non-object document',
          )
        result.body = body as Record<string, unknown>
      } else await response.body?.cancel()
      return result
    } catch (error) {
      if (error instanceof CheckFailure && error.result === 'error') throw error
      if (attempt === 2)
        throw error instanceof CheckFailure
          ? error
          : new CheckFailure(
              'unreachable',
              'Connection, TLS or timeout failure after three attempts',
            )
    } finally {
      clearTimeout(timer)
    }
    await delay((options.backoffMs ?? 100) * (attempt + 1))
  }
  throw new Error('Retry loop failed')
}
function wellKnown(url: URL, kind: string): string {
  return `${url.origin}/.well-known/${kind}${url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '')}`
}
async function metadata(
  urls: string[],
  options: ProbeOptions,
): Promise<Record<string, unknown>> {
  for (const url of [...new Set(urls)]) {
    const result = await request(
      url,
      { headers: { Accept: 'application/json' } },
      true,
      options,
    )
    if (result.body) return result.body
    if (result.status !== 404)
      throw new CheckFailure(
        'error',
        `Discovery returned HTTP ${result.status}`,
      )
  }
  throw new CheckFailure('error', 'No discovery metadata was found')
}
function methodsEqual(a: SignIn[], b: SignIn[]): boolean {
  return [...a].sort().join(',') === [...b].sort().join(',')
}
export async function probePlugin(
  plugin: Plugin,
  options: ProbeOptions = {},
): Promise<Probe> {
  let observed: SignIn[] = []
  const checkedOn = new Date().toISOString().slice(0, 10)
  const result = (value: Probe['result'], reason: string): Probe => ({
    result: value,
    signIn: observed,
    checkedOn,
    reason,
  })
  if (data(plugin).needsAddress)
    return result(
      'needs-address',
      'An instance or account MCP address is required when connecting',
    )
  if (options.clientMetadataUrl) secureUrl(options.clientMetadataUrl)
  let endpoint = new URL(server(plugin).url)
  if (options.testOnlyBaseUrl)
    endpoint = new URL(
      endpoint.pathname + endpoint.search,
      options.testOnlyBaseUrl,
    )
  try {
    const initial = await request(
      endpoint.href,
      server(plugin).type === 'sse'
        ? { method: 'GET', headers: { Accept: 'text/event-stream' } }
        : {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json, text/event-stream',
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'initialize',
              params: {
                protocolVersion: '2025-11-25',
                capabilities: {},
                clientInfo: { name: 'kipster-plugins-probe', version: '0.1.0' },
              },
            }),
          },
      false,
      options,
    )
    if (initial.status !== 401)
      return result(
        'error',
        `Expected HTTP 401; received HTTP ${initial.status}`,
      )
    const advertised =
      /\bresource_metadata\s*=\s*(?:"([^"]+)"|([^,\s]+))/i.exec(
        initial.header ?? '',
      )
    const resource = await metadata(
      advertised
        ? [advertised[1] ?? advertised[2]!]
        : [
            wellKnown(endpoint, 'oauth-protected-resource'),
            `${endpoint.origin}/.well-known/oauth-protected-resource`,
          ],
      options,
    )
    if (
      typeof resource.resource !== 'string' ||
      new URL(resource.resource).href !== endpoint.href
    )
      return result(
        'error',
        'Protected resource metadata does not match the MCP endpoint',
      )
    if (
      !Array.isArray(resource.authorization_servers) ||
      typeof resource.authorization_servers[0] !== 'string'
    )
      return result(
        'error',
        'Protected resource metadata has no authorization server',
      )
    // Deterministically inspect the first advertised issuer. No registration or sign-in.
    const issuer = allowedUrl(resource.authorization_servers[0], options)
    if (issuer.search)
      return result(
        'error',
        'Authorization server issuer must not contain a query',
      )
    const auth = await metadata(
      [
        wellKnown(issuer, 'oauth-authorization-server'),
        wellKnown(issuer, 'openid-configuration'),
        `${issuer.href.replace(/\/$/, '')}/.well-known/openid-configuration`,
      ],
      options,
    )
    if (
      typeof auth.issuer !== 'string' ||
      new URL(auth.issuer).href !== issuer.href
    )
      return result('error', 'Authorization metadata issuer does not match')
    if (auth.registration_endpoint !== undefined) {
      if (typeof auth.registration_endpoint !== 'string')
        return result('error', 'Registration endpoint is invalid')
      allowedUrl(auth.registration_endpoint, options)
      observed.push('dcr')
    }
    if (auth.client_id_metadata_document_supported === true)
      observed.push('cimd')
    const pkce =
      Array.isArray(auth.code_challenge_methods_supported) &&
      auth.code_challenge_methods_supported.includes('S256')
    if (!pkce)
      return result(
        'sign-in-changed',
        'Authorization server does not advertise S256 PKCE',
      )
    if (!methodsEqual(observed, data(plugin).signIn))
      return result(
        'sign-in-changed',
        'Observed sign-in methods differ from the catalogue',
      )
    if (
      observed.length === 1 &&
      observed[0] === 'cimd' &&
      !options.clientMetadataUrl
    )
      return result(
        'needs-client-metadata-document',
        'CIMD requires KIPSTER_PLUGINS_CLIENT_METADATA_URL',
      )
    return result(
      'ok',
      'HTTP 401, sign-in methods and S256 PKCE confirmed; no account tested',
    )
  } catch (error) {
    if (error instanceof CheckFailure)
      return result(error.result, error.message)
    if (error instanceof TypeError)
      return result('error', 'Discovery returned an invalid URL')
    throw error
  }
}
export async function probeCatalogue(
  plugins: Plugin[],
  options: ProbeOptions = {},
): Promise<{ id: string; probe: Probe }[]> {
  const results: { id: string; probe: Probe }[] = new Array(plugins.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(4, plugins.length) }, async () => {
      while (next < plugins.length) {
        const index = next++
        const plugin = plugins[index]!
        const probe = await probePlugin(plugin, options)
        const ext = data(plugin)
        ext.probe = probe
        if (ext.verification !== 'account') {
          if (probe.result === 'ok') ext.verification = 'probe'
          else delete ext.verification
        }
        await writeJson(join(plugin.folder, 'plugin.json'), plugin.manifest)
        results[index] = { id: ext.id, probe }
      }
    }),
  )
  return results
}
export function report(results: { id: string; probe: Probe }[]): string {
  const rows = [
    '| id | result | methods | reason |',
    '| --- | --- | --- | --- |',
    ...results.map(
      ({ id, probe }) =>
        `| ${id} | ${probe.result} | ${probe.signIn.join(', ') || '—'} | ${probe.reason} |`,
    ),
  ]
  const counts = new Map<string, number>()
  for (const { probe } of results)
    counts.set(probe.result, (counts.get(probe.result) ?? 0) + 1)
  return `${rows.join('\n')}\n\n${results.length} plugins: ${[...counts].map(([k, v]) => `${v} ${k}`).join(', ')}\n`
}
