import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DeepAnalysis, type DeepJobUpdate } from './deep-analysis'
import { SidecarError } from './sidecar'

type Request = (method: string, params: Record<string, unknown>, options: { onProgress?: (p: { completed: number; total: number; message?: string }) => void }) => Promise<unknown>

let root: string
let updates: DeepJobUpdate[]

function deepWith(request: Request): DeepAnalysis {
  const deep = new DeepAnalysis({ sidecarDir: root, dataDir: root, log: () => undefined, onJob: (update) => updates.push(update) })
  // A running supervisor skips the Python startup, so only `request` runs.
  Object.assign(deep, { supervisor: { status: 'ready', request, stop: async () => undefined } })
  return deep
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'reborn-deep-'))
  updates = []
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('DeepAnalysis jobs', () => {
  it('ends a generate request with a done update under its own job id', async () => {
    const wav = join(root, 'out.wav')
    await writeFile(wav, new Uint8Array([1, 2, 3]))
    const deep = deepWith(async (_method, _params, { onProgress }) => {
      onProgress?.({ completed: 1, total: 2, message: 'Ismail: done' })
      return { path: wav, name: 'Pad', summary: '', description: '' }
    })
    const sound = await deep.generate({ name: 'Pad', instrument: 'pad', notes: 'C4', bpm: 120 } as never)
    expect(sound.wav).toEqual(new Uint8Array([1, 2, 3]))
    expect(updates.map((u) => [u.id, u.status])).toEqual([
      ['ismail-generate', 'running'],
      ['ismail-generate', 'running'],
      ['ismail-generate', 'done'],
    ])
  })

  it('ends a failed request with a failed update', async () => {
    const deep = deepWith(async () => {
      throw new SidecarError('backend_error', 'Demucs failed')
    })
    await expect(deep.separate(new Uint8Array([0]))).rejects.toThrow('Demucs failed')
    expect(updates.at(-1)).toMatchObject({ id: 'ismail-separate', status: 'failed', message: 'Demucs failed' })
  })

  it('ends a cancelled request with a cancelled update', async () => {
    const deep = deepWith(async () => {
      throw new SidecarError('cancelled', 'The analyze request was cancelled.')
    })
    await expect(deep.analyze(new Uint8Array([0]), [])).rejects.toThrow('cancelled')
    expect(updates.at(-1)).toMatchObject({ id: 'deep-analysis', status: 'cancelled' })
  })
})
