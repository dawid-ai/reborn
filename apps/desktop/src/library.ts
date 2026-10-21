import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { studio } from '@reborn/studio-core'
import { writeAtomic } from './project-dir'

// The Visual Library on disk: one JSON file per item and footage files
// beside them, in the app's user data. Items are versioned; saving an
// existing item bumps its version so storyboards that pinned the old one
// can tell.

type LibraryItem = studio.LibraryItem

const ID = /^[a-z0-9][a-z0-9_-]{0,80}$/i
const FOOTAGE_TYPES: Record<string, string> = { 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov' }
/** Item JSON stays small; previews are thumbnails. */
const MAX_ITEM_BYTES = 2_000_000

export class LibraryStore {
  private readonly items: string
  private readonly footage: string

  constructor(directory: string) {
    this.items = join(directory, 'library', 'items')
    this.footage = join(directory, 'library', 'footage')
  }

  async list(): Promise<LibraryItem[]> {
    if (!existsSync(this.items)) return []
    const items: LibraryItem[] = []
    for (const name of await readdir(this.items)) {
      if (!name.endsWith('.json')) continue
      try {
        items.push(JSON.parse(await readFile(join(this.items, name), 'utf8')) as LibraryItem)
      } catch {
        // A damaged item is skipped, not deleted.
      }
    }
    return items.sort((a, z) => z.updatedAt.localeCompare(a.updatedAt))
  }

  /** Saves an item. Updating an existing one bumps its version; footage bytes are stored beside it. */
  async save(input: LibraryItem, footage: ArrayBuffer | null): Promise<LibraryItem> {
    if (!input || typeof input !== 'object' || !ID.test(String(input.id))) throw new Error('A library item needs a simple id.')
    if (!['preset', 'template', 'footage'].includes(input.kind)) throw new Error('A library item is a preset, a template, or footage.')
    if (input.builtin) throw new Error('Built-in items cannot be saved.')
    await mkdir(this.items, { recursive: true })
    const file = join(this.items, `${input.id}.json`)
    const previous = existsSync(file) ? (JSON.parse(await readFile(file, 'utf8')) as LibraryItem) : null
    const now = new Date().toISOString()
    let item: LibraryItem = { ...input, version: previous ? previous.version + 1 : 1, createdAt: previous?.createdAt ?? now, updatedAt: now }
    if (item.kind === 'footage') {
      if (!item.footage) throw new Error('A footage item needs its clip details.')
      const extension = FOOTAGE_TYPES[item.footage.mimeType]
      if (!extension) throw new Error(`${item.footage.mimeType} is not a supported footage type.`)
      if (footage) {
        const bytes = new Uint8Array(footage)
        const name = `${item.id}${extension}`
        await mkdir(this.footage, { recursive: true })
        await writeAtomic(join(this.footage, name), bytes)
        item = { ...item, footage: { ...item.footage, file: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } }
      } else if (!previous?.footage?.file) throw new Error('New footage items need the clip file.')
      else item = { ...item, footage: { ...item.footage, file: previous.footage.file, bytes: previous.footage.bytes, sha256: previous.footage.sha256 } }
    }
    const json = JSON.stringify(item, null, 2)
    if (json.length > MAX_ITEM_BYTES) throw new Error('The library item is too large. Use a smaller preview.')
    await writeAtomic(file, json)
    return item
  }

  async remove(id: string): Promise<void> {
    if (!ID.test(String(id))) throw new Error('Unknown library item.')
    const file = join(this.items, `${id}.json`)
    if (!existsSync(file)) return
    const item = JSON.parse(await readFile(file, 'utf8')) as LibraryItem
    await rm(file, { force: true })
    if (item.footage?.file) await rm(join(this.footage, item.footage.file), { force: true })
  }

  async readFootage(id: string): Promise<ArrayBuffer | null> {
    if (!ID.test(String(id))) return null
    const file = join(this.items, `${id}.json`)
    if (!existsSync(file)) return null
    const item = JSON.parse(await readFile(file, 'utf8')) as LibraryItem
    if (!item.footage?.file || !/^[\w.-]+$/.test(item.footage.file)) return null
    const bytes = await readFile(join(this.footage, item.footage.file))
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  }
}
