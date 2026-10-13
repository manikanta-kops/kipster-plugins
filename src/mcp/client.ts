import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  type FetchLike,
} from '@modelcontextprotocol/client'

// An SDK client for one service MCP server, authenticated with one account's token.
export async function connectMcp(
  server: { type: 'streamable-http' | 'sse'; url: string },
  options: { token: () => Promise<string | undefined>; fetch?: FetchLike },
): Promise<Client> {
  const transportOptions = {
    authProvider: { token: options.token },
    ...(options.fetch ? { fetch: options.fetch } : {}),
  }
  const url = new URL(server.url)
  const client = new Client({ name: 'kipster-plugins', version: '0.1.0' })
  await client.connect(
    server.type === 'sse'
      ? new SSEClientTransport(url, transportOptions)
      : new StreamableHTTPClientTransport(url, transportOptions),
  )
  return client
}
