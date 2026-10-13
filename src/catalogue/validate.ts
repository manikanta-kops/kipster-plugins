import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { basename, join, relative, sep } from 'node:path'
import { Ajv } from 'ajv'
import addFormats from 'ajv-formats'
import pluginSchema from '../../schemas/plugin.schema.json' with { type: 'json' }
import mcpSchema from '../../schemas/mcp.schema.json' with { type: 'json' }
import { data, server, type Manifest, type Mcp, type Plugin } from './types.ts'

const ajv = new Ajv({ allErrors: true })
addFormats.default(ajv)
const manifestCheck = ajv.compile(pluginSchema)
const mcpCheck = ajv.compile(mcpSchema)
export function hasAddressTemplate(url: string): boolean {
  const host = url.replace(/^https:\/\//, '').split('/')[0] ?? ''
  return /your-|\{[^}]+\}|<[^>]+>/i.test(host)
}
export function secureUrl(value: string): URL {
  const url = new URL(value)
  if (
    url.protocol !== 'https:' ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new Error('URL must be HTTPS without credentials or a fragment')
  return url
}
export function validatePlugin(
  folder: string,
  manifest: unknown,
  mcp: unknown,
): Plugin {
  if (!manifestCheck(manifest))
    throw new Error(`plugin.json: ${ajv.errorsText(manifestCheck.errors)}`)
  if (!mcpCheck(mcp))
    throw new Error(`mcp.json: ${ajv.errorsText(mcpCheck.errors)}`)
  const plugin: Plugin = {
    folder,
    manifest: manifest as unknown as Manifest,
    mcp: mcp as unknown as Mcp,
  }
  const ext = data(plugin)
  if (basename(folder) !== ext.id || plugin.manifest.name !== ext.id)
    throw new Error('Folder, manifest name and Kipster id must match')
  if (Object.keys(plugin.mcp.mcpServers)[0] !== ext.id)
    throw new Error('MCP server key must equal plugin id')
  secureUrl(ext.website)
  const remote = server(plugin)
  if (
    hasAddressTemplate(remote.url) !== ext.needsAddress ||
    ext.needsAddress !== Boolean(ext.addressPrompt)
  )
    throw new Error(
      'needsAddress requires a templated host and addressPrompt; concrete URLs must have neither',
    )
  secureUrl(
    ext.needsAddress
      ? remote.url.replace(/YOUR-[^./]+|\{[^}]+\}|<[^>]+>/gi, 'example')
      : remote.url,
  )
  if (
    new URL(
      remote.url.replace(/\{[^}]+\}|<[^>]+>/g, 'example'),
    ).pathname.endsWith('/sse') !==
    (remote.type === 'sse')
  )
    throw new Error('SSE transport must match a /sse URL')
  if (ext.verification === 'probe' && ext.probe?.result !== 'ok')
    throw new Error('Probe verification requires an ok probe')
  for (const name of Object.keys(ext.tools))
    if (`${ext.id}__${name}`.length > 64)
      throw new Error('Reviewed tool name exceeds 64 characters')
  return plugin
}
async function contained(
  root: string,
  path: string,
  directory: boolean,
): Promise<void> {
  const resolved = await realpath(path)
  const rel = relative(root, resolved)
  if (rel === '..' || rel.startsWith(`..${sep}`) || !rel)
    throw new Error('Plugin paths must stay within their root')
  const info = await stat(path)
  if (directory ? !info.isDirectory() : !info.isFile())
    throw new Error(`Unexpected filesystem kind: ${basename(path)}`)
}
export async function readPlugin(folder: string): Promise<Plugin> {
  const root = await realpath(folder)
  for (const file of ['plugin.json', 'mcp.json'])
    await contained(root, join(folder, file), false)
  for (const entry of await readdir(folder))
    if (entry === 'skills' || entry === 'app.kipster')
      await contained(root, join(folder, entry), true)
  const [manifest, mcp] = await Promise.all(
    ['plugin.json', 'mcp.json'].map(
      async (file) =>
        JSON.parse(await readFile(join(folder, file), 'utf8')) as unknown,
    ),
  )
  return validatePlugin(folder, manifest, mcp)
}
export function duplicateErrors(plugins: Plugin[]): Set<string> {
  const invalid = new Set<string>()
  for (const key of [
    (p: Plugin) => data(p).id,
    (p: Plugin) => data(p).name.toLowerCase(),
  ]) {
    const groups = new Map<string, Plugin[]>()
    for (const plugin of plugins)
      groups.set(key(plugin), [...(groups.get(key(plugin)) ?? []), plugin])
    for (const group of groups.values())
      if (group.length > 1) for (const p of group) invalid.add(p.folder)
  }
  return invalid
}
export interface CatalogueRead {
  plugins: Map<string, Plugin>
  errors: Map<string, string>
  folders: string[]
}
export async function readCatalogue(directory: string): Promise<CatalogueRead> {
  const root = await realpath(directory)
  const discovered = (await readdir(directory, { withFileTypes: true }))
    .filter((e) => e.isDirectory() || e.isSymbolicLink())
    .map((e) => join(directory, e.name))
    .sort()
  const folders: string[] = []
  const plugins = new Map<string, Plugin>()
  const errors = new Map<string, string>()
  for (const folder of discovered) {
    try {
      await contained(root, folder, true)
      folders.push(folder)
      plugins.set(folder, await readPlugin(folder))
    } catch (error) {
      errors.set(
        folder,
        error instanceof Error ? error.message : 'Invalid plugin',
      )
    }
  }
  for (const folder of duplicateErrors([...plugins.values()])) {
    plugins.delete(folder)
    errors.set(folder, 'Duplicate plugin id or display name')
  }
  return { plugins, errors, folders }
}
export async function requireCatalogue(directory: string): Promise<Plugin[]> {
  const result = await readCatalogue(directory)
  if (result.errors.size)
    throw new Error(
      [...result.errors].map(([f, e]) => `${basename(f)}: ${e}`).join('\n'),
    )
  return [...result.plugins.values()]
}
