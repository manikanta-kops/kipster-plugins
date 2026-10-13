import { parseArgs } from 'node:util'
import { importPlugins } from './import.ts'
try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      output: { type: 'string' },
      all: { type: 'boolean' },
      force: { type: 'boolean' },
    },
  })
  if (!values.all && !positionals.length)
    throw new Error(
      'Usage: npm run import -- [--output directory] [--force] <service names...> | --all',
    )
  console.log((await importPlugins(positionals, values)).join('\n'))
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Import failed')
  process.exitCode = 1
}
