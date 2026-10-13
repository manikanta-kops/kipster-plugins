import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { probePlugin, probeCatalogue } from '../src/probe/probe.ts'
import { requireCatalogue } from '../src/catalogue/validate.ts'
import { data, server } from '../src/catalogue/types.ts'
import { writeJson } from '../src/json.ts'
import { example, cli } from './helpers.ts'
import { stub } from './probe-stub.ts'
const fast = { timeoutMs: 300, backoffMs: 1 }

test('DCR ok uses initialize only, honest User-Agent and no credentials or registration', async (t) => {
  const { plugin } = await example(t)
  const fixture = await stub(t)
  const probe = await probePlugin(plugin, {
    ...fast,
    testOnlyBaseUrl: fixture.base,
  })
  assert.equal(probe.result, 'ok')
  assert.deepEqual(probe.signIn, ['dcr'])
  assert.equal(fixture.hits[0]!.method, 'POST')
  assert.equal(JSON.parse(fixture.hits[0]!.body).method, 'initialize')
  assert.equal(fixture.hits.length, 3)
  assert.ok(
    fixture.hits.every(
      (hit) =>
        !hit.authorization &&
        /kipster-plugins-probe.*github.com\/manikanta-kops\/kipster-plugins/.test(
          hit.userAgent!,
        ),
    ),
  )
  assert.equal(fixture.hits.filter((hit) => hit.path === '/register').length, 0)
  assert.ok(fixture.hits.slice(1).every((hit) => hit.method === 'GET'))
})
test('CIMD ok with configured metadata URL; CIMD only without it needs metadata document', async (t) => {
  const { plugin } = await example(t)
  data(plugin).signIn = ['cimd']
  const fixture = await stub(t, { methods: ['cimd'] })
  const options = { ...fast, testOnlyBaseUrl: fixture.base }
  assert.equal(
    (await probePlugin(plugin, options)).result,
    'needs-client-metadata-document',
  )
  const result = await probePlugin(plugin, {
    ...options,
    clientMetadataUrl: 'https://kipster.example/client.json',
  })
  assert.equal(result.result, 'ok')
  assert.deepEqual(result.signIn, ['cimd'])
  assert.equal(fixture.hits.filter((hit) => hit.path === '/register').length, 0)
})
test('method changes and missing S256 are sign-in-changed', async (t) => {
  const { plugin } = await example(t)
  const changed = await stub(t, { methods: ['cimd', 'dcr'] })
  const probe = await probePlugin(plugin, {
    ...fast,
    testOnlyBaseUrl: changed.base,
  })
  assert.equal(probe.result, 'sign-in-changed')
  assert.deepEqual(probe.signIn, ['dcr', 'cimd'])
  const noPkce = await stub(t, { pkce: false })
  assert.equal(
    (await probePlugin(plugin, { ...fast, testOnlyBaseUrl: noPkce.base }))
      .result,
    'sign-in-changed',
  )
})
test('other statuses, missing metadata and invalid JSON are errors without vendor body in reasons', async (t) => {
  const { plugin } = await example(t)
  for (const settings of [
    { status: 403 },
    { status: 302 },
    { missingMetadata: true },
    { invalidJson: true },
  ]) {
    const fixture = await stub(t, settings)
    const result = await probePlugin(plugin, {
      ...fast,
      testOnlyBaseUrl: fixture.base,
    })
    assert.equal(result.result, 'error')
    assert.doesNotMatch(result.reason, /secret-vendor-body/)
  }
})
test('resource and issuer mismatches and unsafe discovery URLs are errors', async (t) => {
  const { plugin } = await example(t)
  for (const settings of [
    { resourceMismatch: true },
    { issuerMismatch: true },
    { unsafeMetadata: true },
  ]) {
    const fixture = await stub(t, settings)
    assert.equal(
      (await probePlugin(plugin, { ...fast, testOnlyBaseUrl: fixture.base }))
        .result,
      'error',
    )
  }
})
const signInPaths = (hits: { path: string }[]) =>
  hits.filter((h) => /\/(register|authorize|token)\b/.test(h.path))
test('origin and path-prefix resources are accepted as the SDK sign-in does', async (t) => {
  const { plugin } = await example(t)
  for (const resource of ['', '/']) {
    const fixture = await stub(t, { resource })
    const probe = await probePlugin(plugin, {
      ...fast,
      testOnlyBaseUrl: fixture.base,
    })
    assert.equal(probe.result, 'ok', `resource ${JSON.stringify(resource)}`)
    assert.deepEqual(signInPaths(fixture.hits), [])
  }
})
test('cross-origin and non-prefix resources stay errors', async (t) => {
  const { plugin } = await example(t)
  for (const resource of [
    'https://mcpeu.example/mcp',
    'http://127.0.0.1:1/mcp',
    '/other',
    '/mc',
    '/mcp/extra',
  ]) {
    const fixture = await stub(t, { resource })
    const probe = await probePlugin(plugin, {
      ...fast,
      testOnlyBaseUrl: fixture.base,
    })
    assert.equal(probe.result, 'error', resource)
    assert.equal(
      probe.reason,
      'Protected resource metadata does not match the MCP endpoint',
    )
  }
})
test('anonymous 200 falls back to well-known discovery and applies the same checks', async (t) => {
  const { plugin } = await example(t)
  const fixture = await stub(t, { status: 200, header: false })
  const probe = await probePlugin(plugin, {
    ...fast,
    testOnlyBaseUrl: fixture.base,
  })
  assert.equal(probe.result, 'ok')
  assert.deepEqual(probe.signIn, ['dcr'])
  assert.match(probe.reason, /^Anonymous access allowed; OAuth sign-in/)
  assert.deepEqual(
    fixture.hits.map((h) => `${h.method} ${h.path}`),
    [
      'POST /mcp',
      'GET /.well-known/oauth-protected-resource/mcp',
      'GET /.well-known/oauth-authorization-server',
    ],
  )
  const root = await stub(t, {
    status: 200,
    resourceAtRoot: true,
    resource: '',
  })
  assert.equal(
    (await probePlugin(plugin, { ...fast, testOnlyBaseUrl: root.base })).result,
    'ok',
  )
  assert.deepEqual(
    root.hits.map((h) => h.path),
    [
      '/mcp',
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-authorization-server',
    ],
  )
  for (const settings of [
    { resourceMismatch: true },
    { issuerMismatch: true },
  ]) {
    const failed = await stub(t, { status: 200, ...settings })
    assert.equal(
      (await probePlugin(plugin, { ...fast, testOnlyBaseUrl: failed.base }))
        .result,
      'error',
    )
  }
  const noPkce = await stub(t, { status: 200, pkce: false })
  assert.equal(
    (await probePlugin(plugin, { ...fast, testOnlyBaseUrl: noPkce.base }))
      .result,
    'sign-in-changed',
  )
  for (const f of [fixture, root, noPkce])
    assert.deepEqual(signInPaths(f.hits), [])
})
test('anonymous 200 without OAuth metadata is an error', async (t) => {
  const { plugin } = await example(t)
  const fixture = await stub(t, { status: 200, missingMetadata: true })
  const probe = await probePlugin(plugin, {
    ...fast,
    testOnlyBaseUrl: fixture.base,
  })
  assert.equal(probe.result, 'error')
  assert.equal(
    probe.reason,
    'Service answered without sign-in and publishes no OAuth metadata',
  )
  assert.deepEqual(
    fixture.hits.map((h) => h.path),
    [
      '/mcp',
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-protected-resource',
    ],
  )
})
test(
  'SSE probe cancels an open anonymous 200 event stream',
  { timeout: 5_000 },
  async (t) => {
    const { plugin } = await example(t)
    server(plugin).type = 'sse'
    server(plugin).url = 'https://mcp.example/sse'
    for (const missingMetadata of [false, true]) {
      const fixture = await stub(t, {
        endpoint: '/sse',
        status: 200,
        stream: true,
        missingMetadata,
      })
      const probe = await probePlugin(plugin, {
        timeoutMs: 2_000,
        backoffMs: 1,
        testOnlyBaseUrl: fixture.base,
      })
      assert.equal(probe.result, missingMetadata ? 'error' : 'ok')
      assert.doesNotMatch(probe.reason, /secret-vendor-body/)
      assert.equal(fixture.hits.filter((h) => h.path === '/sse').length, 1)
      assert.equal(fixture.hits[0]!.method, 'GET')
    }
  },
)
test('protected resource fallbacks try endpoint-specific then root well-known paths', async (t) => {
  const { plugin } = await example(t)
  const fixture = await stub(t, { header: false, resourceAtRoot: true })
  assert.equal(
    (await probePlugin(plugin, { ...fast, testOnlyBaseUrl: fixture.base }))
      .result,
    'ok',
  )
  assert.deepEqual(
    fixture.hits.map((h) => h.path),
    [
      '/mcp',
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-authorization-server',
    ],
  )
})
test('RFC 8414 and both OpenID fallback forms work for path issuers', async (t) => {
  const { plugin } = await example(t)
  for (const discovery of [
    'oauth',
    'openid-insert',
    'openid-append',
  ] as const) {
    const fixture = await stub(t, { issuerPath: '/tenant', discovery })
    assert.equal(
      (await probePlugin(plugin, { ...fast, testOnlyBaseUrl: fixture.base }))
        .result,
      'ok',
    )
    assert.equal(
      fixture.hits[2]!.path,
      '/.well-known/oauth-authorization-server/tenant',
    )
    if (discovery === 'openid-append')
      assert.deepEqual(
        fixture.hits.slice(2).map((h) => h.path),
        [
          '/.well-known/oauth-authorization-server/tenant',
          '/.well-known/openid-configuration/tenant',
          '/tenant/.well-known/openid-configuration',
        ],
      )
  }
})
test('SSE probe uses GET and never follows redirects to registration', async (t) => {
  const { plugin } = await example(t)
  const fixture = await stub(t, { endpoint: '/sse' })
  server(plugin).type = 'sse'
  server(plugin).url = 'https://mcp.example/sse'
  assert.equal(
    (await probePlugin(plugin, { ...fast, testOnlyBaseUrl: fixture.base }))
      .result,
    'ok',
  )
  assert.equal(fixture.hits[0]!.method, 'GET')
  assert.equal(fixture.hits[0]!.path, '/sse')
  const redirect = await stub(t, { redirect: true })
  server(plugin).type = 'streamable-http'
  server(plugin).url = 'https://mcp.example/mcp'
  assert.equal(
    (await probePlugin(plugin, { ...fast, testOnlyBaseUrl: redirect.base }))
      .result,
    'error',
  )
  assert.equal(redirect.hits.length, 1)
})
test('5xx has exactly three attempts, transient failure recovers', async (t) => {
  const { plugin } = await example(t)
  const failed = await stub(t, { status: 503 })
  assert.equal(
    (await probePlugin(plugin, { ...fast, testOnlyBaseUrl: failed.base }))
      .result,
    'unreachable',
  )
  assert.equal(failed.hits.length, 3)
  const recovered = await stub(t, { failFirst: 2 })
  assert.equal(
    (await probePlugin(plugin, { ...fast, testOnlyBaseUrl: recovered.base }))
      .result,
    'ok',
  )
  assert.equal(recovered.hits.filter((h) => h.path === '/mcp').length, 3)
})
test('timeouts including metadata bodies are unreachable after three attempts', async (t) => {
  const { plugin } = await example(t)
  const fixture = await stub(t, { slowMs: 300 })
  assert.equal(
    (
      await probePlugin(plugin, {
        timeoutMs: 50,
        backoffMs: 1,
        testOnlyBaseUrl: fixture.base,
      })
    ).result,
    'unreachable',
  )
  assert.equal(fixture.hits.length, 3)
  const metadata = await stub(t, { metadataSlowMs: 300 })
  assert.equal(
    (
      await probePlugin(plugin, {
        timeoutMs: 50,
        backoffMs: 1,
        testOnlyBaseUrl: metadata.base,
      })
    ).result,
    'unreachable',
  )
  assert.equal(
    metadata.hits.filter((h) => h.path.startsWith('/.well-known/')).length,
    3,
  )
})
test('connection refused is unreachable and CLI exits zero with failures and saves report', async (t) => {
  const { dir, plugin } = await example(t)
  const fixture = await stub(t)
  await fixture.close()
  assert.equal(
    (await probePlugin(plugin, { ...fast, testOnlyBaseUrl: fixture.base }))
      .result,
    'unreachable',
  )
  const reportPath = join(dir, 'probe-report.md')
  const result = await cli('src/probe/cli.ts', [
    '--catalogue',
    dir,
    '--test-only-base-url',
    fixture.base,
    '--report',
    reportPath,
    'linear',
  ])
  assert.equal(result.code, 0)
  assert.match(result.output, /linear \| unreachable/)
  assert.match(await readFile(reportPath, 'utf8'), /1 plugins: 1 unreachable/)
  const saved = data((await requireCatalogue(dir))[0]!)
  assert.equal(saved.probe?.result, 'unreachable')
  assert.equal(saved.verification, undefined)
})
test('CLI exits nonzero for invalid catalogue before any network request', async (t) => {
  const { dir, plugin } = await example(t)
  const fixture = await stub(t)
  await writeFile(join(plugin.folder, 'plugin.json'), '{}')
  const result = await cli('src/probe/cli.ts', [
    '--catalogue',
    dir,
    '--test-only-base-url',
    fixture.base,
  ])
  assert.equal(result.code, 1)
  assert.match(result.output, /plugin.json/)
  assert.equal(fixture.hits.length, 0)
})
test('address template sends no requests', async (t) => {
  const { plugin } = await example(t)
  const fixture = await stub(t)
  data(plugin).needsAddress = true
  server(plugin).url = 'https://{host}/mcp'
  assert.equal(
    (await probePlugin(plugin, { ...fast, testOnlyBaseUrl: fixture.base }))
      .result,
    'needs-address',
  )
  assert.equal(fixture.hits.length, 0)
})
test('batch has at most four services in flight and writes probe verification', async (t) => {
  const { dir, plugin } = await example(t)
  const fixture = await stub(t, { slowMs: 30 })
  const plugins = []
  for (let i = 0; i < 9; i++) {
    const p = structuredClone(plugin)
    const id = `service-${i}`
    p.folder = join(dir, id)
    p.manifest.name = id
    data(p).id = id
    data(p).name = id
    p.mcp.mcpServers = { [id]: server(plugin) }
    await mkdir(p.folder)
    await writeJson(join(p.folder, 'mcp.json'), p.mcp)
    plugins.push(p)
  }
  const results = await probeCatalogue(plugins, {
    ...fast,
    testOnlyBaseUrl: fixture.base,
  })
  assert.equal(results.length, 9)
  assert.ok(results.every((r) => r.probe.result === 'ok'))
  assert.equal(fixture.peak, 4)
  for (const p of plugins) {
    const saved = JSON.parse(
      await readFile(join(p.folder, 'plugin.json'), 'utf8'),
    )
    assert.equal(saved.extensions['app.kipster'].verification, 'probe')
  }
  assert.equal(fixture.hits.filter((h) => h.path === '/register').length, 0)
})
test('later failures clear probe verification but keep an earlier account verification', async (t) => {
  const { plugin } = await example(t)
  const fixture = await stub(t, { status: 503 })
  data(plugin).verification = 'probe'
  await probeCatalogue([plugin], { ...fast, testOnlyBaseUrl: fixture.base })
  assert.equal(data(plugin).verification, undefined)
  data(plugin).verification = 'account'
  await probeCatalogue([plugin], { ...fast, testOnlyBaseUrl: fixture.base })
  assert.equal(data(plugin).verification, 'account')
})
