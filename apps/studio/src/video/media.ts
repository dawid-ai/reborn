import { studio } from '@reborn/studio-core'
import { FootageDecoder } from '@reborn/video'
import { getAsset, putAsset } from '../platform/assetStore'
import { type DispatchOptions, dispatch } from '../state/store'

// Video files (stills, contact sheets, footage) keep their bytes in the same
// store as audio, so they reopen in the browser and are written into the
// project's video folder when the desktop app saves.

/** One decoder shared by the preview, stills, and exports. */
export const footage = new FootageDecoder(async (fileId) => (await getAsset(fileId))?.data ?? null)

const urls = new Map<string, string>()

/** An object URL for showing a stored still or thumbnail; null until its bytes are available. */
export async function videoFileUrl(fileId: string): Promise<string | null> {
  const cached = urls.get(fileId)
  if (cached) return cached
  const stored = await getAsset(fileId)
  if (!stored) return null
  const url = URL.createObjectURL(stored.data)
  urls.set(fileId, url)
  return url
}

/** Stores a still or contact sheet and adds it to a storyboard. Returns the file ID. */
export async function storeStill(blob: Blob, meta: { storyboardId: string; kind: 'still' | 'sheet'; name: string; width: number; height: number; seconds: number | null }, history: DispatchOptions = {}): Promise<string | null> {
  const id = studio.newId('vfl')
  await putAsset({ id, name: meta.name, mimeType: blob.type || 'image/png', data: blob })
  const file = { id, kind: meta.kind, name: meta.name, mimeType: blob.type || 'image/png', bytes: blob.size, width: meta.width, height: meta.height, duration: 0, seconds: meta.seconds, createdAt: new Date().toISOString() }
  const results = dispatch({ type: 'video.file.add', params: { storyboardId: meta.storyboardId, file } }, { label: meta.kind === 'sheet' ? 'Add contact sheet' : 'Add still', ...history })
  return results ? id : null
}

/** Stores downloaded footage and registers it on its clip. */
export async function storeFootage(clipId: string, blob: Blob, meta: { name: string; width: number; height: number; duration: number }, history: DispatchOptions = {}): Promise<string | null> {
  const id = studio.newId('vfl')
  await putAsset({ id, name: meta.name, mimeType: blob.type || 'video/mp4', data: blob })
  const file = { id, kind: 'footage', name: meta.name, mimeType: blob.type || 'video/mp4', bytes: blob.size, width: meta.width, height: meta.height, duration: meta.duration, seconds: null, createdAt: new Date().toISOString() }
  const results = dispatch({ type: 'video.footage.fetched', params: { clipId, file } }, { label: 'Add footage', ...history })
  return results ? id : null
}
