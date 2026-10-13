import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// The bearer token for /v1 and /mcp: KIPSTER_PLUGINS_TOKEN, otherwise 256
// random bits stored once in <home>/token (0600) and reused. Never argv.
export async function loadToken(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const given = env.KIPSTER_PLUGINS_TOKEN
  if (given !== undefined && given !== '') {
    if (given.length < 16 || /\s/.test(given))
      throw new Error(
        'KIPSTER_PLUGINS_TOKEN must have at least 16 characters and no spaces',
      )
    return given
  }
  const path = join(home, 'token')
  try {
    const stored = (await readFile(path, 'utf8')).trim()
    if (stored) {
      await chmod(path, 0o600)
      return stored
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const token = randomBytes(32).toString('base64url')
  await writeFile(path, `${token}\n`, { mode: 0o600 })
  await chmod(path, 0o600)
  return token
}
const digest = (value: string) => createHash('sha256').update(value).digest()
// Constant time whatever the lengths: compares fixed-size digests.
export function tokenMatches(header: string | undefined, token: string) {
  const match = /^Bearer (\S+)$/i.exec(header ?? '')
  return timingSafeEqual(digest(match?.[1] ?? ''), digest(token)) && !!match
}
