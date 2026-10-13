import { parseArgs } from 'node:util'
import {
  Client,
  StreamableHTTPClientTransport,
  type Tool,
} from '@modelcontextprotocol/client'

// A small MCP client for people and test scripts:
//   npm run mcp -- --url <url> --token <t> list [--full]
//   npm run mcp -- --url <url> --token <t> call <tool> '<json arguments>'
//   npm run mcp -- --url <url> --token <t> watch [--seconds 30]
const usage =
  'Usage: npm run mcp -- --url <url> [--token <token>] [--era legacy|modern] list [--full] | call <tool> [json] | watch [--seconds n]'
const summary = (tool: Tool) => {
  const properties = tool.inputSchema.properties ?? {}
  const selector = ['kipster_account', 'account'].find(
    (key) => (properties[key] as { enum?: unknown } | undefined)?.enum,
  )
  return {
    name: tool.name,
    access: tool._meta?.['app.kipster/access'] ?? null,
    readOnlyHint: tool.annotations?.readOnlyHint ?? null,
    ...(selector
      ? {
          accountArgument: {
            name: selector,
            labels: (properties[selector] as { enum: string[] }).enum,
          },
        }
      : {}),
  }
}
const print = (value: unknown) => console.log(JSON.stringify(value, null, 2))

let client: Client | undefined
try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      url: { type: 'string' },
      token: { type: 'string' },
      era: { type: 'string' },
      full: { type: 'boolean' },
      seconds: { type: 'string' },
    },
  })
  const [command, ...rest] = positionals
  const token = values.token ?? process.env.KIPSTER_PLUGINS_TOKEN
  if (!values.url || !token || !command) throw new Error(usage)
  const url = new URL(values.url)
  if (url.pathname === '/') url.pathname = '/mcp'
  const era = values.era ?? 'legacy'
  if (era !== 'legacy' && era !== 'modern')
    throw new Error('--era must be legacy or modern')
  let changes = 0
  client = new Client(
    { name: 'kipster-plugins-cli', version: '0.1.0' },
    {
      ...(era === 'modern'
        ? { versionNegotiation: { mode: 'auto' as const } }
        : {}),
      ...(command === 'watch'
        ? {
            listChanged: {
              tools: {
                onChanged: (_error: Error | null, tools: Tool[] | null) => {
                  changes++
                  console.log(
                    JSON.stringify({
                      event: 'tools/list_changed',
                      tools: tools?.map((tool) => tool.name) ?? null,
                    }),
                  )
                },
              },
            },
          }
        : {}),
    },
  )
  await client.connect(
    new StreamableHTTPClientTransport(url, {
      authProvider: { token: async () => token },
    }),
  )
  if (command === 'list') {
    const { tools } = await client.listTools()
    print(values.full ? tools : tools.map(summary))
  } else if (command === 'call') {
    const [name, json] = rest
    if (!name) throw new Error(usage)
    const args = json ? (JSON.parse(json) as Record<string, unknown>) : {}
    print(await client.callTool({ name, arguments: args }))
  } else if (command === 'watch') {
    const seconds = Number(values.seconds ?? 30)
    if (!(seconds > 0)) throw new Error('--seconds must be positive')
    console.log(JSON.stringify({ event: 'watching', seconds }))
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, seconds * 1000)
      process.once('SIGINT', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    console.log(JSON.stringify({ event: 'done', changes }))
  } else throw new Error(usage)
} catch (error) {
  console.error(error instanceof Error ? error.message : 'MCP client failed')
  process.exitCode = 1
} finally {
  await client?.close().catch(() => {})
}
