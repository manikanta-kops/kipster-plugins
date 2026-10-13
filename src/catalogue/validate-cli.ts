import { requireCatalogue } from './validate.ts'
try {
  const plugins = await requireCatalogue(process.argv[2] ?? 'plugins')
  console.log(`Validated ${plugins.length} plugins`)
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Validation failed')
  process.exitCode = 1
}
