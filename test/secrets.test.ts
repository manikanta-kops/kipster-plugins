import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { KeychainKeyBackend, type CommandRunner } from '../src/secrets/store.ts'
import {
  fileKeyBackend,
  migrate,
  migrations,
  openHome,
} from '../src/state/home.ts'
import {
  clientMetadataDocument,
  loadSettings,
  returnAddress,
} from '../src/state/settings.ts'
import { temporary } from './helpers.ts'

test('home folder: migrations, private files and an encrypted file-key secret store', async (t) => {
  const dir = join(await temporary(t), 'home')
  const home = await openHome(dir, { keyBackend: fileKeyBackend(dir) })
  t.after(() => home.close())
  assert.equal(
    (home.db.prepare('PRAGMA user_version').get() as { user_version: number })
      .user_version,
    migrations.length,
  )
  assert.equal(migrate(home.db), migrations.length)
  await home.secrets.set('account:x', 'super-secret-value')
  assert.equal(await home.secrets.get('account:x'), 'super-secret-value')
  assert.equal(await home.secrets.get('account:missing'), undefined)
  assert.equal((await stat(dir)).mode & 0o777, 0o700)
  assert.equal((await stat(join(dir, 'secret.key'))).mode & 0o777, 0o600)
  assert.equal((await stat(join(dir, 'state.db'))).mode & 0o777, 0o600)
  assert.equal(
    (await readFile(join(dir, 'state.db'))).includes('super-secret-value'),
    false,
  )
  // Rows are bound to their names: a swapped row does not decrypt.
  home.db
    .prepare(
      "INSERT INTO secrets (name, value) SELECT 'account:y', value FROM secrets WHERE name = 'account:x'",
    )
    .run()
  await assert.rejects(
    home.secrets.get('account:y'),
    (error: Error) => !error.message.includes('super-secret-value'),
  )
  await home.secrets.delete('account:x')
  assert.equal(await home.secrets.get('account:x'), undefined)
  home.close()
  // Reopening reuses the same key file.
  const reopened = await openHome(dir, { keyBackend: fileKeyBackend(dir) })
  await reopened.secrets.set('again', 'value')
  reopened.close()
  const third = await openHome(dir, { keyBackend: fileKeyBackend(dir) })
  assert.equal(await third.secrets.get('again'), 'value')
  third.close()
})

test('file keys are created once, atomically, and existing homes are made private', async (t) => {
  const dir = await temporary(t)
  const backends = Array.from({ length: 5 }, () => fileKeyBackend(dir))
  const keys = await Promise.all(backends.map((b) => b.key()))
  assert.ok(keys.every((k) => k.equals(keys[0]!)))
  assert.deepEqual(await readdir(dir), ['secret.key'])
  await chmod(dir, 0o755)
  const home = await openHome(dir, { keyBackend: backends[0]! })
  home.close()
  assert.equal((await stat(dir)).mode & 0o777, 0o700)
})

test('a state database from a newer server is refused', async (t) => {
  const path = join(await temporary(t), 'state.db')
  const db = new DatabaseSync(path)
  db.exec(`PRAGMA user_version = ${migrations.length + 1}`)
  assert.throws(() => migrate(db), /newer/)
  db.close()
})

function fakeSecurity(store: Map<string, string>) {
  const calls: { command: string; args: string[]; input?: string }[] = []
  const run: CommandRunner = async (command, args, input) => {
    calls.push({ command, args, input })
    if (args[0] === 'find-generic-password') {
      const value = store.get(`${args[2]}/${args[4]}`)
      return value
        ? { code: 0, stdout: `${value}\n` }
        : { code: 44, stdout: '' }
    }
    const match = /add-generic-password -U -s (\S+) -a (\S+) -w (\S+)\n$/.exec(
      input ?? '',
    )
    if (args[0] !== '-i' || !match) return { code: 1, stdout: 'bad usage' }
    store.set(`${match[1]}/${match[2]}`, match[3]!)
    return { code: 0, stdout: '' }
  }
  return { calls, run }
}

test('keychain backend creates and reads its key only through the injected runner', async (t) => {
  const keychain = new Map<string, string>()
  const fake = fakeSecurity(keychain)
  const backend = new KeychainKeyBackend({ run: fake.run })
  const key = await backend.key()
  assert.equal(key.length, 32)
  assert.equal(await backend.key(), key)
  assert.deepEqual(
    fake.calls.map((c) => [c.command, c.args[0]]),
    [
      ['security', 'find-generic-password'],
      ['security', '-i'],
    ],
  )
  const encoded = key.toString('base64')
  assert.ok(fake.calls.every((c) => !c.args.join(' ').includes(encoded)))
  assert.equal(keychain.get('app.kipster.plugins/secret-store-key'), encoded)
  // A new process finds the existing item and gets the same key.
  const later = new KeychainKeyBackend({ run: fake.run })
  assert.deepEqual(await later.key(), key)
  // The store works on top of it.
  const dir = join(await temporary(t), 'home')
  const home = await openHome(dir, { keyBackend: later })
  t.after(() => home.close())
  await home.secrets.set('n', 'v')
  assert.equal(await home.secrets.get('n'), 'v')
})

test('keychain failures never echo command output and can be retried', async () => {
  let fail = true
  const backend = new KeychainKeyBackend({
    run: async () =>
      fail
        ? { code: 51, stdout: 'leaked-output' }
        : { code: 0, stdout: Buffer.alloc(32, 7).toString('base64') },
  })
  await assert.rejects(
    backend.key(),
    (error: Error) =>
      error.message === 'Keychain lookup failed with exit code 51',
  )
  fail = false
  assert.deepEqual(await backend.key(), Buffer.alloc(32, 7))
  const invalid = new KeychainKeyBackend({
    run: async () => ({ code: 0, stdout: 'short' }),
  })
  await assert.rejects(invalid.key(), /key is invalid/)
  assert.throws(() => new KeychainKeyBackend({ service: 'a b' }))
})

test('settings: client metadata URL is HTTPS only and unset by default', () => {
  assert.deepEqual(loadSettings({}), {})
  assert.deepEqual(
    loadSettings({
      KIPSTER_PLUGINS_CLIENT_METADATA_URL: 'https://k.example/c.json',
    }),
    { clientMetadataUrl: 'https://k.example/c.json' },
  )
  for (const bad of [
    'http://k.example/c.json',
    'https://k.example/',
    'https://u:p@k.example/c.json',
    'https://k.example/c.json#x',
    'not a url',
  ])
    assert.throws(() =>
      loadSettings({ KIPSTER_PLUGINS_CLIENT_METADATA_URL: bad }),
    )
  assert.equal(returnAddress(8123), 'http://127.0.0.1:8123/callback')
  assert.throws(() => returnAddress(0))
  const doc = clientMetadataDocument('https://k.example/c.json')
  assert.equal(doc.client_id, 'https://k.example/c.json')
  assert.deepEqual(doc.redirect_uris, ['http://127.0.0.1/callback'])
  assert.equal(doc.token_endpoint_auth_method, 'none')
})
