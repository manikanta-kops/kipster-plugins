import { spawn } from 'node:child_process'
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'
import { link, readFile, rm, writeFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'

// Values are opaque strings; callers serialize. Values never appear in errors.
export interface SecretStore {
  get(name: string): Promise<string | undefined>
  set(name: string, value: string): Promise<void>
  delete(name: string): Promise<void>
}
// Holds the 32-byte AES-256-GCM key that encrypts every stored secret.
export interface KeyBackend {
  key(): Promise<Buffer>
}

export class FileKeyBackend implements KeyBackend {
  readonly path: string
  #key?: Promise<Buffer>
  constructor(path: string) {
    this.path = path
  }
  key(): Promise<Buffer> {
    this.#key ??= this.#load().catch((error: unknown) => {
      this.#key = undefined
      throw error
    })
    return this.#key
  }
  async #load(): Promise<Buffer> {
    // Written in full to a private temporary file, then linked into place:
    // a crash or a concurrent reader never sees a partial key.
    const temporary = `${this.path}.${randomBytes(8).toString('hex')}.tmp`
    const key = randomBytes(32)
    try {
      await writeFile(temporary, key.toString('base64'), {
        mode: 0o600,
        flag: 'wx',
      })
      await link(temporary, this.path)
      return key
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    } finally {
      await rm(temporary, { force: true })
    }
    return checkedKey(await readFile(this.path, 'utf8'))
  }
}

export type CommandRunner = (
  command: string,
  args: string[],
  input?: string,
) => Promise<{ code: number; stdout: string }>
export const runCommand: CommandRunner = (command, args, input) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'] })
    let stdout = ''
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? 1, stdout }))
    child.stdin.end(input ?? '')
  })
const keychainName = /^[A-Za-z0-9._-]+$/
// macOS keychain item holding the key. The key is written through `security -i`
// on standard input so it never appears in a process argument list.
export class KeychainKeyBackend implements KeyBackend {
  readonly service: string
  readonly account: string
  readonly #run: CommandRunner
  #key?: Promise<Buffer>
  constructor(
    options: { service?: string; account?: string; run?: CommandRunner } = {},
  ) {
    this.service = options.service ?? 'app.kipster.plugins'
    this.account = options.account ?? 'secret-store-key'
    if (!keychainName.test(this.service) || !keychainName.test(this.account))
      throw new Error('Keychain service and account must be simple names')
    this.#run = options.run ?? runCommand
  }
  key(): Promise<Buffer> {
    this.#key ??= this.#load().catch((error: unknown) => {
      this.#key = undefined
      throw error
    })
    return this.#key
  }
  async #load(): Promise<Buffer> {
    const found = await this.#run('security', [
      'find-generic-password',
      '-s',
      this.service,
      '-a',
      this.account,
      '-w',
    ])
    if (found.code === 0) return checkedKey(found.stdout)
    // 44: the specified item could not be found in the keychain.
    if (found.code !== 44)
      throw new Error(`Keychain lookup failed with exit code ${found.code}`)
    const key = randomBytes(32)
    const added = await this.#run(
      'security',
      ['-i'],
      `add-generic-password -U -s ${this.service} -a ${this.account} -w ${key.toString('base64')}\n`,
    )
    if (added.code !== 0)
      throw new Error(`Keychain update failed with exit code ${added.code}`)
    return key
  }
}
function checkedKey(encoded: string): Buffer {
  const key = Buffer.from(encoded.trim(), 'base64')
  if (key.length !== 32) throw new Error('Secret store key is invalid')
  return key
}

const version = Buffer.from([1])
// AES-256-GCM rows in the state database: version, 12-byte IV, 16-byte tag,
// ciphertext. The secret name is authenticated data, so rows cannot be swapped.
export class EncryptedSecretStore implements SecretStore {
  readonly #db: DatabaseSync
  readonly #backend: KeyBackend
  constructor(db: DatabaseSync, backend: KeyBackend) {
    this.#db = db
    this.#backend = backend
  }
  async get(name: string): Promise<string | undefined> {
    const key = await this.#backend.key()
    const row = this.#db
      .prepare('SELECT value FROM secrets WHERE name = ?')
      .get(name) as { value: Uint8Array } | undefined
    if (!row) return undefined
    const value = Buffer.from(row.value)
    if (value.length < 29 || !timingSafeEqual(value.subarray(0, 1), version))
      throw new Error('Stored secret has an unknown format')
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        value.subarray(1, 13),
      )
      decipher.setAAD(Buffer.from(name))
      decipher.setAuthTag(value.subarray(13, 29))
      return Buffer.concat([
        decipher.update(value.subarray(29)),
        decipher.final(),
      ]).toString('utf8')
    } catch {
      throw new Error('Stored secret could not be decrypted')
    }
  }
  async set(name: string, value: string): Promise<void> {
    const key = await this.#backend.key()
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(Buffer.from(name))
    const encrypted = Buffer.concat([
      cipher.update(value, 'utf8'),
      cipher.final(),
    ])
    this.#db
      .prepare(
        'INSERT INTO secrets (name, value) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value',
      )
      .run(name, Buffer.concat([version, iv, cipher.getAuthTag(), encrypted]))
  }
  async delete(name: string): Promise<void> {
    this.#db.prepare('DELETE FROM secrets WHERE name = ?').run(name)
  }
}
