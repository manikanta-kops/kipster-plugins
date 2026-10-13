import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { startFixture } from '../src/fixture/service.ts'

const form = (values: Record<string, string>) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(values),
})

test('fixture publishes MCP authorization metadata and challenges unauthenticated MCP requests', async (t) => {
  const fixture = await startFixture()
  t.after(() => fixture.close())
  assert.match(fixture.url, /^http:\/\/127\.0\.0\.1:\d+$/)
  const challenge = await fetch(fixture.mcpUrl, { method: 'POST', body: '{}' })
  assert.equal(challenge.status, 401)
  assert.equal(
    challenge.headers.get('www-authenticate'),
    `Bearer resource_metadata="${fixture.url}/.well-known/oauth-protected-resource/mcp"`,
  )
  const resource = (await (
    await fetch(`${fixture.url}/.well-known/oauth-protected-resource/mcp`)
  ).json()) as Record<string, unknown>
  assert.equal(resource.resource, fixture.mcpUrl)
  assert.deepEqual(resource.authorization_servers, [fixture.url])
  const read = async () =>
    (await (
      await fetch(`${fixture.url}/.well-known/oauth-authorization-server`)
    ).json()) as Record<string, unknown>
  const metadata = await read()
  assert.equal(metadata.issuer, fixture.url)
  assert.deepEqual(metadata.code_challenge_methods_supported, ['S256'])
  assert.equal(metadata.registration_endpoint, `${fixture.url}/register`)
  assert.equal(metadata.client_id_metadata_document_supported, true)
  fixture.settings.dcr = false
  fixture.settings.cimd = false
  const off = await read()
  assert.equal(off.registration_endpoint, undefined)
  assert.equal(off.client_id_metadata_document_supported, false)
  assert.equal(
    (await fetch(`${fixture.url}/register`, { method: 'POST', body: '{}' }))
      .status,
    404,
  )
})

test('fixture requires S256 PKCE, matches loopback redirects on any port and rotates refresh tokens', async (t) => {
  const fixture = await startFixture()
  t.after(() => fixture.close())
  const registered = (await (
    await fetch(`${fixture.url}/register`, {
      method: 'POST',
      body: JSON.stringify({
        redirect_uris: ['http://127.0.0.1/callback'],
        token_endpoint_auth_method: 'none',
      }),
    })
  ).json()) as { client_id: string; client_secret?: string }
  assert.equal(registered.client_secret, undefined)
  const authorize = (params: Record<string, string>) =>
    fetch(
      `${fixture.url}/authorize?${new URLSearchParams({
        response_type: 'code',
        client_id: registered.client_id,
        redirect_uri: 'http://127.0.0.1:9999/callback',
        state: 's1',
        user: 'alice',
        ...params,
      })}`,
      { redirect: 'manual' },
    )
  for (const params of [
    {},
    { code_challenge: 'x', code_challenge_method: 'plain' },
  ] as Record<string, string>[]) {
    const location = new URL((await authorize(params)).headers.get('location')!)
    assert.equal(location.searchParams.get('error'), 'invalid_request')
    assert.equal(location.searchParams.get('state'), 's1')
  }
  const wrong = await authorize({
    redirect_uri: 'http://evil.example/callback',
    code_challenge: 'x',
    code_challenge_method: 'S256',
  })
  assert.equal(wrong.status, 400)
  const verifier = 'v'.repeat(64)
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const ok = await authorize({
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })
  const back = new URL(ok.headers.get('location')!)
  assert.equal(back.origin, 'http://127.0.0.1:9999')
  assert.equal(back.searchParams.get('iss'), fixture.url)
  const code = back.searchParams.get('code')!
  const exchange = (code_verifier: string) =>
    fetch(
      `${fixture.url}/token`,
      form({
        grant_type: 'authorization_code',
        code,
        code_verifier,
        client_id: registered.client_id,
        redirect_uri: 'http://127.0.0.1:9999/callback',
      }),
    )
  assert.equal((await exchange('w'.repeat(64))).status, 400)
  // The failed attempt consumed the code.
  assert.equal((await exchange(verifier)).status, 400)
  const fresh = new URL(
    (
      await authorize({
        code_challenge: challenge,
        code_challenge_method: 'S256',
      })
    ).headers.get('location')!,
  ).searchParams.get('code')!
  const tokens = (await (
    await fetch(
      `${fixture.url}/token`,
      form({
        grant_type: 'authorization_code',
        code: fresh,
        code_verifier: verifier,
        client_id: registered.client_id,
        redirect_uri: 'http://127.0.0.1:9999/callback',
      }),
    )
  ).json()) as { refresh_token: string }
  const refresh = (refresh_token: string) =>
    fetch(
      `${fixture.url}/token`,
      form({
        grant_type: 'refresh_token',
        refresh_token,
        client_id: registered.client_id,
      }),
    )
  const rotated = await refresh(tokens.refresh_token)
  assert.equal(rotated.status, 200)
  const next = ((await rotated.json()) as { refresh_token: string })
    .refresh_token
  assert.notEqual(next, tokens.refresh_token)
  assert.equal((await refresh(tokens.refresh_token)).status, 400)
  assert.equal(
    (await fetch(`${fixture.url}/revoke`, form({ token: next }))).status,
    200,
  )
  assert.equal((await refresh(next)).status, 400)
  assert.equal(fixture.stats.revocations, 1)
})

test('fixture consent page offers alice and bob without a chosen user', async (t) => {
  const fixture = await startFixture({ cimd: false })
  t.after(() => fixture.close())
  const registered = (await (
    await fetch(`${fixture.url}/register`, {
      method: 'POST',
      body: JSON.stringify({ redirect_uris: ['http://127.0.0.1/callback'] }),
    })
  ).json()) as { client_id: string; client_secret: string }
  assert.ok(registered.client_secret)
  const page = await fetch(
    `${fixture.url}/authorize?${new URLSearchParams({
      response_type: 'code',
      client_id: registered.client_id,
      redirect_uri: 'http://127.0.0.1:1/callback',
      code_challenge: 'x',
      code_challenge_method: 'S256',
    })}`,
  )
  const html = await page.text()
  assert.match(html, /Sign in as alice/)
  assert.match(html, /Sign in as bob/)
  const unknown = await fetch(
    `${fixture.url}/authorize?client_id=https://kipster.example/c.json&redirect_uri=http://127.0.0.1/callback`,
  )
  assert.equal(unknown.status, 400)
})

test('npm run fixture starts the fixture on a loopback port', async (t) => {
  const child = spawn(process.execPath, ['src/fixture/cli.ts', '--port', '0'], {
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  t.after(() => {
    child.kill()
  })
  const line = await new Promise<string>((resolve, reject) => {
    let output = ''
    child.stdout.on('data', (chunk) => {
      output += String(chunk)
      if (output.includes('\n')) resolve(output.split('\n')[0]!)
    })
    child.on('error', reject)
    child.on('exit', () => reject(new Error(`exited: ${output}`)))
  })
  const { url, mcpUrl } = JSON.parse(line) as { url: string; mcpUrl: string }
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/)
  assert.equal((await fetch(mcpUrl, { method: 'POST' })).status, 401)
  const exited = new Promise((resolve) => child.once('exit', resolve))
  child.kill('SIGTERM')
  assert.equal(await exited, 0)
})
