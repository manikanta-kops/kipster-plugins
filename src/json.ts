import { rename, writeFile, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { format, type Options } from 'prettier'
import options from '../.prettierrc.json' with { type: 'json' }
export async function writeJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(
      temporary,
      await format(JSON.stringify(value), {
        ...(options as Options),
        parser: 'json',
      }),
    )
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}
