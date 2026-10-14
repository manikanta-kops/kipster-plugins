import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { cli, temporary } from './helpers.ts'

type T = { after: (fn: () => Promise<void> | void) => void }
// Starts a long-running command and resolves with its first stdout line.
function start(
  t: T,
  script: string,
  args: string[],
): Promise<{ child: ChildProcess; line: string }> {
  const child = spawn(process.execPath, [script, ...args], {
    env: {
      ...process.env,
      KIPSTER_PLUGINS_TOKEN: '',
    },
  })
  t.after(() => {
    if (child.exitCode === null) child.kill('SIGKILL')
  })
  return new Promise((resolve, reject) => {
    let output = ''
    child.stdout!.on('data', (chunk) => {
      output += String(chunk)
      const end = output.indexOf('\n')
      if (end >= 0) resolve({ child, line: output.slice(0, end) })
    })
    child.stderr!.on('data', (chunk) => {
      output += String(chunk)
    })
    child.on('exit', (code) =>
      reject(new Error(`Exited with ${code}: ${output}`)),
    )
  })
}
const exited = (child: ChildProcess) =>
  new Promise<number | null>((resolve) => child.once('exit', resolve))

test('serve prints its URL, serves health, protects the API and stops on SIGTERM', async (t) => {
  const home = join(await temporary(t), 'home')
  const { child, line } = await start(t, 'src/server/cli.ts', [
    '--port',
    '0',
    '--home',
    home,
    '--key-backend',
    'file',
    '--catalogue',
    'test/fixtures/catalogue',
  ])
  const { url } = JSON.parse(line) as { url: string }
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/)
  assert.equal((await fetch(`${url}/health`)).status, 200)
  assert.equal((await fetch(`${url}/v1`)).status, 401)
  assert.equal((await stat(join(home, 'token'))).mode & 0o777, 0o600)
  const done = exited(child)
  child.kill('SIGTERM')
  assert.equal(await done, 0)
})

test('serve refuses to start without a home or with a bad key backend', async () => {
  const missing = await cli('src/server/cli.ts', ['--port', '0'])
  assert.equal(missing.code, 1)
  assert.match(missing.output, /--home is required/)
  const backend = await cli('src/server/cli.ts', [
    '--port',
    '0',
    '--home',
    '/nonexistent/never',
    '--key-backend',
    'cloud',
  ])
  assert.equal(backend.code, 1)
  assert.match(backend.output, /--key-backend must be keychain or file/)
})

test('the verify instance signs in through the fixture and the MCP CLI lists and calls tools', async (t) => {
  const dir = await temporary(t)
  const { child, line } = await start(t, 'src/dev/instance.ts', [
    '--port',
    '0',
    '--fixture-port',
    '0',
    '--home',
    join(dir, 'home'),
    '--catalogue',
    join(dir, 'catalogue'),
  ])
  const instance = JSON.parse(line) as {
    url: string
    mcpUrl: string
    token: string
  }
  assert.equal(instance.token, 'kipster-verify-token-not-secret')
  const auth = { Authorization: `Bearer ${instance.token}` }
  const started = (await (
    await fetch(`${instance.url}/v1/plugins/fixture/sign-in`, {
      method: 'POST',
      headers: auth,
    })
  ).json()) as { authorizationUrl: string; id: string }
  const consent = await fetch(`${started.authorizationUrl}&user=alice`, {
    redirect: 'manual',
  })
  const back = await fetch(consent.headers.get('location')!)
  assert.equal(back.status, 200)
  const args = ['--url', instance.url, '--token', instance.token]
  const list = await cli('src/mcp/cli.ts', [...args, 'list'])
  assert.equal(list.code, 0, list.output)
  assert.deepEqual(JSON.parse(list.output), [
    { name: 'plugin_list', access: 'read', readOnlyHint: true },
    { name: 'plugin_get', access: 'read', readOnlyHint: true },
    { name: 'fixture__whoami', access: 'read', readOnlyHint: true },
    { name: 'fixture__create_note', access: 'write', readOnlyHint: false },
  ])
  const call = await cli('src/mcp/cli.ts', [
    ...args,
    '--era',
    'modern',
    'call',
    'fixture__whoami',
    '{}',
  ])
  assert.equal(call.code, 0, call.output)
  const result = JSON.parse(call.output) as {
    structuredContent: { login: string }
    content: { text: string }[]
  }
  assert.equal(result.structuredContent.login, 'alice')
  assert.equal(result.content.at(-1)!.text, 'Account: alice@fixture.test')
  const denied = await cli('src/mcp/cli.ts', [
    '--url',
    instance.mcpUrl,
    '--token',
    'wrong-token-wrong-token',
    'list',
  ])
  assert.equal(denied.code, 1)
  const done = exited(child)
  child.kill('SIGTERM')
  assert.equal(await done, 0)
})
