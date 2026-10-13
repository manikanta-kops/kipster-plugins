#!/usr/bin/env node
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { KeychainKeyBackend } from '../secrets/store.ts'
import { fileKeyBackend } from '../state/home.ts'
import { startServer } from './server.ts'

try {
  const { values } = parseArgs({
    options: {
      port: { type: 'string' },
      home: { type: 'string' },
      catalogue: { type: 'string' },
      'key-backend': { type: 'string' },
      'test-only-base-url': { type: 'string' },
    },
  })
  const port = Number(values.port)
  if (!values.port || !Number.isInteger(port) || port < 0 || port > 65_535)
    throw new Error('--port must be a port number (0 picks a free port)')
  if (!values.home) throw new Error('--home is required')
  const backend =
    values['key-backend'] ??
    (process.platform === 'darwin' ? 'keychain' : 'file')
  if (backend !== 'keychain' && backend !== 'file')
    throw new Error('--key-backend must be keychain or file')
  const server = await startServer({
    port,
    home: values.home,
    catalogue:
      values.catalogue ??
      fileURLToPath(new URL('../../plugins', import.meta.url)),
    keyBackend:
      backend === 'file'
        ? fileKeyBackend(values.home)
        : new KeychainKeyBackend(),
    testOnlyBaseUrl: values['test-only-base-url'],
    log: (line) => console.error(line),
  })
  console.log(JSON.stringify({ url: server.url }))
  const stop = () =>
    void server.close().then(
      () => process.exit(0),
      () => process.exit(1),
    )
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Server failed')
  process.exitCode = 1
}
