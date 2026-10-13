import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { importPlugins } from '../src/importer/import.ts'
import { requireCatalogue } from '../src/catalogue/validate.ts'
import { data } from '../src/catalogue/types.ts'
export async function temporary(t: {
  after: (fn: () => Promise<void>) => void
}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kipster-plugins-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}
export async function example(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await temporary(t)
  await importPlugins(['Linear'], { output: dir })
  const plugin = (await requireCatalogue(dir))[0]!
  data(plugin).signIn = ['dcr']
  return { dir, plugin }
}
export async function cli(
  script: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: { ...process.env, KIPSTER_PLUGINS_CLIENT_METADATA_URL: '', ...env },
    })
    let output = ''
    child.stdout.on('data', (chunk) => {
      output += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      output += String(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, output }))
  })
}
