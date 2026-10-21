import { useSyncExternalStore } from 'react'
import { studio } from '@reborn/studio-core'
import { Timeline, renderStills } from '@reborn/video'
import { getAsset, putAsset } from '../platform/assetStore'
import { desktop } from '../platform/desktop'
import { type DispatchOptions, dispatch, getState, toast } from '../state/store'
import { getAnalysis, isAnalysisCurrent } from './session'

type LibraryItem = studio.LibraryItem

// The Visual Library in the studio: built-in presets and a template that
// ship with the app, plus the user's own items, which the desktop app keeps
// in its user data (the browser edition keeps them in IndexedDB). Applying
// an item copies its values and pins its version, so later edits to the
// library never change a saved video.

interface Backend {
  list(): Promise<LibraryItem[]>
  save(item: LibraryItem, footage?: ArrayBuffer): Promise<LibraryItem>
  remove(id: string): Promise<void>
  readFootage(id: string): Promise<ArrayBuffer | null>
}

const DB = 'reborn-library'

function idb<T>(mode: IDBTransactionMode, store: 'items' | 'footage', action: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1)
    open.onupgradeneeded = () => {
      open.result.createObjectStore('items', { keyPath: 'id' })
      open.result.createObjectStore('footage')
    }
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const tx = open.result.transaction(store, mode)
      const request = action(tx.objectStore(store))
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
      tx.oncomplete = () => open.result.close()
    }
  })
}

const browserBackend: Backend = {
  list: async () => ((await idb<LibraryItem[]>('readonly', 'items', (s) => s.getAll())) ?? []).sort((a, z) => z.updatedAt.localeCompare(a.updatedAt)),
  async save(item, footage) {
    const previous = await idb<LibraryItem | undefined>('readonly', 'items', (s) => s.get(item.id))
    const now = new Date().toISOString()
    const saved = { ...item, version: previous ? previous.version + 1 : 1, createdAt: previous?.createdAt ?? now, updatedAt: now }
    if (footage) await idb('readwrite', 'footage', (s) => s.put(footage, item.id))
    await idb('readwrite', 'items', (s) => s.put(saved))
    return saved
  },
  async remove(id) {
    await idb('readwrite', 'items', (s) => s.delete(id))
    await idb('readwrite', 'footage', (s) => s.delete(id))
  },
  readFootage: async (id) => (await idb<ArrayBuffer | undefined>('readonly', 'footage', (s) => s.get(id))) ?? null,
}

const backend: Backend = desktop
  ? { list: () => desktop!.libraryList(), save: (item, footage) => desktop!.librarySave(item, footage), remove: (id) => desktop!.libraryRemove(id), readFootage: (id) => desktop!.libraryReadFootage(id) }
  : browserBackend

// Built-in items -----------------------------------------------------------------

const ROLE_NAMES: Record<studio.SectionRole, string> = { intro: 'Intro', build: 'Build', drop: 'Drop', switch: 'Switch', bridge: 'Bridge', outro: 'Outro', other: 'Any section' }
const DROP_NAMES = ['Vein Tunnel', 'Neon Kaleido', 'Grid Tunnel', 'Acid Vortex']

function builtinPreset(role: studio.SectionRole, variant = 0): LibraryItem {
  const { start: _start, clips: _clips, clipOrder: _order, clipStart: _clipStart, clipSpeed: _speed, preset: _preset, ...rest } = studio.presetScene(role, studio.songStart(), variant)
  const name = role === 'drop' ? `Drop: ${DROP_NAMES[variant]}` : ROLE_NAMES[role]
  const descriptions: Record<studio.SectionRole, string> = {
    intro: 'A slowly drifting Julia fractal with sparkles that grow with the hats.',
    build: 'Dives into a fractal, strobes faster through the riser, and whites out into the impact.',
    drop: 'Hits hard on the impact: mostly black with bright accents, lunging on kicks and snares.',
    switch: 'Hard-cuts between graphics on every kick and snare.',
    bridge: 'A slow kaleidoscope mandala with long trails and a waveform ring.',
    outro: 'A wide, slow fractal that calms down as the song ends.',
    other: 'A kaleidoscope that turns with the beat.',
  }
  return {
    id: `builtin-${role}${role === 'drop' ? `-${variant}` : ''}`,
    kind: 'preset',
    name,
    version: 1,
    fits: [role],
    tags: [],
    description: descriptions[role],
    builtin: true,
    createdAt: '',
    updatedAt: '',
    source: null,
    preview: '',
    pending: null,
    preset: rest,
  }
}

export const BUILTIN_ITEMS: readonly LibraryItem[] = (() => {
  const presets = [builtinPreset('intro'), builtinPreset('build'), ...[0, 1, 2, 3].map((v) => builtinPreset('drop', v)), builtinPreset('switch'), builtinPreset('bridge'), builtinPreset('outro'), builtinPreset('other')]
  const roles: Partial<Record<studio.SectionRole, studio.ScenePreset[]>> = {}
  for (const item of presets) for (const role of item.fits) (roles[role] ??= []).push(item.preset!)
  const template: LibraryItem = {
    id: 'builtin-template-dark-drops',
    kind: 'template',
    name: 'Dark drops',
    version: 1,
    fits: [],
    tags: ['edm', 'bass'],
    description: 'One scene per section: drifting intros, diving builds that white out into the drop, a different heavy look for each drop, strobing switches, and kaleidoscope bridges.',
    builtin: true,
    createdAt: '',
    updatedAt: '',
    source: null,
    preview: '',
    pending: null,
    template: { roles, text: [], fade: studio.DEFAULT_FADE, impact: { flash: 1.2, ca: 0.02, shake: 0.02 } },
  }
  return [...presets, template]
})()

// State ----------------------------------------------------------------------------

let items: LibraryItem[] = [...BUILTIN_ITEMS]
let loaded = false
const listeners = new Set<() => void>()
const notify = () => listeners.forEach((l) => l())

export function useLibrary(): LibraryItem[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      if (!loaded) void refreshLibrary()
      return () => {
        listeners.delete(listener)
      }
    },
    () => items,
  )
}

export async function refreshLibrary(): Promise<LibraryItem[]> {
  loaded = true
  try {
    items = [...(await backend.list()), ...BUILTIN_ITEMS]
  } catch {
    items = [...BUILTIN_ITEMS]
  }
  notify()
  return items
}

export const libraryItem = (id: string) => items.find((item) => item.id === id)

/** Items matching a text query, kind, and section role, best matches first. */
export function searchLibrary(query: { text?: string; kind?: studio.LibraryKind; fits?: studio.SectionRole }): LibraryItem[] {
  const words = (query.text ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  return items
    .filter((item) => !item.pending && (!query.kind || item.kind === query.kind) && (!query.fits || item.fits.includes(query.fits)))
    .map((item) => {
      const hay = [item.name, item.description, ...item.tags, ...item.fits, item.preset?.look ?? ''].join(' ').toLowerCase()
      return { item, score: words.filter((w) => hay.includes(w)).length }
    })
    .filter((entry) => !words.length || entry.score > 0)
    .sort((a, z) => z.score - a.score)
    .map((entry) => entry.item)
}

// Previews ---------------------------------------------------------------------------

const previews = new Map<string, Promise<string>>()

async function toJpegDataUrl(blob: Blob, width: number): Promise<string> {
  const bitmap = await createImageBitmap(blob)
  const canvas = new OffscreenCanvas(width, Math.round((width * bitmap.height) / bitmap.width))
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  const jpeg = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 })
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.readAsDataURL(jpeg)
  })
}

/**
 * Renders a preset as a small still over the open song: the scene placed at
 * the start of the first drop (or the song), one beat in, so drum-driven
 * looks show a hit.
 */
export function presetPreview(item: LibraryItem): Promise<string> {
  if (item.preview) return Promise.resolve(item.preview)
  if (!item.preset) return Promise.resolve('')
  const key = `${item.id}@${item.version}`
  let pending = previews.get(key)
  if (!pending) {
    pending = (async () => {
      const { project } = getState()
      const drop = project.sections.find((s) => studio.sectionRole(s.name) === 'drop')
      const start: studio.TimeRef = drop ? { sectionId: drop.id, at: 'start', bars: 0 } : studio.songStart()
      const temp = studio.executeBatch(project, [
        { type: 'video.storyboard.create', params: { empty: true, width: 640, height: 360 } },
        { type: 'video.scene.add', params: { start, ...item.preset } },
      ]).project
      const timeline = new Timeline(temp, studio.requireStoryboard(temp), isAnalysisCurrent(project) ? getAnalysis().features : null)
      const at = (timeline.scenes[0]?.t0 ?? 0) + timeline.cues.beatSeconds * 1.02
      const [still] = await renderStills(timeline, [{ seconds: at, label: item.name }], { width: 320, height: 180 })
      return toJpegDataUrl(still.blob, 320)
    })().catch(() => '')
    previews.set(key, pending)
  }
  return pending
}

// Saving ------------------------------------------------------------------------------

const newItem = (kind: studio.LibraryKind, name: string, patch: Partial<LibraryItem>): LibraryItem => ({
  id: studio.newId('lib').replace(/[^a-z0-9_-]/gi, ''),
  kind,
  name: name.slice(0, 80) || 'Untitled',
  version: 0,
  fits: [],
  tags: [],
  description: '',
  builtin: false,
  createdAt: '',
  updatedAt: '',
  source: null,
  preview: '',
  pending: null,
  ...patch,
})

function sourceOf(board: studio.Storyboard): LibraryItem['source'] {
  return { project: getState().project.name, storyboard: board.name }
}

/** Saves a scene's look settings as a preset. With `pending`, it waits in Suggestions until the user keeps it. */
export async function savePreset(sceneId: string, options: { name: string; description?: string; tags?: string[]; pending?: LibraryItem['pending'] }): Promise<LibraryItem> {
  const { project } = getState()
  const board = studio.storyboardWith(project, sceneId, 'scene')
  const scene = board.scenes.find((s) => s.id === sceneId)!
  const section = scene.start.sectionId ? project.sections.find((s) => s.id === scene.start.sectionId) : null
  const draft = newItem('preset', options.name, { description: options.description ?? '', tags: options.tags ?? [], fits: section ? [studio.sectionRole(section.name)] : [], source: sourceOf(board), preset: studio.presetFromScene(scene), pending: options.pending ?? null })
  draft.preview = await presetPreview(draft)
  const saved = await backend.save(draft)
  await refreshLibrary()
  return saved
}

/** Saves a storyboard as a template: its scenes grouped by section role, and its text. */
export async function saveTemplate(storyboardId: string, options: { name: string; description?: string; pending?: LibraryItem['pending'] }): Promise<LibraryItem> {
  const { project } = getState()
  const board = studio.requireStoryboard(project, storyboardId)
  const roleOf = (ref: studio.TimeRef) => {
    const section = ref.sectionId ? project.sections.find((s) => s.id === ref.sectionId) : null
    return section ? studio.sectionRole(section.name) : 'other'
  }
  const roles: Partial<Record<studio.SectionRole, studio.ScenePreset[]>> = {}
  for (const scene of studio.sortScenes(project, board.scenes)) (roles[roleOf(scene.start)] ??= []).push(studio.presetFromScene(scene))
  const seenText = new Set<studio.SectionRole>()
  const text = board.text.flatMap((item): studio.TemplateText[] => {
    const role = roleOf(item.start)
    if (seenText.has(role) || item.start.at !== 'start') return []
    seenText.add(role)
    const { id: _id, start, end, ...style } = item
    const length = (studio.resolveTimeRef(project, end) ?? 0) - (studio.resolveTimeRef(project, start) ?? 0)
    return [{ ...style, role, offset: start.bars, length: Math.max(0.25, length) }]
  })
  const draft = newItem('template', options.name, { description: options.description ?? '', source: sourceOf(board), template: { roles, text, fade: board.fade, impact: board.impact }, pending: options.pending ?? null })
  const saved = await backend.save(draft)
  await refreshLibrary()
  return saved
}

/** Copies a downloaded clip into the library so other projects can use it without downloading it again. */
export async function saveFootage(clipId: string, options: { pending?: LibraryItem['pending'] } = {}): Promise<LibraryItem> {
  const { project } = getState()
  const owner = project.video?.storyboards.find((b) => b.footage.some((c) => c.id === clipId))
  const clip = owner?.footage.find((c) => c.id === clipId)
  if (!owner || !clip?.fileId) throw new Error('Only downloaded clips can go in the library.')
  const file = project.video!.files[clip.fileId]
  const stored = await getAsset(clip.fileId)
  if (!stored || !file) throw new Error('The clip file is not available.')
  const { id: _id, status: _status, fileId: _fileId, proposedBy: _by, query: _query, ...details } = clip
  const draft = newItem('footage', clip.title, { tags: clip.tags, source: sourceOf(owner), preview: clip.thumbnail, footage: { ...details, file: '', mimeType: file.mimeType, bytes: file.bytes, sha256: '' }, pending: options.pending ?? null })
  const saved = await backend.save(draft, await stored.data.arrayBuffer())
  await refreshLibrary()
  return saved
}

export async function keepSuggestion(id: string): Promise<void> {
  const item = libraryItem(id)
  if (!item) return
  await backend.save({ ...item, pending: null })
  await refreshLibrary()
}

export async function removeLibraryItem(id: string): Promise<void> {
  await backend.remove(id)
  await refreshLibrary()
}

// Applying ---------------------------------------------------------------------------

const ref = (item: LibraryItem): studio.LibraryRef => ({ id: item.id, version: item.version, name: item.name })

/** Copies a preset's look settings into a scene and pins the preset's version. */
export function applyPreset(item: LibraryItem, sceneId: string, history: DispatchOptions = {}): boolean {
  if (!item.preset) return false
  const { look, params, layers, post, travel, cutOn, xfade } = item.preset
  const current = studio.storyboardWith(getState().project, sceneId, 'scene').scenes.find((s) => s.id === sceneId)!
  // Clear post settings the preset doesn't set, so the scene matches it exactly.
  const clearedPost = Object.fromEntries(Object.keys(current.post).filter((k) => !(k in post)).map((k) => [k, null]))
  const clearedParams = Object.fromEntries(Object.keys(current.params).filter((k) => !(k in params)).map((k) => [k, null]))
  return Boolean(dispatch({ type: 'video.scene.update', params: { sceneId, look, params: { ...clearedParams, ...params }, layers, post: { ...clearedPost, ...post }, travel, cutOn, xfade, preset: ref(item) } }, { label: `Apply ${item.name}`, ...history }))
}

/** Starts a new storyboard from a template. Returns its ID. */
export function createFromTemplate(item: LibraryItem, history: DispatchOptions = {}): string | null {
  if (!item.template) return null
  const results = dispatch({ type: 'video.storyboard.create', params: { name: item.name, template: { ...ref(item), template: item.template } } }, { label: `New storyboard from ${item.name}`, ...history })
  return (results?.[0] as { storyboardId?: string } | undefined)?.storyboardId ?? null
}

/** Adds library footage to a storyboard as an approved, downloaded clip, without downloading it again. */
export async function addLibraryFootage(item: LibraryItem, storyboardId: string, history: DispatchOptions = {}): Promise<string | null> {
  if (!item.footage) return null
  const data = await backend.readFootage(item.id)
  if (!data) {
    toast('The library clip file is missing.', 'error')
    return null
  }
  const { file: _file, mimeType, bytes: _bytes, sha256: _sha, ...clip } = item.footage
  const added = dispatch({ type: 'video.footage.add', params: { storyboardId, clips: [{ ...clip, query: 'library' }] } }, { label: `Add ${item.name}`, ...history })
  const clipId = (added?.[0] as { clipIds?: string[] } | undefined)?.clipIds?.[0]
  if (!clipId) return null
  dispatch({ type: 'video.footage.review', params: { clipId, status: 'approved' } }, { label: 'Approve clip', ...history })
  const fileId = studio.newId('vfl')
  const blob = new Blob([data], { type: mimeType })
  await putAsset({ id: fileId, name: `${item.name}.mp4`, mimeType, data: blob })
  dispatch({ type: 'video.footage.fetched', params: { clipId, file: { id: fileId, kind: 'footage', name: item.name, mimeType, bytes: blob.size, width: clip.width, height: clip.height, duration: clip.duration, seconds: null } } }, { label: 'Add footage', ...history })
  return clipId
}
