import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { studio } from '@reborn/studio-core'
import { LibraryStore } from './library'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'reborn-library-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const preset = (id: string): studio.LibraryItem => ({
  id,
  kind: 'preset',
  name: 'Dark vein drop',
  version: 0,
  fits: ['drop'],
  tags: ['dark'],
  description: '',
  builtin: false,
  createdAt: '',
  updatedAt: '',
  source: null,
  preview: '',
  pending: null,
  preset: { look: 'vein-tunnel', params: {}, layers: [], post: { bloom: 0.5 }, travel: { base: 0.5, kick: 1.8, snare: 1, bass: 0.6 }, cutOn: [], xfade: 0 },
})

describe('library store', () => {
  it('saves items, bumps the version on update, and lists newest first', async () => {
    const store = new LibraryStore(root)
    expect(await store.list()).toEqual([])
    const first = await store.save(preset('lib_a'), null)
    expect(first.version).toBe(1)
    const second = await store.save({ ...first, name: 'Darker vein drop' }, null)
    expect(second).toMatchObject({ version: 2, createdAt: first.createdAt, name: 'Darker vein drop' })
    await store.save(preset('lib_b'), null)
    expect((await store.list()).map((i) => i.id)).toEqual(['lib_b', 'lib_a'])
  })

  it('keeps footage files beside items and removes them together', async () => {
    const store = new LibraryStore(root)
    const footage: studio.LibraryItem = {
      ...preset('lib_clip'),
      kind: 'footage',
      preset: undefined,
      footage: { provider: 'pexels', sourceId: '1', title: 'Storm', page: 'https://www.pexels.com/video/1/', author: 'A', licence: 'pexels', licenceName: 'Pexels License', licenceUrl: '', thumbnail: '', url: 'https://videos.pexels.com/1.mp4', width: 1920, height: 1080, duration: 12, skip: 0, tags: [], file: '', mimeType: 'video/mp4', bytes: 0, sha256: '' },
    }
    await expect(store.save(footage, null)).rejects.toThrow(/need the clip file/)
    const saved = await store.save(footage, new Uint8Array([1, 2, 3]).buffer)
    expect(saved.footage).toMatchObject({ file: 'lib_clip.mp4', bytes: 3 })
    expect([...new Uint8Array((await store.readFootage('lib_clip'))!)]).toEqual([1, 2, 3])
    await store.remove('lib_clip')
    expect(existsSync(join(root, 'library', 'footage', 'lib_clip.mp4'))).toBe(false)
  })

  it('refuses unsafe ids and built-in items', async () => {
    const store = new LibraryStore(root)
    await expect(store.save(preset('../escape'), null)).rejects.toThrow(/simple id/)
    await expect(store.save({ ...preset('lib_x'), builtin: true }, null)).rejects.toThrow(/Built-in/)
    expect(await store.readFootage('../../etc')).toBeNull()
  })
})
