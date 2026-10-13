import assert from 'node:assert/strict'
import { cp } from 'node:fs/promises'
import { join } from 'node:path'
import {
  Client,
  StreamableHTTPClientTransport,
  type Tool,
} from '@modelcontextprotocol/client'
import { startFixture, type FixtureOptions } from '../src/fixture/service.ts'
import { startServer } from '../src/server/server.ts'
import { fileKeyBackend } from '../src/state/home.ts'
import type { Settings } from '../src/state/settings.ts'
import { temporary } from './helpers.ts'

type T = { after: (fn: () => Promise<void> | void) => void }
export const fixtureCatalogue = new URL(
  './fixtures/catalogue/',
  import.meta.url,
)

// A fixture service and a real plugin server on free ports, with a temporary
// home (file key backend) and a copy of the fixture catalogue.
export async function serve(
  t: T,
  options: {
    fixture?: FixtureOptions
    settings?: Settings
    env?: NodeJS.ProcessEnv
    listTimeoutMs?: number
  } = {},
) {
  const fixture = await startFixture(options.fixture)
  t.after(() => fixture.close())
  const dir = await temporary(t)
  const catalogue = join(dir, 'catalogue')
  await cp(fixtureCatalogue, catalogue, { recursive: true })
  const home = join(dir, 'home')
  const logs: string[] = []
  const server = await startServer({
    port: 0,
    home,
    catalogue,
    keyBackend: fileKeyBackend(home),
    testOnlyBaseUrl: fixture.url,
    settings: options.settings ?? {},
    env: options.env ?? {},
    listTimeoutMs: options.listTimeoutMs,
    catalogueReconcileMs: 200,
    log: (line) => logs.push(line),
  })
  t.after(() => server.close())

  async function api(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: any }> {
    const response = await fetch(`${server.url}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${server.token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await response.text()
    return { status: response.status, body: text ? JSON.parse(text) : null }
  }
  // The person's browser: the fixture consent with ?user=, then /callback.
  async function consent(authorizationUrl: string, user: string) {
    const response = await fetch(`${authorizationUrl}&user=${user}`, {
      redirect: 'manual',
    })
    assert.equal(response.status, 302)
    const back = await fetch(response.headers.get('location')!)
    return { status: back.status, html: await back.text() }
  }
  async function signInAs(user: string, plugin = 'fixture') {
    const started = await api('POST', `/v1/plugins/${plugin}/sign-in`, {})
    assert.equal(started.status, 200, JSON.stringify(started.body))
    assert.equal(started.body.status, 'redirect')
    const back = await consent(started.body.authorizationUrl, user)
    assert.equal(back.status, 200, back.html)
    const done = await api('GET', `/v1/sign-ins/${started.body.id}`)
    assert.equal(done.body.status, 'completed')
    return done.body as {
      account: { id: string; label: string; isDefault: boolean }
      duplicate: boolean
    }
  }
  async function mcp(
    options: {
      era?: 'legacy' | 'modern'
      onToolsChanged?: (tools: Tool[] | null) => void
    } = {},
  ) {
    const client = new Client(
      { name: 'kipster-plugins-test', version: '1.0.0' },
      {
        ...(options.era === 'modern'
          ? { versionNegotiation: { mode: 'auto' as const } }
          : {}),
        ...(options.onToolsChanged
          ? {
              listChanged: {
                tools: {
                  onChanged: (_error: Error | null, tools: Tool[] | null) =>
                    options.onToolsChanged!(tools),
                },
              },
            }
          : {}),
      },
    )
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), {
        authProvider: { token: async () => server.token },
      }),
    )
    t.after(() => client.close())
    return client
  }
  return { fixture, server, catalogue, home, logs, api, consent, signInAs, mcp }
}
// The text of a tool result's content items.
export const texts = (result: { content?: unknown }) =>
  ((result.content ?? []) as { type: string; text?: string }[])
    .filter((c) => c.type === 'text')
    .map((c) => c.text!)
// Waits until check passes, polling.
export async function eventually(
  check: () => Promise<boolean> | boolean,
  timeoutMs = 5000,
) {
  const end = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > end) throw new Error('Condition not reached in time')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}
