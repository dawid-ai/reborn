import { studio } from '@reborn/studio-core'
import { engine } from '../audio/host'
import { dispatch, getState, select, selectedTrackId, toast } from './store'

let clipboard: studio.ClipSnapshot | null = null

/** Whether a clip has been copied or cut this session. */
export const hasCopiedClip = () => clipboard !== null

function selectedClip() {
  const s = getState()
  const sel = s.selection
  return sel.kind === 'clip' || sel.kind === 'step' ? s.project.clips.find((c) => c.id === sel.clipId) : undefined
}

/** Copies the selected clip, or cuts it when `cut` is set. Returns false when no clip is selected. */
export function copySelectedClip(cut = false): boolean {
  const clip = selectedClip()
  if (!clip) return false
  clipboard = studio.snapshotClip(getState().project, clip.id)
  if (cut) {
    dispatch({ type: 'clip.delete', params: { clipId: clip.id } }, { label: 'Cut clip' })
    select({ kind: 'none' })
  }
  return true
}

/**
 * Pastes the copied clip. Without a place it goes on the selected track (or
 * the track it came from) at the playhead, and the playhead moves to its end
 * so pasting again lays copies end to end.
 */
export function pasteCopiedClip(place?: { trackId: string; bar: number }): void {
  if (!clipboard) return void toast('Copy a clip first: select it and press Ctrl+C.')
  const s = getState()
  const { kind } = clipboard
  const candidates = [place?.trackId, selectedTrackId(s), clipboard.clip.trackId]
  const track = candidates.map((id) => s.project.tracks.find((t) => t.id === id)).find((t) => t?.kind === kind) ?? s.project.tracks.find((t) => t.kind === kind)
  if (!track) return void toast(`Add a ${studio.DEVICE_NAMES[kind]} track to paste this clip.`)
  const start = place?.bar ?? Math.round(engine.position() * 16) / 16
  const results = dispatch({ type: 'clip.paste', params: { snapshot: clipboard, trackId: track.id, start } }, { label: 'Paste clip' })
  const clipId = (results?.[0] as { clipId?: string } | undefined)?.clipId
  if (!clipId) return
  select({ kind: 'clip', clipId })
  if (!place && !s.transport.playing) engine.seek(start + clipboard.clip.length)
}

/** Turns looping on (at a musical length that holds the sound) or off for an audio clip. */
export function toggleClipLoop(clipId: string, on: boolean): void {
  const s = getState()
  const clip = s.project.clips.find((c) => c.id === clipId)
  const asset = clip?.assetId ? s.project.assets[clip.assetId] : undefined
  if (!clip || !asset) return
  const remaining = asset.duration / studio.barSeconds(s.project) - clip.offset
  const length = on ? studio.suggestLoopLength(Math.max(1 / 16, remaining)) : 0
  dispatch({ type: 'clip.loop', params: { clipId, length } }, { label: on ? 'Loop clip' : 'Stop looping clip' })
}

/** Splits the selected clip at the playhead (snapped to 1/16 bar). */
export function splitSelectedClip(): void {
  const s = getState()
  const sel = s.selection
  if (sel.kind !== 'clip' && sel.kind !== 'step') return void toast('Select a clip to split.')
  const clip = s.project.clips.find((c) => c.id === sel.clipId)
  if (!clip) return
  const at = Math.round(engine.position() * 16) / 16
  if (!(at > clip.start && at < clip.start + clip.length)) return void toast('Move the playhead inside the clip to split it there.')
  const results = dispatch({ type: 'clip.split', params: { clipId: clip.id, at } }, { label: 'Split clip' })
  const right = (results?.[0] as { clipId?: string } | undefined)?.clipId
  if (right) select({ kind: 'clip', clipId: right })
}

/** Plays from the start of the selected clip or section, or from the playhead. */
export function playFromSelection(): void {
  const s = getState()
  const sel = s.selection
  const clip = sel.kind === 'clip' || sel.kind === 'step' ? s.project.clips.find((c) => c.id === sel.clipId) : undefined
  const section = sel.kind === 'section' ? s.project.sections.find((x) => x.id === sel.sectionId) : undefined
  const start = clip?.start ?? section?.start ?? engine.position()
  if (s.transport.playing) engine.stop()
  void engine.play(start)
}
