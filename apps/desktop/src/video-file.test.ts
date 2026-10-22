import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { VideoWriters } from './video-file'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'reborn-video-file-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('video writers', () => {
  it('writes chunks at their positions and moves the file into place with its extras', async () => {
    const writers = new VideoWriters()
    const target = join(root, 'song.mp4')
    const id = await writers.begin(target)
    await writers.write(id, 4, new Uint8Array([5, 6, 7]))
    // The header is patched last, at the start of the file.
    await writers.write(id, 0, new Uint8Array([1, 2, 3, 4]))
    expect(existsSync(target)).toBe(false)
    expect(await writers.finish(id, [{ name: '../escape.txt', text: 'chapters' }, { name: 'bad.exe', text: 'x' }])).toBe(target)
    expect([...(await readFile(target))]).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(await readFile(join(root, 'escape.txt'), 'utf8')).toBe('chapters')
    expect(existsSync(join(root, 'bad.exe'))).toBe(false)
    expect(existsSync(`${target}.partial`)).toBe(false)
  })

  it('removes the partial file when an export is abandoned', async () => {
    const writers = new VideoWriters()
    const target = join(root, 'cancelled.mp4')
    const id = await writers.begin(target)
    await writers.write(id, 0, new Uint8Array([1]))
    await writers.abort(id)
    expect(existsSync(`${target}.partial`) || existsSync(target)).toBe(false)
    await expect(writers.write(id, 0, new Uint8Array([1]))).rejects.toThrow(/no longer open/)
  })
})
