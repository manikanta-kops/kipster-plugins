export type SignIn = 'dcr' | 'cimd'
export type ProbeResult =
  | 'ok'
  | 'sign-in-changed'
  | 'needs-address'
  | 'needs-client-metadata-document'
  | 'unreachable'
  | 'error'
export interface Probe {
  result: ProbeResult
  signIn: SignIn[]
  checkedOn: string
  reason: string
}
export interface Product {
  name: string
  rank: number
  category: string
  website: string
  accounts: 'yes' | 'personal' | 'business' | 'business-only' | 'unknown'
  cost: 'free' | 'user-paid-plan'
  signIn: string
  research: {
    verified: string
    checkedOn: string
    notes: string
    sources: string[]
  }
}
export interface KipsterData {
  id: string
  name: string
  category: string
  website: string
  signIn: SignIn[]
  needsAddress: boolean
  addressPrompt?: string
  accountTypes: ('personal' | 'business' | 'business-only' | 'unknown')[]
  cost: 'free' | 'user-paid-plan'
  products: Product[]
  verification?: 'probe' | 'account'
  probe?: Probe
  tools: Record<string, 'read' | 'write'>
}
export interface Manifest {
  $schema: string
  name: string
  description: string
  version?: string
  author?: { name?: string; email?: string; url?: string }
  homepage?: string
  repository?: string
  license?: string
  keywords?: string[]
  extensions: { 'app.kipster': KipsterData; [namespace: string]: object }
}
export interface Mcp {
  $schema: string
  mcpServers: Record<string, { type: 'streamable-http' | 'sse'; url: string }>
}
export interface Plugin {
  folder: string
  manifest: Manifest
  mcp: Mcp
}
export const data = (plugin: Plugin) =>
  plugin.manifest.extensions['app.kipster']
export const server = (plugin: Plugin) =>
  Object.values(plugin.mcp.mcpServers)[0]!
export function availability(plugin: Plugin): {
  available: boolean
  reason?: string
} {
  const probe = data(plugin).probe
  return !probe || probe.result === 'ok' || probe.result === 'needs-address'
    ? { available: true }
    : { available: false, reason: probe.reason }
}
export const toolLabel = (plugin: Plugin, name: string) =>
  Object.hasOwn(data(plugin).tools, name) ? data(plugin).tools[name]! : 'write'
