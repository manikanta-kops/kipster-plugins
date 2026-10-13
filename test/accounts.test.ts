import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FetchLike } from '@modelcontextprotocol/client'
import { resolveAccount } from '../src/accounts/resolve.ts'
import { setup } from './signin-helpers.ts'

const work = { id: 'a1', label: 'Work' }
const home = { id: 'a2', label: 'Personal' }
const side = { id: 'a3', label: 'Side' }

test('account resolution follows the plan order', () => {
  const accounts = [work, home, side]
  assert.deepEqual(resolveAccount({ accounts: [] }), { result: 'no-account' })
  assert.deepEqual(resolveAccount({ accounts: [], requested: 'Work' }), {
    result: 'no-account',
  })
  // 1. The account the caller passed, by label or id, before everything else.
  for (const requested of ['personal', 'a2'])
    assert.deepEqual(
      resolveAccount({
        accounts,
        requested,
        rules: [{ prefix: 'acme/', account: 'Work' }],
        target: 'acme/api',
        reachable: ['a1'],
        defaultId: 'a3',
      }),
      { result: 'account', account: home, reason: 'requested' },
    )
  assert.deepEqual(resolveAccount({ accounts, requested: 'nobody' }), {
    result: 'unknown-account',
    requested: 'nobody',
    candidates: ['Work', 'Personal', 'Side'],
  })
  // 2. A routing rule; the longest matching prefix wins, missing accounts are skipped.
  const rules = [
    { prefix: 'acme/', account: 'Work' },
    { prefix: 'acme/private/', account: 'a3' },
    { prefix: 'me/', account: 'gone' },
  ]
  assert.deepEqual(
    resolveAccount({
      accounts,
      rules,
      target: 'acme/private/x',
      defaultId: 'a2',
    }),
    { result: 'account', account: side, reason: 'rule' },
  )
  assert.deepEqual(
    resolveAccount({ accounts, rules, target: 'acme/web', reachable: ['a2'] }),
    { result: 'account', account: work, reason: 'rule' },
  )
  assert.deepEqual(
    resolveAccount({ accounts, rules, target: 'me/x', defaultId: 'a2' }),
    { result: 'account', account: home, reason: 'default' },
  )
  // 3. The only account that can reach the target.
  assert.deepEqual(
    resolveAccount({
      accounts,
      rules,
      target: 'other/x',
      reachable: ['a3'],
      defaultId: 'a1',
    }),
    { result: 'account', account: side, reason: 'reachable' },
  )
  // 4. The default, among the reachable accounts when reachability is known.
  assert.deepEqual(
    resolveAccount({ accounts, reachable: ['a1', 'a2'], defaultId: 'a2' }),
    { result: 'account', account: home, reason: 'default' },
  )
  assert.deepEqual(
    resolveAccount({ accounts, reachable: ['a1', 'a2'], defaultId: 'a3' }),
    { result: 'ambiguous', candidates: ['Work', 'Personal'] },
  )
  assert.deepEqual(resolveAccount({ accounts, defaultId: 'a1' }), {
    result: 'account',
    account: work,
    reason: 'default',
  })
  // 5. The only account.
  assert.deepEqual(resolveAccount({ accounts: [work] }), {
    result: 'account',
    account: work,
    reason: 'only',
  })
  assert.deepEqual(resolveAccount({ accounts: [work], reachable: [] }), {
    result: 'account',
    account: work,
    reason: 'only',
  })
  // Otherwise ambiguous, with the candidate labels.
  assert.deepEqual(resolveAccount({ accounts }), {
    result: 'ambiguous',
    candidates: ['Work', 'Personal', 'Side'],
  })
  assert.deepEqual(resolveAccount({ accounts, reachable: [] }), {
    result: 'ambiguous',
    candidates: ['Work', 'Personal', 'Side'],
  })
})

test('concurrent callers of an expired token share one refresh, and rotation stores the new refresh token', async (t) => {
  const s = await setup(t)
  const { account } = await s.signInAs('alice')
  const first = await s.accounts.accessToken(account.id)
  assert.equal(await s.accounts.accessToken(account.id), first)
  assert.equal(s.fixture.stats.refreshGrants, 0)
  const [, originalRefresh] = s.fixture.issuedTokens()
  s.clock.now += 2 * 3600_000
  const tokens = await Promise.all(
    Array.from({ length: 8 }, () => s.accounts.accessToken(account.id)),
  )
  assert.equal(s.fixture.stats.refreshGrants, 1)
  assert.equal(new Set(tokens).size, 1)
  assert.notEqual(tokens[0], first)
  // The old refresh token no longer works at the fixture...
  const reuse = await fetch(`${s.fixture.url}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: originalRefresh!,
      client_id: s.fixture.stats.authorizeRequests[0]!.get('client_id')!,
    }),
  })
  assert.equal(reuse.status, 400)
  assert.equal(
    ((await reuse.json()) as { error: string }).error,
    'invalid_grant',
  )
  // ...and the stored, rotated one does.
  s.clock.now += 2 * 3600_000
  const again = await s.accounts.accessToken(account.id)
  assert.notEqual(again, tokens[0])
  assert.equal(s.accounts.get(account.id)!.status, 'working')
  // A caller holding a token another caller already replaced gets the new one.
  assert.equal(await s.accounts.refresh(account.id, tokens[0]), again)
  assert.equal(s.fixture.stats.refreshGrants, 3)
})

test('a revoked grant marks the account reconnect needed until it signs in again', async (t) => {
  const s = await setup(t)
  const { account } = await s.signInAs('alice')
  const bob = (await s.signInAs('bob')).account
  s.fixture.revokeUser('alice')
  s.clock.now += 2 * 3600_000
  await assert.rejects(
    Promise.all([
      s.accounts.accessToken(account.id),
      s.accounts.accessToken(account.id),
    ]),
    (error: Error & { code: string }) =>
      error.code === 'reconnect-needed' && !/fixture-/.test(error.message),
  )
  assert.equal(s.fixture.stats.refreshGrants, 1)
  assert.equal(s.accounts.get(account.id)!.status, 'reconnect-needed')
  await assert.rejects(s.accounts.accessToken(account.id), {
    code: 'reconnect-needed',
  })
  assert.equal(s.fixture.stats.refreshGrants, 1)
  assert.ok(await s.accounts.accessToken(bob.id))
  assert.equal(s.accounts.get(bob.id)!.status, 'working')
  const again = await s.signInAs('alice')
  assert.equal(again.duplicate, true)
  assert.equal(again.account.status, 'working')
  assert.ok(await s.accounts.accessToken(account.id))
})

test('removing an account revokes it at the service and deletes its secrets', async (t) => {
  const s = await setup(t)
  const { account } = await s.signInAs('alice')
  const token = await s.accounts.accessToken(account.id)
  s.accounts.setDefault('linear', account.id)
  assert.deepEqual(await s.accounts.remove(account.id), { revoked: true })
  assert.ok(s.fixture.stats.revocations >= 1)
  assert.equal(await s.home.secrets.get(`account:${account.id}`), undefined)
  assert.deepEqual(s.accounts.list(), [])
  assert.equal(s.accounts.get(account.id), undefined)
  const rejected = await fetch(s.fixture.mcpUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  })
  assert.equal(rejected.status, 401)
  await assert.rejects(s.accounts.remove(account.id), { code: 'not-found' })
  await assert.rejects(s.accounts.accessToken(account.id), {
    code: 'not-found',
  })
  // Signing in again creates a fresh account with no default left behind.
  const again = await s.signInAs('alice')
  assert.equal(again.duplicate, false)
  assert.equal(again.account.isDefault, false)
})

// Holds refresh requests until released, to widen race windows.
function gate() {
  let open!: () => void
  const released = new Promise<void>((resolve) => (open = resolve))
  let started!: () => void
  const waiting = new Promise<void>((resolve) => (started = resolve))
  return {
    released,
    waiting,
    open,
    wrap:
      (fetch: FetchLike): FetchLike =>
      async (input, init) => {
        if (String(init?.body).includes('grant_type=refresh_token')) {
          started()
          await released
        }
        return fetch(input, init)
      },
  }
}

test('a reconnect during a refresh keeps the sign-in tokens and status', async (t) => {
  const g = gate()
  const s = await setup(t, { wrapFetch: g.wrap })
  const { account } = await s.signInAs('alice')
  s.fixture.revokeUser('alice')
  s.clock.now += 2 * 3600_000
  const refreshing = s.accounts.accessToken(account.id)
  await g.waiting
  const reconnect = s.signInAs('alice')
  g.open()
  await assert.rejects(refreshing, { code: 'reconnect-needed' })
  assert.equal((await reconnect).duplicate, true)
  assert.equal(s.accounts.get(account.id)!.status, 'working')
  const token = await s.accounts.accessToken(account.id)
  assert.equal(token, s.fixture.issuedTokens().at(-2))
})

test('removing an account during a refresh leaves no secrets behind', async (t) => {
  const g = gate()
  const s = await setup(t, { wrapFetch: g.wrap })
  const { account } = await s.signInAs('alice')
  s.clock.now += 2 * 3600_000
  const refreshing = s.accounts.accessToken(account.id)
  await g.waiting
  const removing = s.accounts.remove(account.id)
  g.open()
  assert.ok(await refreshing)
  assert.deepEqual(await removing, { revoked: true })
  const rows = s.home.db.prepare('SELECT count(*) AS n FROM secrets').get() as {
    n: number
  }
  // Only the reusable DCR client registration remains.
  assert.equal(rows.n, 1)
  await assert.rejects(s.accounts.refresh(account.id), { code: 'not-found' })
})

test('a client registration the service forgot marks the account reconnect needed', async (t) => {
  const s = await setup(t)
  const { account } = await s.signInAs('alice')
  s.fixture.forgetClients()
  s.clock.now += 2 * 3600_000
  await assert.rejects(s.accounts.accessToken(account.id), {
    code: 'reconnect-needed',
  })
  assert.equal(s.accounts.get(account.id)!.status, 'reconnect-needed')
})
