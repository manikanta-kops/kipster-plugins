import assert from 'node:assert/strict'
import { join } from 'node:path'
import { startFixture, type FixtureOptions } from '../src/fixture/service.ts'
import { openHome, fileKeyBackend } from '../src/state/home.ts'
import { Accounts } from '../src/accounts/accounts.ts'
import { SignInManager } from '../src/signin/signin.ts'
import { guardedFetch } from '../src/signin/fetch.ts'
import type { FetchLike } from '@modelcontextprotocol/client'
import type { Settings } from '../src/state/settings.ts'
import type { Plugin } from '../src/catalogue/types.ts'
import { example, temporary } from './helpers.ts'

type T = { after: (fn: () => Promise<void> | void) => void }
export const cimdUrl = 'https://kipster.example/oauth/client.json'
// A fixture service, a temporary home and a sign-in manager pointed at it.
export async function setup(
  t: T,
  options: {
    fixture?: FixtureOptions
    settings?: Settings
    port?: number
    wrapFetch?: (fetch: FetchLike) => FetchLike
  } = {},
) {
  const clock = { now: Date.now() }
  const fixture = await startFixture(options.fixture)
  t.after(() => fixture.close())
  const dir = join(await temporary(t), 'home')
  const home = await openHome(dir, { keyBackend: fileKeyBackend(dir) })
  t.after(() => home.close())
  const guarded = guardedFetch({ testOnlyBaseUrl: fixture.url })
  const fetch = options.wrapFetch ? options.wrapFetch(guarded) : guarded
  const now = () => clock.now
  const accounts = new Accounts(home, { fetch, now })
  const signIn = new SignInManager({
    accounts,
    secrets: home.secrets,
    settings: options.settings ?? {},
    port: options.port ?? 45_871,
    testOnlyBaseUrl: fixture.url,
    now,
  })
  const { plugin } = await example(t)
  // Follows the authorization URL as the person's browser would, choosing a user.
  async function authorize(url: string, user: string): Promise<string> {
    const response = await globalThis.fetch(`${url}&user=${user}`, {
      redirect: 'manual',
    })
    assert.equal(response.status, 302)
    return response.headers.get('location')!
  }
  async function signInAs(user: string, target: Plugin = plugin) {
    const started = await signIn.start(target)
    assert.equal(started.status, 'redirect')
    if (started.status !== 'redirect') throw new Error('unreachable')
    return signIn.complete(await authorize(started.authorizationUrl, user))
  }
  return {
    clock,
    fixture,
    home,
    dir,
    accounts,
    signIn,
    plugin,
    authorize,
    signInAs,
  }
}
