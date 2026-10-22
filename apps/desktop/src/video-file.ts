import { randomUUID } from 'node:crypto'
import { type FileHandle, open, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { writeAtomic } from './project-dir'

// Video exports stream to disk as they encode, so a long 4K render never has
// to fit in memory. Chunks arrive with their file position (the MP4 header
// is patched at the end) and go into a .partial file that becomes the real
// file only when the export finishes.

interface OpenFile {
  handle: FileHandle
  target: string
  partial: string
}

export class VideoWriters {
  private readonly files = new Map<string, OpenFile>()

  async begin(target: string): Promise<string> {
    const partial = `${target}.partial`
    const handle = await open(partial, 'w')
    const id = randomUUID()
    this.files.set(id, { handle, target, partial })
    return id
  }

  async write(id: string, position: number, data: Uint8Array): Promise<void> {
    const file = this.require(id)
    if (!Number.isSafeInteger(position) || position < 0) throw new Error('Invalid write position.')
    await file.handle.write(data, 0, data.byteLength, position)
  }

  /** Closes the file, moves it into place, and writes text files (by base name only) beside it. */
  async finish(id: string, extras: { name: string; text: string }[] = []): Promise<string> {
    const file = this.require(id)
    this.files.delete(id)
    await file.handle.close()
    await rm(file.target, { force: true })
    await rename(file.partial, file.target)
    for (const extra of extras.slice(0, 4)) {
      const name = typeof extra?.name === 'string' ? basename(extra.name) : ''
      if (!/\.txt$/i.test(name) || typeof extra.text !== 'string') continue
      await writeAtomic(join(dirname(file.target), name), extra.text.slice(0, 200_000))
    }
    return file.target
  }

  async abort(id: string): Promise<void> {
    const file = this.files.get(id)
    if (!file) return
    this.files.delete(id)
    await file.handle.close().catch(() => undefined)
    await rm(file.partial, { force: true })
  }

  async abortAll(): Promise<void> {
    await Promise.all([...this.files.keys()].map((id) => this.abort(id)))
  }

  private require(id: string): OpenFile {
    const file = this.files.get(id)
    if (!file) throw new Error('This video export is no longer open.')
    return file
  }
}
