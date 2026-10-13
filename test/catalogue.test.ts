import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile, symlink, rename, cp } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Catalogue } from '../src/catalogue/loader.ts'
import { importPlugins } from '../src/importer/import.ts'
import {
  requireCatalogue,
  validatePlugin,
  duplicateErrors,
} from '../src/catalogue/validate.ts'
import { availability, data, toolLabel } from '../src/catalogue/types.ts'
import { writeJson } from '../src/json.ts'
import { temporary, example } from './helpers.ts'
async function eventually(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000
  while (!check()) {
    if (Date.now() > deadline) assert.fail('Live reload timed out')
    await delay(20)
  }
}
test('catalogue loads, watches add/change/remove, retains invalid last good and recovers', async (t) => {
  const { dir } = await example(t)
  const loader = new Catalogue(dir, 10)
  t.after(() => loader.close())
  const invalid: string[] = []
  loader.on('invalid', (event) => invalid.push(event.reason))
  await loader.start()
  assert.equal(loader.plugins.size, 1)
  await importPlugins(['Notion'], { output: dir })
  await eventually(() => loader.plugins.size === 2)
  const notion = loader.plugins.get('notion')!
  notion.manifest.description = 'Updated'
  await writeJson(join(notion.folder, 'plugin.json'), notion.manifest)
  await eventually(
    () => loader.plugins.get('notion')?.manifest.description === 'Updated',
  )
  await writeFile(join(notion.folder, 'plugin.json'), '{broken')
  await eventually(() => invalid.length > 0)
  assert.equal(loader.plugins.get('notion')!.manifest.description, 'Updated')
  notion.manifest.description = 'Recovered'
  await writeJson(join(notion.folder, 'plugin.json'), notion.manifest)
  await eventually(
    () => loader.plugins.get('notion')?.manifest.description === 'Recovered',
  )
  await rm(notion.folder, { recursive: true })
  await eventually(() => !loader.plugins.has('notion'))
})
test('duplicate display names are rejected on load and last good versions survive updates', async (t) => {
  const { dir } = await example(t)
  await importPlugins(['Notion'], { output: dir })
  const loader = new Catalogue(dir, 10)
  t.after(() => loader.close())
  const errors: string[] = []
  loader.on('invalid', (event) => errors.push(event.reason))
  await loader.start()
  const notion = loader.plugins.get('notion')!
  data(notion).name = 'linear'
  await writeJson(join(notion.folder, 'plugin.json'), notion.manifest)
  await eventually(() => errors.some((e) => /Duplicate/.test(e)))
  assert.equal(data(loader.plugins.get('notion')!).name, 'Notion')
  await assert.rejects(requireCatalogue(dir), /Duplicate/)
  assert.equal(duplicateErrors([notion, notion]).size, 1)
})
test('schema and semantic validation reject malformed catalogue fields', async (t) => {
  const { plugin } = await example(t)
  const mutations: ((p: typeof plugin) => void)[] = [
    (p) => {
      delete (p.manifest as Partial<typeof p.manifest>).description
    },
    (p) => {
      data(p).id = 'bad__id'
    },
    (p) => {
      data(p).id = 'a'.repeat(33)
    },
    (p) => {
      data(p).id = 'different'
    },
    (p) => {
      data(p).signIn = ['invalid'] as never
    },
    (p) => {
      Object.values(p.mcp.mcpServers)[0]!.url = 'http://example.com/mcp'
    },
    (p) => {
      data(p).needsAddress = true
    },
    (p) => {
      data(p).addressPrompt = 'Unexpected'
    },
    (p) => {
      Object.values(p.mcp.mcpServers)[0]!.type = 'sse'
    },
    (p) => {
      data(p).probe = {
        result: 'invalid' as never,
        signIn: [],
        checkedOn: '2026-10-13',
        reason: 'bad',
      }
    },
    (p) => {
      data(p).verification = 'probe'
    },
    (p) => {
      data(p).tools['x'.repeat(60)] = 'read'
    },
  ]
  for (const mutate of mutations) {
    const copy = structuredClone(plugin)
    mutate(copy)
    assert.throws(() => validatePlugin(copy.folder, copy.manifest, copy.mcp))
  }
})
test('optional component directories are allowed; escaping symlinks are rejected', async (t) => {
  const { dir, plugin } = await example(t)
  await mkdir(join(plugin.folder, 'skills'))
  await mkdir(join(plugin.folder, 'app.kipster'))
  assert.equal((await requireCatalogue(dir)).length, 1)
  const outside = await temporary(t)
  await symlink(outside, join(dir, 'outside'))
  await assert.rejects(requireCatalogue(dir), /within their root/)
})
test('availability and labels remain honest without a real-account test', async (t) => {
  const { plugin } = await example(t)
  assert.deepEqual(availability(plugin), { available: true })
  assert.equal(toolLabel(plugin, 'unknown'), 'write')
  assert.equal(toolLabel(plugin, 'toString'), 'write')
  assert.equal(toolLabel(plugin, '__proto__'), 'write')
  data(plugin).tools['reviewed'] = 'read'
  assert.equal(toolLabel(plugin, 'reviewed'), 'read')
  data(plugin).probe = {
    result: 'needs-address',
    signIn: [],
    checkedOn: '2026-10-13',
    reason: 'Ask for address',
  }
  assert.equal(availability(plugin).available, true)
  data(plugin).probe!.result = 'error'
  assert.deepEqual(availability(plugin), {
    available: false,
    reason: 'Ask for address',
  })
})

test('a replaced plugin directory stays watched for subsequent changes', async (t) => {
  const { dir, plugin } = await example(t)
  const loader = new Catalogue(dir, 10)
  t.after(() => loader.close())
  await loader.start()
  const replacement = await temporary(t)
  await cp(plugin.folder, join(replacement, 'linear'), { recursive: true })
  await rm(plugin.folder, { recursive: true })
  await rename(join(replacement, 'linear'), plugin.folder)
  plugin.manifest.description = 'Replacement'
  await writeJson(join(plugin.folder, 'plugin.json'), plugin.manifest)
  await eventually(
    () => loader.plugins.get('linear')?.manifest.description === 'Replacement',
  )
  plugin.manifest.description = 'Later update'
  await writeJson(join(plugin.folder, 'plugin.json'), plugin.manifest)
  await eventually(
    () => loader.plugins.get('linear')?.manifest.description === 'Later update',
  )
})
test('invalid initial entries are reported and recover when fixed', async (t) => {
  const { dir, plugin } = await example(t)
  await writeFile(join(plugin.folder, 'plugin.json'), '{}')
  const loader = new Catalogue(dir, 10)
  t.after(() => loader.close())
  const errors: string[] = []
  loader.on('invalid', (event) => errors.push(event.reason))
  await loader.start()
  assert.equal(loader.plugins.size, 0)
  assert.ok(errors.length)
  await writeJson(join(plugin.folder, 'plugin.json'), plugin.manifest)
  await eventually(() => loader.plugins.has('linear'))
})
test('retained versions do not introduce cascading name conflicts', async (t) => {
  const { dir } = await example(t)
  await importPlugins(['Notion'], { output: dir })
  const loader = new Catalogue(dir, 10)
  t.after(() => loader.close())
  await loader.start()
  const linear = loader.plugins.get('linear')!
  const notion = loader.plugins.get('notion')!
  await writeFile(join(linear.folder, 'plugin.json'), '{broken')
  data(notion).name = 'Linear'
  await writeJson(join(notion.folder, 'plugin.json'), notion.manifest)
  const newcomer = structuredClone(notion)
  newcomer.folder = join(dir, 'newcomer')
  newcomer.manifest.name = 'newcomer'
  data(newcomer).id = 'newcomer'
  data(newcomer).name = 'Notion'
  newcomer.mcp.mcpServers = {
    newcomer: Object.values(notion.mcp.mcpServers)[0]!,
  }
  await mkdir(newcomer.folder)
  await writeJson(join(newcomer.folder, 'mcp.json'), newcomer.mcp)
  await writeJson(join(newcomer.folder, 'plugin.json'), newcomer.manifest)
  await loader.reload()
  assert.deepEqual([...loader.plugins.keys()].sort(), ['linear', 'notion'])
  assert.equal(data(loader.plugins.get('notion')!).name, 'Notion')
})

test('periodic reconciliation recovers a catalogue root after its watch loses the directory', async (t) => {
  const { dir } = await example(t)
  const moved = await temporary(t)
  const loader = new Catalogue(dir, 10, 50)
  t.after(() => loader.close())
  const errors: string[] = []
  loader.on('invalid', (event) => errors.push(event.reason))
  await loader.start()
  // The native watch is now attached to the old inode, not the future root.
  await rename(dir, join(moved, 'old-catalogue'))
  await eventually(() => errors.length > 0)
  await mkdir(dir)
  await importPlugins(['Notion'], { output: dir })
  await eventually(
    () => loader.plugins.has('notion') && !loader.plugins.has('linear'),
  )
})
