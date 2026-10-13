import { cp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { startFixture } from '../fixture/service.ts'
import { startServer } from '../server/server.ts'
import { fileKeyBackend } from '../state/home.ts'

// The factory's verify instance: the fixture service and a plugin server
// pointed at it, in one foreground process. Test data only.
export const verifyToken = 'kipster-verify-token-not-secret'
const root = fileURLToPath(new URL('../../', import.meta.url))
const port = (value: string | undefined, name: string) => {
  const n = Number(value)
  if (!value || !Number.isInteger(n) || n < 0 || n > 65_535)
    throw new Error(`--${name} must be a port number`)
  return n
}
try {
  const { values } = parseArgs({
    options: {
      port: { type: 'string' },
      'fixture-port': { type: 'string' },
      home: { type: 'string' },
      catalogue: { type: 'string' },
    },
  })
  const serverPort = port(values.port, 'port')
  const fixturePort = port(values['fixture-port'], 'fixture-port')
  const home = values.home ?? join(root, '.local', 'verify', 'home')
  // Derived from the port alone, so testers can edit it from any checkout.
  const catalogue =
    values.catalogue ?? `/tmp/kipster-plugins-verify-${serverPort}/catalogue`
  // Every start begins from a clean home and a fresh copy of the catalogue.
  await rm(home, { recursive: true, force: true })
  await rm(catalogue, { recursive: true, force: true })
  await cp(join(root, 'test', 'fixtures', 'catalogue'), catalogue, {
    recursive: true,
  })
  const fixture = await startFixture({ port: fixturePort })
  const server = await startServer({
    port: serverPort,
    home,
    catalogue,
    keyBackend: fileKeyBackend(home),
    testOnlyBaseUrl: fixture.url,
    env: { KIPSTER_PLUGINS_TOKEN: verifyToken },
    settings: {},
    log: (line) => console.error(line),
  }).catch(async (error: unknown) => {
    await fixture.close()
    throw error
  })
  console.log(
    JSON.stringify({
      url: server.url,
      mcpUrl: `${server.url}/mcp`,
      fixtureUrl: fixture.url,
      token: verifyToken,
      catalogue,
      home,
    }),
  )
  const stop = () =>
    void Promise.all([server.close(), fixture.close()]).then(
      () => process.exit(0),
      () => process.exit(1),
    )
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Instance failed')
  process.exitCode = 1
}
