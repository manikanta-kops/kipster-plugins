import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { startFixture, type FixtureIdentity } from './service.ts'

try {
  const { values } = parseArgs({
    options: {
      port: { type: 'string' },
      'no-dcr': { type: 'boolean' },
      'no-cimd': { type: 'boolean' },
      identity: { type: 'string' },
      'client-metadata-document': { type: 'string' },
    },
  })
  const port = values.port === undefined ? 0 : Number(values.port)
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    throw new Error('--port must be a port number')
  const identity = (values.identity ?? 'userinfo') as FixtureIdentity
  if (!['userinfo', 'id-token', 'tool', 'none'].includes(identity))
    throw new Error('--identity must be userinfo, id-token, tool or none')
  // CIMD without network: serve one local document for the client_id it names.
  const document = values['client-metadata-document']
    ? (JSON.parse(
        await readFile(values['client-metadata-document'], 'utf8'),
      ) as { client_id?: unknown })
    : undefined
  const fixture = await startFixture({
    port,
    dcr: !values['no-dcr'],
    cimd: !values['no-cimd'],
    identity,
    ...(document
      ? {
          clientMetadata: async (url: string) =>
            url === document.client_id ? document : undefined,
        }
      : {}),
  })
  console.log(JSON.stringify({ url: fixture.url, mcpUrl: fixture.mcpUrl }))
  const stop = () => void fixture.close().then(() => process.exit(0))
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Fixture failed')
  process.exitCode = 1
}
