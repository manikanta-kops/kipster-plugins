import { parseArgs } from 'node:util'
import { writeFile } from 'node:fs/promises'
import { requireCatalogue, secureUrl } from '../catalogue/validate.ts'
import { probeCatalogue, report } from './probe.ts'
import { data } from '../catalogue/types.ts'
try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      catalogue: { type: 'string' },
      report: { type: 'string' },
      'test-only-base-url': { type: 'string' },
    },
  })
  const plugins = await requireCatalogue(values.catalogue ?? 'plugins')
  for (const id of positionals)
    if (!plugins.some((p) => data(p).id === id))
      throw new Error(`Unknown plugin id: ${id}`)
  const clientMetadataUrl =
    process.env.KIPSTER_PLUGINS_CLIENT_METADATA_URL || undefined
  if (clientMetadataUrl) secureUrl(clientMetadataUrl)
  const results = await probeCatalogue(
    positionals.length
      ? plugins.filter((p) => positionals.includes(data(p).id))
      : plugins,
    { clientMetadataUrl, testOnlyBaseUrl: values['test-only-base-url'] },
  )
  const output = report(results)
  console.log(output)
  if (values.report) await writeFile(values.report, output)
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Probe failed')
  process.exitCode = 1
}
