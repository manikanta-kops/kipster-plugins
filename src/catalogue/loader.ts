import { watch, type FSWatcher } from 'node:fs'
import { EventEmitter } from 'node:events'
import { readCatalogue, duplicateErrors } from './validate.ts'
import { data, type Plugin } from './types.ts'

// Watches the root and each plugin root, including on Linux (no recursive watch needed).
export class Catalogue extends EventEmitter {
  readonly directory: string
  readonly debounceMs: number
  #current = new Map<string, Plugin>()
  #watchers = new Map<string, FSWatcher>()
  #timer?: NodeJS.Timeout
  #closed = false
  #loading = false
  #pending = false
  constructor(directory: string, debounceMs = 50) {
    super()
    this.directory = directory
    this.debounceMs = debounceMs
  }
  get plugins(): ReadonlyMap<string, Plugin> {
    return new Map(
      [...this.#current.values()].map((p) => [data(p).id, structuredClone(p)]),
    )
  }
  async start(): Promise<this> {
    this.#watch(this.directory)
    await this.reload()
    return this
  }
  #watch(path: string): void {
    if (this.#watchers.has(path) || this.#closed) return
    try {
      const watcher = watch(path, () => this.#schedule())
      watcher.on('error', () => {
        this.emit('invalid', { folder: path, reason: 'Catalogue watch failed' })
        watcher.close()
        this.#watchers.delete(path)
        this.#schedule()
      })
      this.#watchers.set(path, watcher)
    } catch {
      this.emit('invalid', {
        folder: path,
        reason: 'Cannot watch catalogue path',
      })
    }
  }
  #schedule(): void {
    if (this.#closed) return
    clearTimeout(this.#timer)
    this.#timer = setTimeout(() => {
      void this.reload()
    }, this.debounceMs)
  }
  async reload(): Promise<void> {
    if (this.#closed) return
    if (this.#loading) {
      this.#pending = true
      return
    }
    this.#loading = true
    try {
      const result = await readCatalogue(this.directory)
      if (this.#closed) return
      const next = result.plugins
      for (const [folder, reason] of result.errors) {
        this.emit('invalid', { folder, reason })
        const prior = this.#current.get(folder)
        if (prior) next.set(folder, prior)
      }
      // A valid update can collide with a retained invalid folder's last good name.
      let conflicts = duplicateErrors([...next.values()])
      while (conflicts.size) {
        for (const folder of conflicts) {
          this.emit('invalid', {
            folder,
            reason: 'Duplicate plugin id or display name',
          })
          const prior = this.#current.get(folder)
          if (prior) next.set(folder, prior)
          else next.delete(folder)
        }
        conflicts = duplicateErrors([...next.values()])
      }
      this.#current = next
      // Refresh directory watches as folders may have been atomically replaced.
      for (const [path, watcher] of this.#watchers)
        if (path !== this.directory) {
          watcher.close()
          this.#watchers.delete(path)
        }
      this.#watch(this.directory)
      for (const path of result.folders) this.#watch(path)
      this.emit('change', this.plugins)
    } catch (error) {
      this.emit('invalid', {
        folder: this.directory,
        reason:
          error instanceof Error ? error.message : 'Cannot load catalogue',
      })
    } finally {
      this.#loading = false
      if (this.#pending) {
        this.#pending = false
        this.#schedule()
      }
    }
  }
  close(): void {
    this.#closed = true
    clearTimeout(this.#timer)
    for (const watcher of this.#watchers.values()) watcher.close()
    this.#watchers.clear()
  }
}
