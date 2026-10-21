import { ClipboardPaste, Copy, CopyPlus, Pencil, Pin, PinOff, Repeat, Scissors, Split, Trash2, Unlink, Volume2, VolumeX } from 'lucide-react'
import { studio } from '@reborn/studio-core'
import { copySelectedClip, hasCopiedClip, pasteCopiedClip, splitSelectedClip, toggleClipLoop } from '../state/clipActions'
import { dispatch, getState, select } from '../state/store'
import { ContextMenu, type MenuItem } from './ContextMenu'

/** Where the menu opened: the clip under the pointer (if any), its track, and the bar. */
export interface ClipMenuPlace {
  x: number
  y: number
  trackId: string
  bar: number
  clipId: string | null
}

/** Right-click menu for clips and empty lanes in Arrange. */
export function ClipMenu({ place, onClose }: { place: ClipMenuPlace; onClose: () => void }) {
  const project = getState().project
  const clip = place.clipId ? project.clips.find((c) => c.id === place.clipId) : undefined
  const items: MenuItem[] = []
  if (clip) {
    items.push({ label: 'Copy', hint: 'Ctrl+C', icon: <Copy size={14} />, run: () => void copySelectedClip() })
    items.push({ label: 'Cut', hint: 'Ctrl+X', icon: <Scissors size={14} />, run: () => void copySelectedClip(true) })
  }
  items.push({ label: clip ? 'Paste at this bar' : 'Paste here', hint: 'Ctrl+V', icon: <ClipboardPaste size={14} />, run: () => pasteCopiedClip({ trackId: place.trackId, bar: place.bar }), disabled: !hasCopiedClip() })
  if (clip) {
    items.push({
      label: 'Duplicate',
      hint: 'Ctrl+D',
      icon: <CopyPlus size={14} />,
      run: () => {
        const results = dispatch({ type: 'clip.duplicate', params: { clipId: clip.id } }, { label: 'Duplicate clip' })
        const copy = (results?.[0] as { clipId?: string } | undefined)?.clipId
        if (copy) select({ kind: 'clip', clipId: copy })
      },
    })
    if (clip.assetId) items.push({ label: clip.loop ? 'Stop looping' : 'Loop', icon: <Repeat size={14} />, run: () => toggleClipLoop(clip.id, !clip.loop) })
    items.push({ label: 'Split at playhead', hint: 'Ctrl+E', icon: <Split size={14} />, run: splitSelectedClip })
    if (clip.patternId && studio.linkCount(project, clip.patternId) > 1) {
      items.push({ label: 'Make unique', icon: <Unlink size={14} />, run: () => dispatch({ type: 'clip.makeUnique', params: { clipId: clip.id } }, { label: 'Make clip unique' }) })
    }
    items.push({
      label: 'Delete',
      hint: 'Del',
      icon: <Trash2 size={14} />,
      danger: true,
      run: () => {
        dispatch({ type: 'clip.delete', params: { clipId: clip.id } }, { label: 'Delete clip' })
        select({ kind: 'none' })
      },
    })
  }

  return <ContextMenu x={place.x} y={place.y} label={clip ? 'Clip actions' : 'Lane actions'} items={items} onClose={onClose} />
}

/** Right-click menu for a track header in Arrange. */
export function TrackMenu({ x, y, trackId, onRename, onClose }: { x: number; y: number; trackId: string; onRename: () => void; onClose: () => void }) {
  const track = getState().project.tracks.find((t) => t.id === trackId)
  if (!track) return null
  const { mute, solo } = track.mixer
  const items: MenuItem[] = [
    { label: 'Rename', icon: <Pencil size={14} />, run: onRename },
    { label: mute ? 'Unmute' : 'Mute', icon: mute ? <Volume2 size={14} /> : <VolumeX size={14} />, run: () => dispatch({ type: 'mixer.set', params: { trackId, mute: !mute } }, { label: `${mute ? 'Unmute' : 'Mute'} ${track.name}` }) },
    { label: solo ? 'Unsolo' : 'Solo', icon: solo ? <PinOff size={14} /> : <Pin size={14} />, run: () => dispatch({ type: 'mixer.set', params: { trackId, solo: !solo } }, { label: `${solo ? 'Unsolo' : 'Solo'} ${track.name}` }) },
    {
      label: 'Remove track',
      icon: <Trash2 size={14} />,
      danger: true,
      run: () => {
        if (dispatch({ type: 'track.remove', params: { trackId } }, { label: `Remove ${track.name}` })) select({ kind: 'none' })
      },
    },
  ]
  return <ContextMenu x={x} y={y} label={`${track.name} actions`} items={items} onClose={onClose} />
}
