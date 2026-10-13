import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Tool } from '@modelcontextprotocol/client'
import { startServer } from '../src/server/server.ts'
import { fileKeyBackend } from '../src/state/home.ts'
import { clientMetadataDocument } from '../src/state/settings.ts'
import { cimdUrl } from './signin-helpers.ts'
import { eventually, fixtureCatalogue, serve, texts } from './server-helpers.ts'
import { temporary } from './helpers.ts'

// A raw request, so the Host header can be set freely.
function raw(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method: 'GET', headers },
      (res) => {
        res.resume()
        resolve(res.statusCode!)
      },
    )
    req.on('error', reject)
    req.end()
  })
}
const access = (tool: Tool) => tool._meta?.['app.kipster/access']
const accountEnum = (tool: Tool) =>
  (tool.inputSchema.properties?.account as { enum?: string[] } | undefined)
    ?.enum
// Adds a copy of the fixture plugin under another id.
async function addPlugin(catalogue: string, id: string, name: string) {
  const source = new URL('fixture/', fixtureCatalogue)
  const manifest = JSON.parse(
    await readFile(new URL('plugin.json', source), 'utf8'),
  )
  manifest.name = id
  manifest.extensions['app.kipster'].id = id
  manifest.extensions['app.kipster'].name = name
  const mcp = {
    $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
    mcpServers: {
      [id]: { type: 'streamable-http', url: `https://${id}.kipster.test/mcp` },
    },
  }
  const folder = join(catalogue, id)
  const staging = join(catalogue, `.${id}.tmp`)
  await mkdir(staging, { recursive: true })
  await writeFile(join(staging, 'plugin.json'), JSON.stringify(manifest))
  await writeFile(join(staging, 'mcp.json'), JSON.stringify(mcp))
  await rm(folder, { recursive: true, force: true })
  await import('node:fs/promises').then((fs) => fs.rename(staging, folder))
  return folder
}
async function files(dir: string): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...(await files(path)))
    else found.push(path)
  }
  return found
}

test('health is open, everything else needs the bearer token, bad Host is refused and only 127.0.0.1 is bound', async (t) => {
  const s = await serve(t)
  assert.equal((s.server.http.address() as AddressInfo).address, '127.0.0.1')
  const health = await fetch(`${s.server.url}/health`)
  assert.equal(health.status, 200)
  assert.deepEqual(await health.json(), {
    status: 'ok',
    version: '0.1.0',
    controlApiVersions: ['v1'],
  })
  for (const path of ['/v1', '/v1/plugins', '/mcp', '/nowhere']) {
    const none = await fetch(`${s.server.url}${path}`)
    assert.equal(none.status, 401, path)
    assert.equal(
      ((await none.json()) as { error: { code: string } }).error.code,
      'unauthorized',
    )
    const wrong = await s.api('GET', path, undefined, {
      Authorization: 'Bearer wrong-token-wrong-token',
    })
    assert.equal(wrong.status, 401, path)
  }
  assert.equal((await s.api('GET', '/nowhere')).status, 404)
  const mcpPost = await fetch(`${s.server.url}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  assert.equal(mcpPost.status, 401)
  const port = s.server.port
  const auth = { Authorization: `Bearer ${s.server.token}` }
  for (const path of ['/health', '/callback', '/v1', '/mcp'])
    assert.equal(
      await raw(port, path, { Host: `evil.example:${port}`, ...auth }),
      403,
      path,
    )
  assert.equal(
    await raw(port, '/health', { Host: `127.0.0.1:${port + 1}` }),
    403,
  )
  assert.equal(await raw(port, '/health', { Host: `localhost:${port}` }), 200)
  assert.equal(
    await raw(port, '/v1', { Host: `localhost:${port}`, ...auth }),
    200,
  )
  assert.equal(
    (
      await s.api('GET', '/v1', undefined, {
        Origin: 'https://evil.example',
      })
    ).status,
    403,
  )
  const v1 = await s.api('GET', '/v1')
  assert.equal(v1.body.version, 'v1')
  assert.deepEqual(v1.body.capabilities, [
    'plugins',
    'sign-in',
    'accounts',
    'mcp',
  ])
})

test('the generated token is stored 0600 and reused; KIPSTER_PLUGINS_TOKEN replaces it', async (t) => {
  const dir = await temporary(t)
  const home = join(dir, 'home')
  const options = {
    port: 0,
    home,
    catalogue: fileURLToPathString(fixtureCatalogue),
    keyBackend: fileKeyBackend(home),
    env: {},
    settings: {},
  }
  const first = await startServer(options)
  await first.close()
  assert.match(first.token, /^[\w-]{43}$/)
  assert.equal((await stat(join(home, 'token'))).mode & 0o777, 0o600)
  const second = await startServer(options)
  await second.close()
  assert.equal(second.token, first.token)
  const given = 'kipster-verify-token-not-secret'
  const third = await startServer({
    ...options,
    env: { KIPSTER_PLUGINS_TOKEN: given },
  })
  t.after(() => third.close())
  assert.equal(third.token, given)
  const response = await fetch(`${third.url}/v1`, {
    headers: { Authorization: `Bearer ${given}` },
  })
  assert.equal(response.status, 200)
  await assert.rejects(
    startServer({ ...options, env: { KIPSTER_PLUGINS_TOKEN: 'short' } }),
    /at least 16 characters/,
  )
})
const fileURLToPathString = (url: URL) => decodeURIComponent(url.pathname)

test('sign-in through the control API with DCR, two accounts, a duplicate, a label and a default', async (t) => {
  const s = await serve(t)
  const listed = await s.api('GET', '/v1/plugins')
  assert.deepEqual(
    listed.body.plugins.map((p: { id: string }) => p.id),
    ['fixture'],
  )
  assert.equal(listed.body.plugins[0].available, true)
  assert.equal(listed.body.plugins[0].accountCount, 0)
  assert.equal(listed.body.plugins[0].needsAddress, false)
  assert.equal(listed.body.plugins[0].probe, null)
  const started = await s.api('POST', '/v1/plugins/fixture/sign-in', {})
  assert.equal(started.body.status, 'redirect')
  assert.equal(started.body.method, 'dcr')
  assert.equal(
    new URL(started.body.authorizationUrl).searchParams.get('redirect_uri'),
    `${s.server.url}/callback`,
  )
  assert.equal(
    (await s.api('GET', `/v1/sign-ins/${started.body.id}`)).body.status,
    'pending',
  )
  const back = await s.consent(started.body.authorizationUrl, 'alice')
  assert.match(back.html, /Signed in as alice@fixture.test/)
  const done = await s.api('GET', `/v1/sign-ins/${started.body.id}`)
  assert.equal(done.body.status, 'completed')
  assert.equal(done.body.duplicate, false)
  const alice = done.body.account
  assert.equal(alice.label, 'alice@fixture.test')
  const bob = (await s.signInAs('bob')).account
  const again = await s.signInAs('alice')
  assert.equal(again.duplicate, true)
  assert.equal(again.account.id, alice.id)
  assert.equal(s.fixture.stats.registrations, 1)
  const accounts = await s.api('GET', '/v1/accounts?plugin=fixture')
  assert.deepEqual(
    accounts.body.accounts.map((a: { label: string }) => a.label),
    ['alice@fixture.test', 'bob@fixture.test'],
  )
  assert.equal((await s.api('GET', '/v1/accounts')).body.accounts.length, 2)
  assert.equal(
    (await s.api('GET', '/v1/plugins/fixture')).body.plugin.accountCount,
    2,
  )
  const renamed = await s.api('PATCH', `/v1/accounts/${bob.id}`, {
    label: 'Work',
  })
  assert.equal(renamed.body.account.label, 'Work')
  const clash = await s.api('PATCH', `/v1/accounts/${alice.id}`, {
    label: 'work',
  })
  assert.equal(clash.status, 400)
  assert.equal(clash.body.error.code, 'invalid-label')
  const set = await s.api('PUT', '/v1/plugins/fixture/default-account', {
    account: bob.id,
  })
  assert.deepEqual(set.body, { plugin: 'fixture', defaultAccount: bob.id })
  assert.equal(
    (await s.api('GET', `/v1/accounts/${bob.id}`)).body.account.isDefault,
    true,
  )
  await s.api('DELETE', '/v1/plugins/fixture/default-account')
  assert.equal(
    (await s.api('GET', `/v1/accounts/${bob.id}`)).body.account.isDefault,
    false,
  )
  const errors = [
    [await s.api('GET', '/v1/plugins/nope'), 404, 'unknown-plugin'],
    [
      await s.api('POST', '/v1/plugins/nope/sign-in', {}),
      404,
      'unknown-plugin',
    ],
    [await s.api('GET', '/v1/accounts/nope'), 404, 'not-found'],
    [await s.api('GET', '/v1/sign-ins/nope'), 404, 'unknown-sign-in'],
    [await s.api('DELETE', '/v1/plugins'), 405, 'method-not-allowed'],
    [
      await s.api('PATCH', `/v1/accounts/${bob.id}`, undefined, {
        'Content-Type': 'application/json',
      }),
      400,
      'invalid-request',
    ],
  ] as const
  for (const [response, status, code] of errors) {
    assert.equal(response.status, status, code)
    assert.equal(response.body.error.code, code)
    assert.equal(typeof response.body.error.message, 'string')
  }
  // No response carries a token or client secret.
  const everything = JSON.stringify([
    await s.api('GET', '/v1/accounts'),
    await s.api('GET', '/v1/plugins/fixture'),
    done.body,
  ])
  for (const issued of s.fixture.issuedTokens())
    assert.ok(!everything.includes(issued))
  assert.ok(
    !/client_secret|fixture-cs-|fixture-at-|fixture-rt-/.test(everything),
  )
})

test('sign-in through the control API with CIMD; without the URL it needs a client metadata document', async (t) => {
  const s = await serve(t, {
    fixture: {
      dcr: false,
      clientMetadata: async (url) =>
        url === cimdUrl ? clientMetadataDocument(cimdUrl) : undefined,
    },
    settings: { clientMetadataUrl: cimdUrl },
  })
  const started = await s.api('POST', '/v1/plugins/fixture/sign-in', {})
  assert.equal(started.body.method, 'cimd')
  assert.equal(
    new URL(started.body.authorizationUrl).searchParams.get('client_id'),
    cimdUrl,
  )
  await s.consent(started.body.authorizationUrl, 'bob')
  const done = await s.api('GET', `/v1/sign-ins/${started.body.id}`)
  assert.equal(done.body.account.label, 'bob@fixture.test')
  assert.equal(s.fixture.stats.registrations, 0)
  assert.ok(s.fixture.stats.clientMetadataFetches >= 1)

  const plain = await serve(t, { fixture: { dcr: false } })
  const needs = await plain.api('POST', '/v1/plugins/fixture/sign-in', {})
  assert.equal(needs.status, 200)
  assert.deepEqual(needs.body, { status: 'needs-client-metadata-document' })
})

test('tools are labelled read or write, and the account argument appears with two accounts', async (t) => {
  const s = await serve(t)
  const client = await s.mcp()
  assert.deepEqual(
    (await client.listTools()).tools.map((tool) => tool.name),
    ['plugin_list', 'plugin_get'],
  )
  await s.signInAs('alice')
  let { tools } = await client.listTools()
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  assert.deepEqual(
    [...byName.keys()],
    ['plugin_list', 'plugin_get', 'fixture__whoami', 'fixture__create_note'],
  )
  for (const name of ['plugin_list', 'plugin_get', 'fixture__whoami']) {
    assert.equal(access(byName.get(name)!), 'read', name)
    assert.equal(byName.get(name)!.annotations?.readOnlyHint, true, name)
  }
  const note = byName.get('fixture__create_note')!
  assert.equal(access(note), 'write')
  // The fixture gives no hint here; an unreviewed tool is write regardless.
  assert.equal(note.annotations?.readOnlyHint, false)
  assert.equal(accountEnum(byName.get('fixture__whoami')!), undefined)
  for (const tool of tools) assert.match(tool.name, /^[A-Za-z0-9_-]{1,64}$/)
  await s.signInAs('bob')
  ;({ tools } = await client.listTools())
  for (const tool of tools.filter((x) => x.name.startsWith('fixture__')))
    assert.deepEqual(accountEnum(tool), [
      'alice@fixture.test',
      'bob@fixture.test',
    ])
  const note2 = tools.find((x) => x.name === 'fixture__create_note')!
  assert.deepEqual(note2.inputSchema.required, ['text'])
})

for (const era of ['legacy', 'modern'] as const)
  test(`calls resolve the account and every result names it (${era} MCP)`, async (t) => {
    const s = await serve(t)
    const alice = (await s.signInAs('alice')).account
    const client = await s.mcp({ era })
    const only = await client.callTool({ name: 'fixture__whoami' })
    assert.equal((only.structuredContent as { login: string }).login, 'alice')
    assert.deepEqual(only._meta?.['app.kipster/account'], {
      id: alice.id,
      label: 'alice@fixture.test',
    })
    assert.equal(texts(only).at(-1), 'Account: alice@fixture.test')
    const bob = (await s.signInAs('bob')).account
    const asBob = await client.callTool({
      name: 'fixture__whoami',
      arguments: { account: 'BOB@fixture.test' },
    })
    assert.equal((asBob.structuredContent as { login: string }).login, 'bob')
    assert.equal(texts(asBob).at(-1), 'Account: bob@fixture.test')
    assert.deepEqual(asBob._meta?.['app.kipster/account'], {
      id: bob.id,
      label: 'bob@fixture.test',
    })
    const ambiguous = await client.callTool({ name: 'fixture__whoami' })
    assert.equal(ambiguous.isError, true)
    assert.match(texts(ambiguous)[0]!, /alice@fixture.test, bob@fixture.test/)
    assert.deepEqual(ambiguous._meta?.['app.kipster/resolution'], {
      result: 'ambiguous',
      candidates: ['alice@fixture.test', 'bob@fixture.test'],
    })
    const unknown = await client.callTool({
      name: 'fixture__whoami',
      arguments: { account: 'carol' },
    })
    assert.equal(unknown.isError, true)
    assert.match(
      texts(unknown)[0]!,
      /"carol".*alice@fixture.test, bob@fixture.test/,
    )
    assert.deepEqual(unknown._meta?.['app.kipster/resolution'], {
      result: 'unknown-account',
      requested: 'carol',
      candidates: ['alice@fixture.test', 'bob@fixture.test'],
    })
    await s.api('PUT', '/v1/plugins/fixture/default-account', {
      account: bob.id,
    })
    const byDefault = await client.callTool({ name: 'fixture__whoami' })
    assert.equal(
      (byDefault.structuredContent as { login: string }).login,
      'bob',
    )
    const note = await client.callTool({
      name: 'fixture__create_note',
      arguments: { text: 'hello', account: 'alice@fixture.test' },
    })
    assert.equal(note.isError, undefined)
    assert.deepEqual(s.fixture.notes('alice'), ['hello'])
    assert.deepEqual(s.fixture.notes('bob'), [])
    await client.callTool({
      name: 'fixture__create_note',
      arguments: { text: 'by default' },
    })
    assert.deepEqual(s.fixture.notes('bob'), ['by default'])
    await assert.rejects(
      client.callTool({ name: 'fixture__nope' }),
      /Unknown tool/,
    )
  })

test('an upstream account argument is kept and ours becomes kipster_account; overlong names are skipped', async (t) => {
  const s = await serve(t, { fixture: { extraTools: true } })
  await s.signInAs('alice')
  await s.signInAs('bob')
  const client = await s.mcp()
  const { tools } = await client.listTools()
  assert.ok(!tools.some((tool) => tool.name.includes('xxxx')))
  const echo = tools.find((tool) => tool.name === 'fixture__echo')!
  assert.deepEqual(echo.inputSchema.properties?.account, { type: 'string' })
  assert.deepEqual(
    (echo.inputSchema.properties?.kipster_account as { enum: string[] }).enum,
    ['alice@fixture.test', 'bob@fixture.test'],
  )
  const result = await client.callTool({
    name: 'fixture__echo',
    arguments: {
      account: 'upstream-value',
      kipster_account: 'bob@fixture.test',
    },
  })
  assert.deepEqual(JSON.parse(texts(result)[0]!), {
    account: 'upstream-value',
    user: 'bob',
  })
  assert.equal(texts(result).at(-1), 'Account: bob@fixture.test')
  const got = await client.callTool({
    name: 'plugin_get',
    arguments: { plugin: 'fixture' },
  })
  const plugin = (got.structuredContent as { plugin: any }).plugin
  assert.deepEqual(plugin.skippedTools, [
    {
      name: `report_${'x'.repeat(60)}`,
      reason: 'Name is not letters, digits, _ or - within 64 characters',
    },
  ])
})

test('expired tokens refresh during calls: a 401 refreshes once for concurrent calls, and short lifetimes rotate', async (t) => {
  const s = await serve(t)
  await s.signInAs('alice')
  const client = await s.mcp()
  await client.callTool({ name: 'fixture__whoami' })
  const before = s.fixture.stats.refreshGrants
  s.fixture.expireAccessTokens()
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      client.callTool({ name: 'fixture__whoami' }),
    ),
  )
  for (const result of results) {
    assert.equal(result.isError, undefined)
    assert.equal((result.structuredContent as { login: string }).login, 'alice')
  }
  assert.equal(s.fixture.stats.refreshGrants - before, 1)

  // A lifetime below the one-minute refresh margin refreshes before each use;
  // rotated refresh tokens work once, so a lost rotation would fail here.
  const short = await serve(t, { fixture: { accessTokenTtl: 30 } })
  await short.signInAs('bob')
  const shortClient = await short.mcp()
  for (let i = 0; i < 3; i++) {
    const result = await shortClient.callTool({ name: 'fixture__whoami' })
    assert.equal((result.structuredContent as { login: string }).login, 'bob')
  }
  const concurrent = await Promise.all(
    Array.from({ length: 4 }, () =>
      shortClient.callTool({ name: 'fixture__whoami' }),
    ),
  )
  assert.ok(concurrent.every((r) => r.isError === undefined))
  assert.ok(short.fixture.stats.refreshGrants >= 3)
  const [account] = (await short.api('GET', '/v1/accounts')).body.accounts
  assert.equal(account.status, 'working')
})

test('a revoked grant turns into reconnect-needed in tool results and the control API', async (t) => {
  const s = await serve(t)
  const alice = (await s.signInAs('alice')).account
  const client = await s.mcp()
  await client.callTool({ name: 'fixture__whoami' })
  s.fixture.revokeUser('alice')
  const result = await client.callTool({ name: 'fixture__whoami' })
  assert.equal(result.isError, true)
  assert.match(texts(result)[0]!, /alice@fixture.test needs reconnecting/)
  assert.equal(
    (result._meta?.['app.kipster/resolution'] as { result: string }).result,
    'reconnect-needed',
  )
  assert.deepEqual(result._meta?.['app.kipster/account'], {
    id: alice.id,
    label: 'alice@fixture.test',
  })
  const account = await s.api('GET', `/v1/accounts/${alice.id}`)
  assert.equal(account.body.account.status, 'reconnect-needed')
  // No working account: no proxied tools until the person signs in again.
  assert.deepEqual(
    (await client.listTools()).tools.map((tool) => tool.name),
    ['plugin_list', 'plugin_get'],
  )
  const again = await s.signInAs('alice')
  assert.equal(again.duplicate, true)
  assert.equal(again.account.id, alice.id)
  const fixed = await client.callTool({ name: 'fixture__whoami' })
  assert.equal((fixed.structuredContent as { login: string }).login, 'alice')
})

test('plugin_list and plugin_get describe plugins, accounts, skills and tools', async (t) => {
  const s = await serve(t)
  await mkdir(join(s.catalogue, 'fixture', 'skills', 'take-notes'), {
    recursive: true,
  })
  await writeFile(
    join(s.catalogue, 'fixture', 'skills', 'take-notes', 'SKILL.md'),
    '---\nname: take-notes\ndescription: Test skill.\n---\n',
  )
  await mkdir(join(s.catalogue, 'fixture', 'skills', 'not-a-skill'))
  const client = await s.mcp()
  const empty = await client.callTool({ name: 'plugin_list' })
  assert.deepEqual(empty.structuredContent, { plugins: [] })
  const all = await client.callTool({
    name: 'plugin_list',
    arguments: { include_unconnected: true },
  })
  assert.deepEqual(all.structuredContent, {
    plugins: [
      {
        id: 'fixture',
        name: 'Fixture',
        category: 'testing',
        available: true,
        connected: false,
        accounts: [],
      },
    ],
  })
  const before = await client.callTool({
    name: 'plugin_get',
    arguments: { plugin: 'fixture' },
  })
  const unconnected = (before.structuredContent as { plugin: any }).plugin
  assert.equal(unconnected.toolsSource, 'reviewed')
  assert.deepEqual(unconnected.tools, [
    { name: 'fixture__whoami', access: 'read' },
  ])
  const alice = (await s.signInAs('alice')).account
  const bob = (await s.signInAs('bob')).account
  await s.api('PUT', '/v1/plugins/fixture/default-account', { account: bob.id })
  const listed = await client.callTool({ name: 'plugin_list' })
  assert.deepEqual(listed.structuredContent, {
    plugins: [
      {
        id: 'fixture',
        name: 'Fixture',
        category: 'testing',
        available: true,
        connected: true,
        accounts: [
          {
            id: alice.id,
            label: 'alice@fixture.test',
            status: 'working',
            default: false,
          },
          {
            id: bob.id,
            label: 'bob@fixture.test',
            status: 'working',
            default: true,
          },
        ],
      },
    ],
  })
  const got = await client.callTool({
    name: 'plugin_get',
    arguments: { plugin: 'fixture' },
  })
  const plugin = (got.structuredContent as { plugin: any }).plugin
  assert.equal(plugin.id, 'fixture')
  assert.equal(plugin.available, true)
  assert.equal(plugin.probe, null)
  assert.equal(plugin.verification, null)
  assert.equal(plugin.testedWithRealAccount, false)
  assert.deepEqual(plugin.skills, ['take-notes'])
  assert.equal(plugin.toolsSource, 'service')
  assert.deepEqual(plugin.tools, [
    { name: 'fixture__whoami', access: 'read' },
    { name: 'fixture__create_note', access: 'write' },
  ])
  assert.deepEqual(plugin.skippedTools, [])
  assert.equal(plugin.accounts.length, 2)
  assert.equal(JSON.parse(texts(got)[0]!).plugin.id, 'fixture')
  const missing = await client.callTool({
    name: 'plugin_get',
    arguments: { plugin: 'nope' },
  })
  assert.equal(missing.isError, true)
})

for (const era of ['legacy', 'modern'] as const)
  test(`tools/list_changed reaches connected sessions on account and catalogue changes (${era} MCP)`, async (t) => {
    const s = await serve(t)
    await s.signInAs('alice')
    let changes = 0
    let latest: Tool[] | null = null
    const client = await s.mcp({
      era,
      onToolsChanged: (tools) => {
        changes++
        latest = tools
      },
    })
    await client.listTools()
    await s.signInAs('bob')
    await eventually(() => changes >= 1)
    await eventually(() =>
      Boolean(
        latest?.some((tool) => accountEnum(tool)?.includes('bob@fixture.test')),
      ),
    )
    const seen = changes
    await addPlugin(s.catalogue, 'second', 'Second')
    await eventually(() => changes > seen)
    // Reconciliation rescans every 200 ms here; unchanged scans stay silent.
    const quiet = changes
    await new Promise((resolve) => setTimeout(resolve, 600))
    assert.equal(changes, quiet)
  })

test('live reload: an added plugin appears, a broken edit keeps the last good version, a removed one loses its tools', async (t) => {
  const s = await serve(t)
  const client = await s.mcp()
  const folder = await addPlugin(s.catalogue, 'second', 'Second')
  await eventually(async () =>
    (await s.api('GET', '/v1/plugins')).body.plugins.some(
      (p: { id: string }) => p.id === 'second',
    ),
  )
  const all = await client.callTool({
    name: 'plugin_list',
    arguments: { include_unconnected: true },
  })
  assert.deepEqual(
    (all.structuredContent as { plugins: { id: string }[] }).plugins.map(
      (p) => p.id,
    ),
    ['fixture', 'second'],
  )
  const second = (await s.signInAs('alice', 'second')).account
  await eventually(async () =>
    (await client.listTools()).tools.some((x) => x.name === 'second__whoami'),
  )
  const call = await client.callTool({ name: 'second__whoami' })
  assert.equal((call.structuredContent as { login: string }).login, 'alice')

  await writeFile(join(folder, 'plugin.json'), '{ broken')
  await new Promise((resolve) => setTimeout(resolve, 500))
  assert.equal(
    (await s.api('GET', '/v1/plugins/second')).body.plugin.name,
    'Second',
  )
  assert.ok(
    (await client.listTools()).tools.some((x) => x.name === 'second__whoami'),
  )
  // Rescans every 200 ms here; the invalid folder is reported once.
  assert.equal(s.logs.filter((line) => line.includes(folder)).length, 1)

  await rm(folder, { recursive: true })
  await eventually(
    async () => (await s.api('GET', '/v1/plugins/second')).status === 404,
  )
  assert.ok(
    !(await client.listTools()).tools.some((x) =>
      x.name.startsWith('second__'),
    ),
  )
  await assert.rejects(
    client.callTool({ name: 'second__whoami' }),
    /Unknown tool/,
  )
  // Its account stays stored for when the plugin returns.
  assert.deepEqual(
    (await s.api('GET', '/v1/accounts?plugin=second')).body.accounts.map(
      (a: { id: string }) => a.id,
    ),
    [second.id],
  )
})

test("one plugin's failing upstream leaves the others listed", async (t) => {
  const s = await serve(t)
  await addPlugin(s.catalogue, 'second', 'Second')
  await eventually(async () =>
    (await s.api('GET', '/v1/plugins')).body.plugins.some(
      (p: { id: string }) => p.id === 'second',
    ),
  )
  await s.signInAs('alice')
  await s.signInAs('alice', 'second')
  // The stored service address now answers 404, as a broken service would.
  const db = new DatabaseSync(join(s.home, 'state.db'))
  db.prepare("UPDATE accounts SET server_url = ? WHERE plugin = 'second'").run(
    'https://second.kipster.test/missing',
  )
  db.close()
  const client = await s.mcp()
  const names = (await client.listTools()).tools.map((x) => x.name)
  assert.ok(names.includes('fixture__whoami'))
  assert.ok(!names.some((name) => name.startsWith('second__')))
  const got = await client.callTool({
    name: 'plugin_get',
    arguments: { plugin: 'second' },
  })
  const plugin = (got.structuredContent as { plugin: any }).plugin
  assert.equal(plugin.toolsSource, 'reviewed')
  assert.equal(plugin.toolsError, 'The service could not list its tools')
  const failed = await client.callTool({ name: 'second__whoami' })
  assert.equal(failed.isError, true)
  assert.match(texts(failed)[0]!, /could not run whoami/)
})

test('secrets at rest: no token appears in any home file, and the token file is 0600', async (t) => {
  const s = await serve(t)
  await s.signInAs('alice')
  await s.signInAs('bob')
  const client = await s.mcp()
  await client.callTool({
    name: 'fixture__whoami',
    arguments: { account: 'bob@fixture.test' },
  })
  s.fixture.expireAccessTokens()
  await client.callTool({
    name: 'fixture__whoami',
    arguments: { account: 'alice@fixture.test' },
  })
  const issued = s.fixture.issuedTokens()
  assert.ok(issued.length >= 6)
  const paths = await files(s.home)
  assert.ok(paths.some((p) => p.endsWith('state.db')))
  for (const path of paths) {
    const content = (await readFile(path)).toString('latin1')
    for (const value of issued)
      assert.ok(!content.includes(value), `${path} holds a token`)
  }
  assert.equal((await stat(join(s.home, 'token'))).mode & 0o777, 0o600)
})

test('removing an account revokes it at the service and removes the tools of its last account', async (t) => {
  const s = await serve(t)
  const alice = (await s.signInAs('alice')).account
  const client = await s.mcp()
  assert.ok(
    (await client.listTools()).tools.some((x) => x.name === 'fixture__whoami'),
  )
  const removed = await s.api('DELETE', `/v1/accounts/${alice.id}`)
  assert.deepEqual(removed.body, { removed: true, revoked: true })
  assert.ok(s.fixture.stats.revocations >= 1)
  assert.equal((await s.api('GET', `/v1/accounts/${alice.id}`)).status, 404)
  assert.deepEqual(
    (await client.listTools()).tools.map((x) => x.name),
    ['plugin_list', 'plugin_get'],
  )
  const call = await client.callTool({ name: 'fixture__whoami' })
  assert.equal(call.isError, true)
  assert.equal(
    (call._meta?.['app.kipster/resolution'] as { result: string }).result,
    'no-account',
  )
})
