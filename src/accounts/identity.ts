import type { Client, FetchLike } from '@modelcontextprotocol/client'
import type { IdentityTool } from '../catalogue/types.ts'

export type IdentitySource = 'id-token' | 'userinfo' | 'tool' | 'none'
export interface Identity {
  source: IdentitySource
  subject?: string
  label?: string
}
export interface IdentityInput {
  issuer: string
  clientId: string
  accessToken: string
  idToken?: string
  metadata?: Record<string, unknown>
  tool?: IdentityTool
  // Opens an SDK client to the service MCP server with this account's token.
  connect: () => Promise<Client>
  fetch: FetchLike
}
type Claims = Record<string, unknown>
const text = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined
const id = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value)
    ? String(value)
    : text(value)
const claimsLabel = (claims: Claims) =>
  text(claims.email) ?? text(claims.preferred_username) ?? text(claims.name)

function fromIdToken(input: IdentityInput): Identity | undefined {
  // Received directly from the token endpoint over TLS, so the issuer and
  // audience checks suffice (OpenID Connect Core 3.1.3.7).
  try {
    const claims = JSON.parse(
      Buffer.from(input.idToken!.split('.')[1]!, 'base64url').toString(),
    ) as Claims
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    const subject = text(claims.sub)
    if (claims.iss !== input.issuer || !audience.includes(input.clientId))
      return undefined
    return subject
      ? { source: 'id-token', subject, label: claimsLabel(claims) }
      : undefined
  } catch {
    return undefined
  }
}
async function fromUserinfo(
  input: IdentityInput,
): Promise<Identity | undefined> {
  const endpoint = text(input.metadata?.userinfo_endpoint)
  if (!endpoint) return undefined
  try {
    const response = await input.fetch(endpoint, {
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        Accept: 'application/json',
      },
    })
    if (!response.ok) {
      await response.body?.cancel()
      return undefined
    }
    const claims = (await response.json()) as Claims
    const subject = text(claims?.sub)
    return subject
      ? { source: 'userinfo', subject, label: claimsLabel(claims) }
      : undefined
  } catch {
    return undefined
  }
}
function at(value: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (node, key) =>
        node && typeof node === 'object'
          ? (node as Record<string, unknown>)[key]
          : undefined,
      value,
    )
}
async function fromTool(input: IdentityInput): Promise<Identity | undefined> {
  const tool = input.tool
  if (!tool) return undefined
  let client: Client | undefined
  try {
    client = await input.connect()
    const result = await client.callTool({
      name: tool.tool,
      arguments: tool.arguments ?? {},
    })
    if (result.isError) return undefined
    let data: unknown = result.structuredContent
    if (data === undefined && Array.isArray(result.content)) {
      const first = result.content.find((c) => c.type === 'text')
      if (first && 'text' in first) data = JSON.parse(first.text)
    }
    const subject = id(at(data, tool.id))
    return subject
      ? {
          source: 'tool',
          subject,
          label: tool.label ? text(at(data, tool.label)) : undefined,
        }
      : undefined
  } catch {
    return undefined
  } finally {
    await client?.close().catch(() => {})
  }
}
// Stable account id, in order: OpenID id_token sub, the authorization server's
// userinfo endpoint, then the plugin's declared identity tool. None: unverified.
export async function identify(input: IdentityInput): Promise<Identity> {
  return (
    (input.idToken ? fromIdToken(input) : undefined) ??
    (await fromUserinfo(input)) ??
    (await fromTool(input)) ?? { source: 'none' }
  )
}
