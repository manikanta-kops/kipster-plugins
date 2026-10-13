import { readFile, mkdir, access } from 'node:fs/promises'
import { join } from 'node:path'
import { parse } from 'csv-parse/sync'
import {
  hasAddressTemplate,
  readPlugin,
  validatePlugin,
  requireCatalogue,
} from '../catalogue/validate.ts'
import type {
  KipsterData,
  Manifest,
  Mcp,
  Product,
  SignIn,
} from '../catalogue/types.ts'
import { writeJson } from '../json.ts'

export interface Row {
  rank: string
  name: string
  category: string
  website: string
  mcp_url: string
  sign_in: string
  accounts: Product['accounts']
  cost: Product['cost']
  verified: string
  checked_on: string
  notes: string
  sources: string
}
export async function readResearch(
  path = 'docs/research/class-a-services.csv',
): Promise<Row[]> {
  return parse(await readFile(path, 'utf8'), {
    columns: true,
    skip_empty_lines: true,
  }) as Row[]
}
export function recordedMethods(row: Row): SignIn[] {
  const notes = row.notes
  // Prefer discovery observations, including wording in the instance-service notes.
  const dcr = /DCR\s+(yes|no|not advertised)/i.exec(notes)
  const cimd = /CIMD\s+(yes|no|not advertised)/i.exec(notes)
  if (dcr || cimd) {
    const observed: SignIn[] = []
    if (dcr?.[1]?.toLowerCase() === 'yes') observed.push('dcr')
    if (cimd?.[1]?.toLowerCase() === 'yes') observed.push('cimd')
    if (observed.length) return observed
  }
  if (row.sign_in === 'oauth-dcr') return ['dcr']
  if (row.sign_in === 'oauth-cimd') return ['cimd']
  throw new Error(`Unknown sign-in method for ${row.name}`)
}
function identity(rows: Row[]): { id: string; name: string } {
  const url = rows[0]!.mcp_url
  if (url === 'https://mcp.atlassian.com/v2/mcp')
    return { id: 'atlassian', name: 'Atlassian' }
  if (url === 'https://adobe-creativity.adobe.io/mcp')
    return { id: 'adobe-creative', name: 'Adobe Creative' }
  const name = rows[0]!.name
  const id = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32)
    .replace(/-$/, '')
  return { id, name }
}
export function documents(rows: Row[]): { manifest: Manifest; mcp: Mcp } {
  const first = rows[0]!
  const { id, name } = identity(rows)
  const needsAddress = hasAddressTemplate(first.mcp_url)
  const accountTypes = [
    ...new Set(
      rows.flatMap((r) =>
        r.accounts === 'yes'
          ? (['personal', 'business'] as const)
          : [r.accounts],
      ),
    ),
  ]
  const ext: KipsterData = {
    id,
    name,
    category: first.category,
    website: first.website,
    signIn: [...new Set(rows.flatMap(recordedMethods))].sort() as SignIn[],
    needsAddress,
    ...(needsAddress
      ? {
          addressPrompt: `What is your ${name} instance or account MCP address?`,
        }
      : {}),
    accountTypes,
    cost: rows.some((r) => r.cost === 'user-paid-plan')
      ? 'user-paid-plan'
      : 'free',
    products: rows.map((r) => ({
      name: r.name,
      rank: Number(r.rank),
      category: r.category,
      website: r.website,
      accounts: r.accounts,
      cost: r.cost,
      signIn: r.sign_in,
      research: {
        verified: r.verified,
        checkedOn: r.checked_on,
        notes: r.notes,
        sources: r.sources.split(/\s+/).filter(Boolean),
      },
    })),
    tools: {},
  }
  const manifest: Manifest = {
    $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
    name: id,
    version: '0.1.0',
    description: `Connect to ${rows.map((r) => r.name).join(', ')} through its official MCP server.`,
    homepage: first.website,
    license: 'Apache-2.0',
    extensions: { 'app.kipster': ext },
  }
  const mcp: Mcp = {
    $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
    mcpServers: {
      [id]: {
        type: first.mcp_url.endsWith('/sse') ? 'sse' : 'streamable-http',
        url: first.mcp_url,
      },
    },
  }
  return { manifest, mcp }
}
function distance(a: string, b: string): number {
  let prior = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const next = [i]
    for (let j = 1; j <= b.length; j++)
      next.push(
        Math.min(
          next[j - 1]! + 1,
          prior[j]! + 1,
          prior[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
        ),
      )
    prior = next
  }
  return prior[b.length]!
}
export async function importPlugins(
  names: string[],
  options: {
    output?: string
    csv?: string
    all?: boolean
    force?: boolean
  } = {},
): Promise<string[]> {
  const rows = await readResearch(options.csv)
  const selected = options.all
    ? rows
    : names.map((name) => {
        const row = rows.find(
          (r) => r.name.toLowerCase() === name.toLowerCase(),
        )
        if (!row) {
          const near = [...rows]
            .sort(
              (a, b) =>
                distance(name.toLowerCase(), a.name.toLowerCase()) -
                distance(name.toLowerCase(), b.name.toLowerCase()),
            )
            .slice(0, 3)
            .map((r) => r.name)
          throw new Error(
            `Unknown service "${name}". Near matches: ${near.join(', ')}`,
          )
        }
        return row
      })
  const output = options.output ?? 'plugins'
  await mkdir(output, { recursive: true })
  const groups = [...new Set(selected.map((r) => r.mcp_url))].map((url) =>
    rows.filter((r) => r.mcp_url === url),
  )
  const generated = groups.map((group) => {
    const docs = documents(group)
    return validatePlugin(
      join(output, docs.manifest.name),
      docs.manifest,
      docs.mcp,
    )
  })
  // Validate the entire resulting catalogue before making changes.
  const existing = await requireCatalogue(output)
  const candidates = new Map(existing.map((p) => [p.manifest.name, p]))
  const messages: string[] = []
  const pending = []
  for (const plugin of generated) {
    let exists = false
    try {
      await access(plugin.folder)
      exists = true
    } catch {}
    if (exists && !options.force) {
      await readPlugin(plugin.folder)
      messages.push(
        `${plugin.manifest.name}: already exists; kept unchanged (use --force to replace)`,
      )
    } else {
      pending.push(plugin)
      candidates.set(plugin.manifest.name, plugin)
    }
  }
  const namesSeen = new Set<string>()
  for (const p of candidates.values()) {
    const name = p.manifest.extensions['app.kipster'].name.toLowerCase()
    if (namesSeen.has(name)) throw new Error(`Duplicate plugin name: ${name}`)
    namesSeen.add(name)
  }
  for (const plugin of pending) {
    await mkdir(plugin.folder, { recursive: true })
    await writeJson(join(plugin.folder, 'plugin.json'), plugin.manifest)
    await writeJson(join(plugin.folder, 'mcp.json'), plugin.mcp)
    messages.push(`${plugin.manifest.name}: imported`)
  }
  return messages
}
