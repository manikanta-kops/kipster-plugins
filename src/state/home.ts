import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  EncryptedSecretStore,
  FileKeyBackend,
  type KeyBackend,
  type SecretStore,
} from '../secrets/store.ts'

// Each entry upgrades the database by one version (PRAGMA user_version).
// Append new migrations; never edit a released one.
export const migrations: string[] = [
  `CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    plugin TEXT NOT NULL,
    issuer TEXT NOT NULL,
    subject TEXT NOT NULL,
    identity_source TEXT NOT NULL,
    label TEXT NOT NULL,
    server_url TEXT NOT NULL,
    oauth TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (plugin, issuer, subject)
  );
  CREATE UNIQUE INDEX accounts_label ON accounts (plugin, label COLLATE NOCASE);
  CREATE TABLE plugin_settings (
    plugin TEXT PRIMARY KEY,
    default_account TEXT REFERENCES accounts (id) ON DELETE SET NULL
  );
  CREATE TABLE secrets (name TEXT PRIMARY KEY, value BLOB NOT NULL);`,
]

export function migrate(db: DatabaseSync): number {
  const current = (
    db.prepare('PRAGMA user_version').get() as {
      user_version: number
    }
  ).user_version
  if (current > migrations.length)
    throw new Error('State database is newer than this plugin server')
  for (let version = current; version < migrations.length; version++) {
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(migrations[version]!)
      db.exec(`PRAGMA user_version = ${version + 1}`)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  return migrations.length
}

export interface Home {
  dir: string
  db: DatabaseSync
  secrets: SecretStore
  close(): void
}
// The home folder is always passed explicitly; nothing defaults to a real home.
export async function openHome(
  dir: string,
  options: { keyBackend: KeyBackend },
): Promise<Home> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await chmod(dir, 0o700)
  const path = join(dir, 'state.db')
  // Created private before SQLite opens it; journals inherit its mode.
  await writeFile(path, '', { flag: 'a', mode: 0o600 })
  await chmod(path, 0o600)
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA foreign_keys = ON')
    db.exec('PRAGMA busy_timeout = 5000')
    migrate(db)
  } catch (error) {
    db.close()
    throw error
  }
  return {
    dir,
    db,
    secrets: new EncryptedSecretStore(db, options.keyBackend),
    close: () => {
      if (db.isOpen) db.close()
    },
  }
}
// Test and development backend: the key lives in a file inside the home.
export const fileKeyBackend = (dir: string) =>
  new FileKeyBackend(join(dir, 'secret.key'))
