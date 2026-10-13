import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { data, server } from '../src/catalogue/types.ts'
import { validatePlugin } from '../src/catalogue/validate.ts'
import { SignInError, SignInManager } from '../src/signin/signin.ts'
import { applyAddress } from '../src/signin/address.ts'
import { guardedFetch } from '../src/signin/fetch.ts'
import { connectMcp } from '../src/mcp/client.ts'
import { clientMetadataDocument } from '../src/state/settings.ts'
import { cimdUrl, setup } from './signin-helpers.ts'

test('sign-in through DCR uses PKCE S256, a 127.0.0.1 return address and one registration', async (t) => {
  const s = await setup(t)
  const started = await s.signIn.start(s.plugin)
  assert.equal(started.status, 'redirect')
  if (started.status !== 'redirect') return
  assert.equal(started.method, 'dcr')
  assert.equal(started.serverUrl, 'https://mcp.linear.app/mcp')
  assert.deepEqual(s.signIn.status(started.id), {
    status: 'pending',
    plugin: 'linear',
  })
  const query = new URL(started.authorizationUrl).searchParams
  assert.equal(query.get('code_challenge_method'), 'S256')
  assert.match(query.get('code_challenge')!, /^[\w-]{43}$/)
  assert.equal(query.get('redirect_uri'), 'http://127.0.0.1:45871/callback')
  assert.equal(query.get('prompt'), null)
  const done = await s.signIn.complete(
    await s.authorize(started.authorizationUrl, 'alice'),
  )
  assert.equal(done.duplicate, false)
  assert.equal(done.account.label, 'alice@fixture.test')
  assert.equal(done.account.identitySource, 'userinfo')
  assert.equal(done.account.status, 'working')
  assert.equal(done.account.issuer, s.fixture.url)
  assert.deepEqual(s.signIn.status(started.id), {
    status: 'completed',
    result: done,
  })
  await s.signInAs('bob')
  assert.equal(s.fixture.stats.registrations, 1)
  assert.equal(s.fixture.stats.clientMetadataFetches, 0)
  assert.equal(s.fixture.stats.authorizationCodeGrants, 2)
})

test('sign-in through CIMD with DCR switched off at the fixture', async (t) => {
  const s = await setup(t, {
    fixture: {
      dcr: false,
      clientMetadata: async (url) =>
        url === cimdUrl ? clientMetadataDocument(cimdUrl) : undefined,
    },
    settings: { clientMetadataUrl: cimdUrl },
  })
  const started = await s.signIn.start(s.plugin)
  assert.equal(started.status, 'redirect')
  if (started.status !== 'redirect') return
  assert.equal(started.method, 'cimd')
  const query = new URL(started.authorizationUrl).searchParams
  assert.equal(query.get('client_id'), cimdUrl)
  assert.equal(query.get('code_challenge_method'), 'S256')
  assert.equal(query.get('redirect_uri'), 'http://127.0.0.1:45871/callback')
  const done = await s.signIn.complete(
    await s.authorize(started.authorizationUrl, 'alice'),
  )
  assert.equal(done.account.label, 'alice@fixture.test')
  assert.equal(s.fixture.stats.registrations, 0)
  assert.ok(s.fixture.stats.clientMetadataFetches >= 1)
})

test('CIMD-only service without a client metadata URL needs a client metadata document', async (t) => {
  const s = await setup(t, { fixture: { dcr: false } })
  assert.deepEqual(await s.signIn.start(s.plugin), {
    status: 'needs-client-metadata-document',
  })
  assert.equal(s.fixture.stats.authorizeRequests.length, 0)
})

test('DCR is preferred when the service offers both and a metadata URL is set', async (t) => {
  const s = await setup(t, { settings: { clientMetadataUrl: cimdUrl } })
  const started = await s.signIn.start(s.plugin)
  assert.equal(started.status === 'redirect' && started.method, 'dcr')
})

test('two accounts in one plugin; alice again is a duplicate with refreshed tokens and kept label', async (t) => {
  const s = await setup(t)
  const alice = await s.signInAs('alice')
  const bob = await s.signInAs('bob')
  assert.equal(bob.duplicate, false)
  assert.equal(bob.account.label, 'bob@fixture.test')
  const before = await s.accounts.accessToken(alice.account.id)
  s.accounts.rename(alice.account.id, 'Work')
  // The second sign-in asks the service for its account picker.
  const again = await s.signIn.start(s.plugin)
  assert.equal(
    again.status === 'redirect' &&
      new URL(again.authorizationUrl).searchParams.get('prompt'),
    'select_account',
  )
  if (again.status !== 'redirect') return
  const repeat = await s.signIn.complete(
    await s.authorize(again.authorizationUrl, 'alice'),
  )
  assert.equal(repeat.duplicate, true)
  assert.equal(repeat.account.id, alice.account.id)
  assert.equal(repeat.account.label, 'Work')
  assert.equal(s.accounts.list('linear').length, 2)
  assert.notEqual(await s.accounts.accessToken(alice.account.id), before)
})

test('labels default to the login or email, can be renamed, and one default is set', async (t) => {
  const s = await setup(t)
  const alice = (await s.signInAs('alice')).account
  const bob = (await s.signInAs('bob')).account
  assert.equal(s.accounts.rename(alice.id, '  Work ').label, 'Work')
  for (const bad of ['work', '', ' ', 'x'.repeat(65), 'a\nb'])
    assert.throws(() => s.accounts.rename(bob.id, bad), {
      code: 'invalid-label',
    })
  assert.equal(s.accounts.rename(bob.id, 'Personal').label, 'Personal')
  assert.deepEqual(s.accounts.resolve('linear'), {
    result: 'ambiguous',
    candidates: ['Work', 'Personal'],
  })
  s.accounts.setDefault('linear', bob.id)
  assert.equal(s.accounts.get(bob.id)!.isDefault, true)
  assert.equal(s.accounts.get(alice.id)!.isDefault, false)
  const resolved = s.accounts.resolve('linear')
  assert.equal(resolved.result === 'account' && resolved.reason, 'default')
  assert.equal(resolved.result === 'account' && resolved.account.id, bob.id)
  const requested = s.accounts.resolve('linear', { requested: 'work' })
  assert.equal(requested.result === 'account' && requested.account.id, alice.id)
  assert.throws(() => s.accounts.setDefault('notion', bob.id), {
    code: 'not-found',
  })
  s.accounts.setDefault('linear', undefined)
  assert.equal(s.accounts.resolve('linear').result, 'ambiguous')
})

test('fixture read and write tools are listed and called with an account token through the SDK client', async (t) => {
  const s = await setup(t)
  const alice = (await s.signInAs('alice')).account
  const bob = (await s.signInAs('bob')).account
  for (const [account, login] of [
    [alice, 'alice'],
    [bob, 'bob'],
  ] as const) {
    const client = await connectMcp(
      { type: 'streamable-http', url: s.fixture.mcpUrl },
      { token: () => s.accounts.accessToken(account.id) },
    )
    t.after(() => client.close())
    const { tools } = await client.listTools()
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [
      'create_note',
      'whoami',
    ])
    const who = await client.callTool({ name: 'whoami', arguments: {} })
    assert.equal((who.structuredContent as { login: string }).login, login)
    const note = await client.callTool({
      name: 'create_note',
      arguments: { text: `hello from ${login}` },
    })
    assert.equal(note.isError, undefined)
    assert.deepEqual(s.fixture.notes(login), [`hello from ${login}`])
  }
})

test('identity comes from the identity tool when no userinfo endpoint exists', async (t) => {
  const s = await setup(t, { fixture: { identity: 'tool' } })
  data(s.plugin).identity = { tool: 'whoami', id: 'id', label: 'login' }
  // Unreviewed, the tool counts as write and is never called automatically.
  assert.throws(
    () => validatePlugin(s.plugin.folder, s.plugin.manifest, s.plugin.mcp),
    /reviewed as read/,
  )
  assert.equal((await s.signInAs('alice')).account.identityVerified, false)
  await s.accounts.remove(s.accounts.list()[0]!.id)
  data(s.plugin).tools.whoami = 'read'
  validatePlugin(s.plugin.folder, s.plugin.manifest, s.plugin.mcp)
  const first = await s.signInAs('alice')
  assert.equal(first.account.identitySource, 'tool')
  assert.equal(first.account.label, 'alice')
  assert.equal((await s.signInAs('alice')).duplicate, true)
  assert.equal((await s.signInAs('bob')).account.label, 'bob')
  assert.equal(s.accounts.list('linear').length, 2)
})

test('identity comes from an OpenID id_token sub when present', async (t) => {
  const s = await setup(t, { fixture: { identity: 'id-token' } })
  const first = await s.signInAs('alice')
  assert.equal(first.account.identitySource, 'id-token')
  assert.equal(first.account.label, 'alice@fixture.test')
  assert.equal((await s.signInAs('alice')).duplicate, true)
})

test('without any identity source accounts are kept as new and unverified', async (t) => {
  const s = await setup(t, { fixture: { identity: 'none' } })
  const first = await s.signInAs('alice')
  const second = await s.signInAs('alice')
  assert.equal(first.account.identityVerified, false)
  assert.equal(second.duplicate, false)
  assert.deepEqual(
    s.accounts.list('linear').map((a) => a.label),
    ['Linear', 'Linear 2'],
  )
})

test('identity schema field is optional and validated', async (t) => {
  const s = await setup(t)
  data(s.plugin).identity = { tool: 'who am i', id: 'id' }
  assert.throws(() =>
    validatePlugin(s.plugin.folder, s.plugin.manifest, s.plugin.mcp),
  )
  data(s.plugin).identity = { tool: 'whoami' } as never
  assert.throws(() =>
    validatePlugin(s.plugin.folder, s.plugin.manifest, s.plugin.mcp),
  )
})

test('secrets are encrypted at rest in the home folder', async (t) => {
  const s = await setup(t)
  const alice = (await s.signInAs('alice')).account
  await s.signInAs('bob')
  s.clock.now += 2 * 3600_000
  await s.accounts.accessToken(alice.id)
  const issued = s.fixture.issuedTokens()
  assert.equal(issued.length, 6)
  const files = (await readdir(s.dir, { recursive: true })).map((f) =>
    join(s.dir, f),
  )
  assert.ok(files.some((f) => f.endsWith('state.db')))
  const contents = Buffer.concat(
    await Promise.all(files.map((f) => readFile(f).catch(() => Buffer.of()))),
  )
  for (const value of issued)
    assert.equal(contents.includes(value), false, 'token stored in plain text')
  const rows = s.home.db
    .prepare("SELECT count(*) AS n FROM secrets WHERE name LIKE 'account:%'")
    .get() as { n: number }
  assert.equal(rows.n, 2)
})

test('the callback handler completes a sign-in visited by the browser', async (t) => {
  let handler: ReturnType<SignInManager['callbackHandler']> | undefined
  const http = createServer((req, res) => void handler!(req, res))
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>((resolve) => http.close(() => resolve())))
  const port = (http.address() as AddressInfo).port
  const s = await setup(t, { port })
  handler = s.signIn.callbackHandler()
  const started = await s.signIn.start(s.plugin)
  if (started.status !== 'redirect') throw new Error('expected redirect')
  const page = await fetch(`${started.authorizationUrl}&user=bob`)
  assert.equal(page.status, 200)
  assert.match(await page.text(), /Signed in as bob@fixture\.test/)
  assert.equal(s.accounts.list('linear')[0]!.label, 'bob@fixture.test')
  const replay = await fetch(page.url)
  assert.equal(replay.status, 400)
  assert.match(await replay.text(), /unknown or has expired/)
})

test('pending sign-ins expire, are single use and report declined consent', async (t) => {
  const s = await setup(t)
  const started = await s.signIn.start(s.plugin)
  if (started.status !== 'redirect') throw new Error('expected redirect')
  const callback = await s.authorize(started.authorizationUrl, 'alice')
  s.clock.now += 11 * 60_000
  await assert.rejects(s.signIn.complete(callback), { code: 'expired' })
  assert.deepEqual(s.signIn.status(started.id), {
    status: 'failed',
    plugin: 'linear',
    code: 'expired',
  })
  // Unvisited pending sign-ins expire too.
  const idle = await s.signIn.start(s.plugin)
  if (idle.status !== 'redirect') throw new Error('expected redirect')
  s.clock.now += 11 * 60_000
  assert.equal(s.signIn.status(idle.id).status, 'failed')
  const declined = await s.signIn.start(s.plugin)
  if (declined.status !== 'redirect') throw new Error('expected redirect')
  const denied = await s.authorize(declined.authorizationUrl, 'deny')
  await assert.rejects(s.signIn.complete(denied), { code: 'denied' })
  await assert.rejects(s.signIn.complete(denied), { code: 'unknown-sign-in' })
  const forged = new URL(callback)
  forged.searchParams.set('state', 'forged')
  await assert.rejects(s.signIn.complete(forged), { code: 'unknown-sign-in' })
  assert.equal(s.accounts.list().length, 0)
})

test('plugins with needsAddress take a validated address when sign-in starts', async (t) => {
  const s = await setup(t)
  const ext = data(s.plugin)
  ext.needsAddress = true
  ext.addressPrompt = 'What is your instance address?'
  server(s.plugin).url = 'https://YOUR-INSTANCE-HOST/mcp'
  validatePlugin(s.plugin.folder, s.plugin.manifest, s.plugin.mcp)
  await assert.rejects(s.signIn.start(s.plugin), { code: 'invalid-address' })
  for (const address of [
    'http://ha.example.com',
    'https://user:secret@ha.example.com',
    'ha.example.com/evil',
    'evil@ha.example.com',
  ])
    await assert.rejects(
      s.signIn.start(s.plugin, { address }),
      (error: SignInError) =>
        error.code === 'invalid-address' && !error.message.includes('secret'),
    )
  const started = await s.signIn.start(s.plugin, {
    address: 'ha.example.com:8123',
  })
  if (started.status !== 'redirect') throw new Error('expected redirect')
  assert.equal(started.serverUrl, 'https://ha.example.com:8123/mcp')
  const done = await s.signIn.complete(
    await s.authorize(started.authorizationUrl, 'alice'),
  )
  assert.equal(done.account.serverUrl, 'https://ha.example.com:8123/mcp')
})

test('address templates substitute a value or a full HTTPS URL host', () => {
  assert.equal(
    applyAddress('https://{domain}.aha.io/api/v1/mcp', 'acme'),
    'https://acme.aha.io/api/v1/mcp',
  )
  assert.equal(
    applyAddress('https://{domain}.aha.io/api/v1/mcp', 'https://acme.aha.io/'),
    'https://acme.aha.io/api/v1/mcp',
  )
  assert.equal(
    applyAddress(
      'https://<account>.activehosted.com/api/agents/mcp/http',
      'shop',
    ),
    'https://shop.activehosted.com/api/agents/mcp/http',
  )
  assert.equal(
    applyAddress(
      'https://your-mattermost-server/plugins/mattermost-ai/mcp-server/mcp',
      'https://chat.example.org',
    ),
    'https://chat.example.org/plugins/mattermost-ai/mcp-server/mcp',
  )
  assert.equal(
    applyAddress('https://YOUR-HOST:8443/mcp', 'ha.example.com'),
    'https://ha.example.com:8443/mcp',
  )
  assert.equal(
    applyAddress('https://Your-Host/api/mcp', 'https://ha.example.com/api/mcp'),
    'https://ha.example.com/api/mcp',
  )
  for (const bad of [
    'acme.evil.com',
    'a/b',
    '-x',
    'ftp://acme.aha.io',
    '',
    'https://acme.aha.io/other',
    'https://acme.aha.io/?x=1',
  ])
    assert.throws(() => applyAddress('https://{domain}.aha.io/mcp', bad))
  assert.throws(() => applyAddress('https://YOUR-HOST:8443/mcp', 'h:9000'))
  assert.throws(() => applyAddress('https://mcp.linear.app/mcp', 'x'))
})

test('sign-in requests stay on HTTPS, or on the explicit test-only loopback origin', async () => {
  await assert.rejects(
    guardedFetch()('http://127.0.0.1:1/.well-known/oauth-authorization-server'),
    /requires HTTPS/,
  )
  await assert.rejects(
    guardedFetch({ testOnlyBaseUrl: 'http://127.0.0.1:1' })(
      'https://example.com/token',
    ),
    /leave its loopback origin/,
  )
  await assert.rejects(
    guardedFetch()('https://user:pw@example.com/token'),
    /credentials/,
  )
  assert.throws(() => guardedFetch({ testOnlyBaseUrl: 'http://example.com' }))
})
