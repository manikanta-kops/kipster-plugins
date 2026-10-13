import { watch, type FSWatcher } from 'node:fs'
import { stat } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { readCatalogue, duplicateErrors } from './validate.ts'
import { data, type Plugin } from './types.ts'

// Watches the root and each plugin root, including on Linux (no recursive watch needed).
export class Catalogue extends EventEmitter {
  readonly directory: string
  readonly debounceMs: number
  readonly reconcileMs: number
  #current = new Map<string, Plugin>()
  #watchers = new Map<string, FSWatcher>()
  #identities = new Map<string, string>()
  #timer?: NodeJS.Timeout
  #reconcile?: NodeJS.Timeout
  #closed = false
  #loading = false
  #pending = false
  constructor(directory: string, debounceMs = 50, reconcileMs = 1000) {
    super()
    this.directory = directory
    this.debounceMs = debounceMs
    this.reconcileMs = reconcileMs
  }
  get plugins(): ReadonlyMap<string, Plugin> {
    return new Map(
      [...this.#current.values()].map((p) => [data(p).id, structuredClone(p)]),
    )
  }
  async start(): Promise<this> {
    this.#watch(this.directory)
    await this.reload()
    // Filesystem notifications can be coalesced or lost, especially on replacement.
    // Reconcile periodically as well, so a missed event cannot leave stale plugins.
    if (!this.#closed && !this.#reconcile) {
      this.#reconcile = setInterval(() => {
        void this.reload()
      }, this.reconcileMs)
      this.#reconcile.unref()
    }
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
      // Keep watches unless a directory was removed or its inode changed.
      // Replacing every watcher creates a gap that can lose atomic file updates.
      const desired = new Set([this.directory, ...result.folders])
      for (const [path, watcher] of this.#watchers)
        if (!desired.has(path)) {
          watcher.close()
          this.#watchers.delete(path)
          this.#identities.delete(path)
        }
      for (const path of desired) {
        try {
          const info = await stat(path, { bigint: true })
          const identity = `${info.dev}:${info.ino}`
          const previous = this.#identities.get(path)
          if (previous && previous !== identity) {
            this.#watchers.get(path)?.close()
            this.#watchers.delete(path)
          }
          this.#identities.set(path, identity)
          this.#watch(path)
        } catch {
          this.#schedule()
        }
      }
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
    clearInterval(this.#reconcile)
    for (const watcher of this.#watchers.values()) watcher.close()
    this.#watchers.clear()
    this.#identities.clear()
  }
}
