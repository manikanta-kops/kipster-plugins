import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { format } from 'prettier'
import {
  importPlugins,
  documents,
  readResearch,
  recordedMethods,
  type Row,
} from '../src/importer/import.ts'
import { requireCatalogue } from '../src/catalogue/validate.ts'
import { data, server } from '../src/catalogue/types.ts'
import { temporary, cli } from './helpers.ts'

test('imports case-insensitive Linear and Notion as prettier-clean portable documents', async (t) => {
  const dir = await temporary(t)
  await importPlugins(['linear', 'NOTION'], { output: dir })
  const plugins = await requireCatalogue(dir)
  assert.equal(plugins.length, 2)
  for (const plugin of plugins) {
    assert.deepEqual(data(plugin).signIn, ['cimd', 'dcr'])
    assert.deepEqual(data(plugin).accountTypes, ['personal', 'business'])
    assert.deepEqual(data(plugin).tools, {})
    assert.equal(data(plugin).verification, undefined)
    for (const name of ['plugin.json', 'mcp.json']) {
      const content = await readFile(join(plugin.folder, name), 'utf8')
      assert.equal(
        content,
        await format(content, {
          parser: 'json',
          semi: false,
          singleQuote: true,
          trailingComma: 'all',
        }),
      )
    }
  }
})
test('sign-in methods come from every discovery wording, else the sign_in column', () => {
  const methods = (notes: string, sign_in = 'oauth-cimd') =>
    recordedMethods({ name: 'Example', notes, sign_in } as Row)
  for (const [notes, expected] of [
    ['Discovery 2026-10-08: DCR yes, CIMD yes, S256.', ['cimd', 'dcr']],
    ['Discovery 2026-10-08: DCR yes, CIMD not advertised, S256.', ['dcr']],
    [
      'mcp.aircall.io answers with OAuth metadata (CIMD yes, DCR no).',
      ['cimd'],
    ],
    ['Metadata advertises both CIMD and DCR, S256.', ['cimd', 'dcr']],
    ['auth.atlassian.com advertises both DCR and CIMD, S256.', ['cimd', 'dcr']],
    ['auth.descript.com advertises DCR and CIMD with S256.', ['cimd', 'dcr']],
    ['Metadata advertises DCR, no CIMD, S256.', ['dcr']],
    ['Metadata advertises CIMD only (no DCR), S256.', ['cimd']],
    [
      'Authorization server advertises CIMD (no DCR), token auth none, S256.',
      ['cimd'],
    ],
    ['metadata advertises DCR, token auth none, S256.', ['dcr']],
    ['Sign-in through Adobe IMS with DCR and S256, free account.', ['dcr']],
    [
      'mcp.upwork.com advertises CIMD yes and a registration_endpoint at www.upwork.com/register (DCR unconfirmed), S256.',
      ['cimd'],
    ],
  ] as const)
    assert.deepEqual(methods(notes, 'none'), expected, notes)
  const guess =
    'Connects with plain OAuth and no client credentials, which suggests DCR; the metadata could not be read, so DCR is not confirmed.'
  assert.deepEqual(methods(guess, 'oauth-dcr'), ['dcr'])
  assert.deepEqual(methods(guess, 'oauth-cimd'), ['cimd'])
  assert.throws(() => methods(guess, 'none'), /Unknown sign-in method/)
})
test('imported discovery wordings give the advertised methods', async (t) => {
  const dir = await temporary(t)
  const expected = {
    linear: ['cimd', 'dcr'],
    notion: ['cimd', 'dcr'],
    folk: ['cimd', 'dcr'],
    sentry: ['cimd', 'dcr'],
    unsplash: ['cimd'],
    expensify: ['dcr'],
  }
  await importPlugins(Object.keys(expected), { output: dir })
  const plugins = await requireCatalogue(dir)
  assert.deepEqual(
    Object.fromEntries(plugins.map((p) => [p.manifest.name, data(p).signIn])),
    expected,
  )
})
test('any Atlassian product imports all four rows into one plugin', async (t) => {
  const dir = await temporary(t)
  await importPlugins(['Loom', 'Jira'], { output: dir })
  const [plugin] = await requireCatalogue(dir)
  assert.equal(plugin!.manifest.name, 'atlassian')
  assert.deepEqual(
    data(plugin!)
      .products.map((p) => p.name)
      .sort(),
    ['Bitbucket', 'Confluence', 'Jira', 'Loom'],
  )
  assert.ok(
    data(plugin!).products.every((p) => p.rank && p.research.sources.length),
  )
})
test('Adobe creative groups both rows while Acrobat stays separate', async (t) => {
  const dir = await temporary(t)
  await importPlugins(['Adobe Illustrator', 'Adobe Acrobat'], { output: dir })
  const plugins = await requireCatalogue(dir)
  const creative = plugins.find((p) => p.manifest.name === 'adobe-creative')!
  assert.deepEqual(
    data(creative).products.map((p) => p.name),
    ['Adobe Lightroom', 'Adobe Illustrator'],
  )
  assert.equal(
    data(plugins.find((p) => p.manifest.name === 'adobe-acrobat')!).products
      .length,
    1,
  )
})
test('SSE, all six templates, business-only, unknown and cost are faithfully recorded', async (t) => {
  const dir = await temporary(t)
  await importPlugins(
    [
      'Any.do',
      'Home Assistant',
      'Mattermost',
      'Aha!',
      'ActiveCampaign',
      'Retool',
      'Metabase',
    ],
    { output: dir },
  )
  const plugins = await requireCatalogue(dir)
  assert.equal(
    server(plugins.find((p) => p.manifest.name === 'any-do')!).type,
    'sse',
  )
  assert.equal(
    plugins.filter((p) => data(p).needsAddress && data(p).addressPrompt).length,
    6,
  )
  assert.equal(
    data(plugins.find((p) => p.manifest.name === 'activecampaign')!).cost,
    'user-paid-plan',
  )
  const rows = await readResearch()
  for (const account of ['business-only', 'unknown'] as const) {
    const row = rows.find((r) => r.accounts === account)!
    assert.deepEqual(
      documents([row]).manifest.extensions['app.kipster'].accountTypes,
      [account],
    )
  }
})
test('reimport keeps hand edits and probe byte-for-byte; force explicitly replaces them', async (t) => {
  const dir = await temporary(t)
  await importPlugins(['Linear'], { output: dir })
  const path = join(dir, 'linear', 'plugin.json')
  const manifest = JSON.parse(await readFile(path, 'utf8'))
  manifest.description = 'Hand edited'
  manifest.extensions['app.kipster'].probe = {
    result: 'unreachable',
    signIn: [],
    checkedOn: '2026-10-13',
    reason: 'Offline',
  }
  const edited = JSON.stringify(manifest, null, 4)
  await writeFile(path, edited)
  const messages = await importPlugins(['Linear'], { output: dir })
  assert.match(messages[0]!, /kept unchanged/)
  assert.equal(await readFile(path, 'utf8'), edited)
  await importPlugins(['Linear'], { output: dir, force: true })
  assert.notEqual(await readFile(path, 'utf8'), edited)
  assert.equal(data((await requireCatalogue(dir))[0]!).probe, undefined)
})
test('unknown service gives near matches, exits nonzero and makes no partial imports', async (t) => {
  const dir = await temporary(t)
  const result = await cli('src/importer/cli.ts', [
    '--output',
    dir,
    'Linear',
    'Notoin',
  ])
  assert.equal(result.code, 1)
  assert.match(result.output, /Unknown service "Notoin".*Notion/)
  assert.deepEqual(await readdir(dir), [])
})
test('all 275 research rows import to the batch catalogue without id collisions', async (t) => {
  const dir = await temporary(t)
  await importPlugins([], { output: dir, all: true })
  const plugins = await requireCatalogue(dir)
  assert.equal(plugins.length, 271)
  assert.equal(
    plugins.reduce((sum, p) => sum + data(p).products.length, 0),
    275,
  )
})
