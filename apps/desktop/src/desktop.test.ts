import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDefaultProject, type DesktopAssetPayload, studio } from '@reborn/studio-core'
import { packProjectDirectory, readProjectPath, unpackProject, writeProjectDirectory } from './project-dir'
import { AUTOSAVE_LIMIT, SessionStore } from './session'
import { crc32, extractZip, readZipEntries, writeZip } from './zip'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'reborn-desktop-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const bytes = (...values: number[]) => new Uint8Array(values).buffer
const asset = (id: string, data: ArrayBuffer, name = `${id}.wav`): DesktopAssetPayload => ({ id, kind: 'sample', name, mimeType: 'audio/wav', data })

describe('zip', () => {
  it('computes the standard CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
  })

  it('round-trips files and reports byte progress', async () => {
    await writeFile(join(root, 'a.txt'), 'alpha')
    await writeFile(join(root, 'b.bin'), Buffer.from([1, 2, 3]))
    const progress: number[] = []
    const archive = join(root, 'out.zip')
    await writeZip(archive, [{ name: 'a.txt', file: join(root, 'a.txt') }, { name: 'nested/b.bin', file: join(root, 'b.bin') }], { onProgress: ({ completed }) => progress.push(completed) })
    expect((await readZipEntries(archive)).map((e) => e.name)).toEqual(['a.txt', 'nested/b.bin'])
    await extractZip(archive, join(root, 'x'))
    expect(await readFile(join(root, 'x', 'a.txt'), 'utf8')).toBe('alpha')
    expect([...(await readFile(join(root, 'x', 'nested', 'b.bin')))]).toEqual([1, 2, 3])
    expect(progress.at(-1)).toBe(8)
  })

  it('removes the partial file when cancelled', async () => {
    await writeFile(join(root, 'a.txt'), 'alpha')
    const controller = new AbortController()
    controller.abort()
    const archive = join(root, 'out.zip')
    await expect(writeZip(archive, [{ name: 'a.txt', file: join(root, 'a.txt') }], { signal: controller.signal })).rejects.toThrow(/cancelled/)
    expect(existsSync(archive) || existsSync(`${archive}.partial`)).toBe(false)
  })

  it('refuses entries that would escape the destination', async () => {
    await writeFile(join(root, 'evil.txt'), 'x')
    const archive = join(root, 'evil.zip')
    await writeZip(archive, [{ name: '../escaped.txt', file: join(root, 'evil.txt') }])
    await expect(extractZip(archive, join(root, 'dest'))).rejects.toThrow(/outside the project/)
    expect(existsSync(join(root, 'escaped.txt'))).toBe(false)
  })
})

describe('project directories', () => {
  it('keeps video stills and footage in the video folder', async () => {
    const directory = join(root, 'Video.reborn')
    const still: DesktopAssetPayload = { id: 'vfl_still', kind: 'video', name: 'Drop.png', mimeType: 'image/png', data: bytes(137, 80) }
    const clip: DesktopAssetPayload = { id: 'vfl_clip', kind: 'video', name: 'storm.mp4', mimeType: 'video/mp4', data: bytes(0, 0, 0, 24) }
    await writeProjectDirectory(directory, createDefaultProject(), [asset('s1', bytes(1)), still, clip], 'test')
    expect(existsSync(join(directory, 'video', 'vfl_still.png'))).toBe(true)
    expect(existsSync(join(directory, 'video', 'vfl_clip.mp4'))).toBe(true)
    const again = await writeProjectDirectory(directory, createDefaultProject(), [asset('s1', bytes(1)), still, clip], 'test')
    expect(again).toMatchObject({ writtenAssets: 0, reusedAssets: 3 })
    const opened = await readProjectPath(directory)
    expect(opened.assets.map((a) => [a.id, a.kind]).sort()).toEqual([['s1', 'sample'], ['vfl_clip', 'video'], ['vfl_still', 'video']])
  })

  it('saves, reopens, and skips rewriting unchanged audio', async () => {
    const project = createDefaultProject()
    project.name = 'DIR TEST'
    const directory = join(root, 'Dir Test.reborn')
    const first = await writeProjectDirectory(directory, project, [asset('s1', bytes(1, 2, 3))], '2.0.0-test')
    expect(first).toMatchObject({ writtenAssets: 1, reusedAssets: 0 })
    const before = (await stat(join(directory, 'assets', 's1.wav'))).mtimeMs

    const second = await writeProjectDirectory(directory, project, [asset('s1', bytes(1, 2, 3))], '2.0.0-test')
    expect(second).toMatchObject({ writtenAssets: 0, reusedAssets: 1 })
    expect((await stat(join(directory, 'assets', 's1.wav'))).mtimeMs).toBe(before)

    const opened = await readProjectPath(directory)
    expect(opened.document.project!.name).toBe('DIR TEST')
    expect(opened.assets.map((a) => [a.id, [...new Uint8Array(a.data)]])).toEqual([['s1', [1, 2, 3]]])
    expect(opened.missing).toEqual([])
  })

  it('keeps audio that is no longer referenced', async () => {
    const directory = join(root, 'Keep.reborn')
    await writeProjectDirectory(directory, createDefaultProject(), [asset('old', bytes(9))], 'test')
    await writeProjectDirectory(directory, createDefaultProject(), [], 'test')
    expect(existsSync(join(directory, 'assets', 'old.wav'))).toBe(true)
  })

  it('reports damaged or missing audio instead of loading it', async () => {
    const directory = join(root, 'Damaged.reborn')
    await writeProjectDirectory(directory, createDefaultProject(), [asset('a', bytes(1)), asset('b', bytes(2))], 'test')
    await writeFile(join(directory, 'assets', 'a.wav'), Buffer.from([7]))
    await rm(join(directory, 'assets', 'b.wav'))
    const opened = await readProjectPath(directory)
    expect(opened.assets).toEqual([])
    expect(opened.missing.sort()).toEqual(['a.wav', 'b.wav'])
  })

  it('opens a raw v1 export file', async () => {
    const file = join(root, 'old-web-edition.json')
    await writeFile(file, JSON.stringify(createDefaultProject()))
    const opened = await readProjectPath(file)
    expect(opened.path).toBe(file)
    expect(opened.document.app.version).toBe('1.x')
  })

  it('packs and unpacks next to the archive without overwriting', async () => {
    const directory = join(root, 'Pack Me.reborn')
    await writeProjectDirectory(directory, createDefaultProject(), [asset('p', bytes(4, 5))], 'test')
    const archive = join(root, 'Pack Me.rebornpack')
    await packProjectDirectory(directory, archive)
    const entries = (await readZipEntries(archive)).map((e) => e.name)
    expect(entries[0]).toBe('project.json')
    expect(entries).toContain('assets/p.wav')
    const unpacked = await unpackProject(archive)
    expect(unpacked).toBe(join(root, 'Pack Me 2.reborn'))
    expect((await readProjectPath(unpacked)).assets).toHaveLength(1)
  })

  it('refuses to pack a folder that was never saved', async () => {
    await mkdir(join(root, 'Empty.reborn'))
    await expect(packProjectDirectory(join(root, 'Empty.reborn'), join(root, 'e.rebornpack'))).rejects.toThrow(/Save the project/)
  })
})

describe('session store', () => {
  it('offers recovery only after an unclean shutdown', async () => {
    const first = new SessionStore(root)
    await first.start()
    await first.writeRecovery({ project: createDefaultProject() }, 'C:/beats/a.reborn')
    // No finish(): the process "crashed".
    const second = new SessionStore(root)
    await second.start()
    const recovered = await second.takeRecovery()
    expect(recovered?.path).toBe('C:/beats/a.reborn')
    expect(await second.takeRecovery()).toBeNull()
    await second.finish()

    const third = new SessionStore(root)
    await third.start()
    expect(await third.takeRecovery()).toBeNull()
    await third.finish()
  })

  it('keeps recent projects unique, newest first, and drops missing paths', async () => {
    const store = new SessionStore(root)
    await store.start()
    const a = join(root, 'A.reborn')
    const b = join(root, 'B.reborn')
    await mkdir(a)
    await mkdir(b)
    await store.addRecent(a, 'A')
    await store.addRecent(b, 'B')
    await store.addRecent(a, 'A again')
    expect((await store.listRecent()).map((r) => r.name)).toEqual(['A again', 'B'])
    await rm(b, { recursive: true })
    expect((await store.listRecent()).map((r) => r.name)).toEqual(['A again'])
    await store.finish()
  })

  it('keeps one autosave per project, newest first, through a clean shutdown', async () => {
    const store = new SessionStore(root)
    await store.start()
    const a = { ...studio.createDefaultStudioProject('A'), id: 'prj_a' }
    const b = { ...studio.createDefaultStudioProject('B'), id: 'prj_b' }
    await store.writeAutosave(a, null)
    await store.writeAutosave(b, 'C:/beats/B.reborn')
    await store.writeAutosave({ ...a, name: 'A edited' }, null)
    await store.finish()

    const next = new SessionStore(root)
    await next.start()
    const listed = await next.listAutosaves()
    expect(listed.map((e) => [e.id, e.name, e.path])).toEqual([
      ['prj_a', 'A edited', null],
      ['prj_b', 'B', 'C:/beats/B.reborn'],
    ])
    expect((await next.readAutosave('prj_b'))?.studio.name).toBe('B')
    expect(await next.readAutosave('../prj_b')).toBeNull()
    await next.deleteAutosave('prj_a')
    expect((await next.listAutosaves()).map((e) => e.id)).toEqual(['prj_b'])
    await next.finish()
  })

  it('prunes autosaves past the limit, oldest first', async () => {
    const store = new SessionStore(root)
    await store.start()
    for (let i = 0; i < AUTOSAVE_LIMIT + 3; i += 1) {
      await store.writeAutosave({ ...studio.createDefaultStudioProject(`P${i}`), id: `prj_${i}` }, null)
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    const listed = await store.listAutosaves()
    expect(listed).toHaveLength(AUTOSAVE_LIMIT)
    expect(listed.some((e) => e.id === 'prj_0')).toBe(false)
    await store.finish()
  })
})

describe('reborn command shim', () => {
  it('runs the bundled CLI with the app binary in Node mode', async () => {
    const { installCliShim, shimDirectory } = await import('./cli-shim')
    const dir = await mkdtemp(join(tmpdir(), 'reborn-shim-'))
    try {
      const target = await installCliShim(join(dir, 'bin'), 'C:\Apps\RE-BORN\RE-BORN.exe', 'C:\Apps\RE-BORN\resources\cli\reborn.mjs', 'win32')
      expect(target).toBe(join(dir, 'bin', 'reborn.cmd'))
      const text = await readFile(target, 'utf8')
      expect(text).toContain('set ELECTRON_RUN_AS_NODE=1')
      expect(text).toContain('"C:\Apps\RE-BORN\RE-BORN.exe" "C:\Apps\RE-BORN\resources\cli\reborn.mjs" %*')
      expect(shimDirectory({}, join(dir, 'fallback'), 'win32')).toEqual({ dir: join(dir, 'fallback'), onPath: false })
      await mkdir(join(dir, 'Microsoft', 'WindowsApps'), { recursive: true })
      expect(shimDirectory({ LOCALAPPDATA: dir }, 'x', 'win32')).toEqual({ dir: join(dir, 'Microsoft', 'WindowsApps'), onPath: true })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('writes an executable shell script on Linux', async () => {
    const { installCliShim, shimDirectory } = await import('./cli-shim')
    const dir = await mkdtemp(join(tmpdir(), 'reborn-shim-'))
    try {
      const target = await installCliShim(join(dir, 'bin'), "/opt/RE-BORN's/RE-BORN.AppImage", '/home/me/.config/RE-BORN/cli/reborn.mjs', 'linux')
      expect(target).toBe(join(dir, 'bin', 'reborn'))
      const text = await readFile(target, 'utf8')
      expect(text).toBe(`#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec '/opt/RE-BORN'\\''s/RE-BORN.AppImage' '/home/me/.config/RE-BORN/cli/reborn.mjs' --no-sandbox "$@"\n`)
      if (process.platform !== 'win32') expect((await stat(target)).mode & 0o777).toBe(0o755)
      expect(shimDirectory({}, 'fallback', 'linux')).toEqual({ dir: 'fallback', onPath: false })
      expect(shimDirectory({ HOME: '/home/me', PATH: '/usr/bin' }, 'x', 'linux')).toEqual({ dir: join('/home/me', '.local', 'bin'), onPath: false })
      expect(shimDirectory({ HOME: '/home/me', PATH: `/usr/bin:${join('/home/me', '.local', 'bin')}` }, 'x', 'linux').onPath).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
