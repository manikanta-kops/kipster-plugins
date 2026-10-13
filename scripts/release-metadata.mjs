// Writes release.json for the files in a directory, in the format Kipster's
// update channels read: { schemaVersion, package, version, files }.
//   node scripts/release-metadata.mjs <dir>
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2]
if (!dir) throw new Error('Usage: node scripts/release-metadata.mjs <dir>')
const { name, version } = JSON.parse(readFileSync('package.json', 'utf8'))
const files = readdirSync(dir)
  .filter((file) => file !== 'release.json')
  .sort()
  .map((file) => {
    const bytes = readFileSync(join(dir, file))
    return {
      name: file,
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }
  })
if (files.length !== 1 || !files[0].name.endsWith('.tgz'))
  throw new Error(`Expected exactly one package tarball in ${dir}`)
const metadata = { schemaVersion: 1, package: name, version, files }
writeFileSync(
  join(dir, 'release.json'),
  JSON.stringify(metadata, null, 2) + '\n',
)
console.log(JSON.stringify(metadata))
