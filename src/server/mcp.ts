import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  createMcpHandler,
  isLegacyRequest,
  ProtocolError,
  ProtocolErrorCode,
  Server,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/server'
import {
  NodeStreamableHTTPServerTransport,
  toNodeHandler,
  toWebRequest,
} from '@modelcontextprotocol/node'
import { accessKey, type Gateway } from './gateway.ts'
import { serverName, serverVersion } from './version.ts'

const maxBody = 4 * 1024 * 1024
// 2025-era clients keep a session for their notification stream; the oldest
// sessions are closed beyond this many.
const maxSessions = 64

const discoveryTools: Tool[] = [
  {
    name: 'plugin_list',
    description:
      'List the connected plugins and their accounts. Set include_unconnected to also list catalogue plugins without an account.',
    inputSchema: {
      type: 'object',
      properties: {
        include_unconnected: {
          type: 'boolean',
          description: 'Also list plugins that have no account yet.',
        },
      },
    },
    annotations: { readOnlyHint: true },
    _meta: { [accessKey]: 'read' },
  },
  {
    name: 'plugin_get',
    description:
      'Show one plugin: its availability, accounts, skills and tool names with read or write labels.',
    inputSchema: {
      type: 'object',
      properties: {
        plugin: {
          type: 'string',
          description: 'The plugin id, such as linear.',
        },
      },
      required: ['plugin'],
    },
    annotations: { readOnlyHint: true },
    _meta: { [accessKey]: 'read' },
  },
]
const json = (value: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  structuredContent: value as Record<string, unknown>,
})

// One low-level server instance per modern request or 2025-era session; all
// share the gateway, so every tools/list reflects the current state.
function mcpServer(gateway: Gateway): Server {
  const server = new Server(
    { name: serverName, version: serverVersion },
    { capabilities: { tools: { listChanged: true } } },
  )
  server.setRequestHandler('tools/list', async () => ({
    tools: [...discoveryTools, ...(await gateway.listTools())],
  }))
  server.setRequestHandler('tools/call', async (request) => {
    const { name, arguments: args = {} } = request.params
    if (name === 'plugin_list')
      return json({
        plugins: gateway.pluginList(args.include_unconnected === true),
      })
    if (name === 'plugin_get') {
      const plugin =
        typeof args.plugin === 'string'
          ? await gateway.pluginGet(args.plugin)
          : undefined
      return plugin
        ? json({ plugin })
        : {
            content: [
              { type: 'text', text: 'There is no plugin with that id.' },
            ],
            isError: true,
          }
    }
    const result = await gateway.callTool(name, args)
    if (!result)
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        `Unknown tool: ${name}`,
      )
    return result
  })
  return server
}

export interface McpEndpoint {
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>
  close(): Promise<void>
}
// /mcp: the 2026-07-28 revision per request (change notifications through
// subscriptions/listen), and 2025-era clients through sessions with an event
// stream, so both receive notifications/tools/list_changed.
export function mcpEndpoint(gateway: Gateway): McpEndpoint {
  const modern = createMcpHandler(() => mcpServer(gateway), {
    legacy: 'reject',
  })
  const modernNode = toNodeHandler(modern)
  const sessions = new Map<
    string,
    { server: Server; transport: NodeStreamableHTTPServerTransport }
  >()
  const onChange = () => {
    modern.notify.toolsChanged()
    for (const { server } of sessions.values())
      void server.sendToolListChanged().catch(() => {})
  }
  gateway.on('toolsChanged', onChange)
  const reply = (
    res: ServerResponse,
    status: number,
    message: string,
    code = -32000,
  ) => {
    res
      .writeHead(status, { 'Content-Type': 'application/json' })
      .end(
        JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }),
      )
  }

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    let body: unknown
    if (req.method === 'POST') {
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of req as AsyncIterable<Buffer>) {
        size += chunk.length
        if (size > maxBody) return reply(res, 413, 'Request body too large')
        chunks.push(chunk)
      }
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        return reply(res, 400, 'Parse error', -32700)
      }
    }
    if (!(await isLegacyRequest(await toWebRequest(req, body), body)))
      return modernNode(req, res, body)
    const id = req.headers['mcp-session-id']
    if (typeof id === 'string') {
      const session = sessions.get(id)
      if (!session) return reply(res, 404, 'Session not found')
      return session.transport.handleRequest(req, res, body)
    }
    const initialize =
      req.method === 'POST' &&
      typeof body === 'object' &&
      body !== null &&
      (body as { method?: unknown }).method === 'initialize'
    if (!initialize) return reply(res, 400, 'Missing session')
    const server = mcpServer(gateway)
    const transport: NodeStreamableHTTPServerTransport =
      new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (sessionId) => {
          sessions.set(sessionId, { server, transport })
          for (const [old, s] of sessions) {
            if (sessions.size <= maxSessions) break
            sessions.delete(old)
            void s.transport.close()
          }
        },
      })
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId)
    }
    await server.connect(transport)
    await transport.handleRequest(req, res, body)
  }
  return {
    handle,
    async close() {
      gateway.off('toolsChanged', onChange)
      const open = [...sessions.values()]
      sessions.clear()
      await Promise.all([
        modern.close(),
        ...open.map(({ transport }) => transport.close().catch(() => {})),
      ])
    },
  }
}
