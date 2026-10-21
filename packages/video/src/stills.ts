import { studio } from '@reborn/studio-core'
import type { FootageSource } from './footage'
import { VideoRenderer } from './renderer'
import type { Timeline } from './timeline'

// Stills for look-dev: a frame at each moment that matters, rendered with
// the same renderer as the preview and export, plus a contact sheet that
// shows them side by side. A dozen stills take seconds, so problems such as
// an off-center fractal or a washed-out drop show up before any long render.

export interface StillMoment {
  seconds: number
  label: string
}

export interface RenderedStill extends StillMoment {
  blob: Blob
  width: number
  height: number
}

const formatTime = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`

/**
 * Moments worth checking: one beat into each scene (after the cut settles),
 * each impact, the start of each text item, and the middle of long scenes.
 */
export function keyMoments(timeline: Timeline, limit = 16): StillMoment[] {
  const moments: StillMoment[] = []
  const beat = timeline.cues.beatSeconds
  for (const scene of timeline.scenes) {
    const end = Math.min(scene.t1, timeline.duration)
    const name = scene.scene.name || scene.look?.title || scene.scene.look
    moments.push({ seconds: Math.min(scene.t0 + beat, end - 0.05), label: name })
    if (end - scene.t0 > 16 * beat) moments.push({ seconds: (scene.t0 + end) / 2, label: `${name}, middle` })
  }
  for (const t of timeline.events('impact')) moments.push({ seconds: t + 1 / timeline.fps, label: 'Impact' })
  for (const text of timeline.texts) moments.push({ seconds: Math.min(text.t0 + beat / 2, text.t1 - 0.05), label: `Text: ${text.item.text.split('\n')[0].slice(0, 24)}` })
  const sorted = moments.filter((m) => m.seconds >= 0 && m.seconds < timeline.duration).sort((a, z) => a.seconds - z.seconds)
  // Moments within half a second of each other share one still and its labels; then thin evenly to the limit.
  const spaced: StillMoment[] = []
  for (const moment of sorted) {
    const last = spaced[spaced.length - 1]
    if (last && moment.seconds - last.seconds <= 0.5) spaced[spaced.length - 1] = { ...last, label: `${last.label} · ${moment.label}` }
    else spaced.push(moment)
  }
  if (spaced.length <= limit) return spaced
  return Array.from({ length: limit }, (_, i) => spaced[Math.round((i * (spaced.length - 1)) / (limit - 1))])
}

/** Renders stills at the given moments. Fonts used by text items must already be loaded. */
export async function renderStills(timeline: Timeline, moments: readonly StillMoment[], size: { width: number; height: number }, footage: FootageSource | null = null): Promise<RenderedStill[]> {
  const canvas = new OffscreenCanvas(size.width, size.height)
  const renderer = new VideoRenderer(canvas, { preserveDrawingBuffer: true })
  try {
    renderer.setSize(size.width, size.height)
    renderer.setTimeline(timeline)
    renderer.setFootage(footage)
    const stills: RenderedStill[] = []
    for (const moment of moments) {
      await renderer.prepare(moment.seconds)
      renderer.render(moment.seconds, true)
      stills.push({ ...moment, blob: await canvas.convertToBlob({ type: 'image/png' }), ...size })
    }
    return stills
  } finally {
    renderer.dispose()
  }
}

/** Lays stills out in a grid with their time and label under each. */
export async function contactSheet(stills: readonly RenderedStill[], options: { columns?: number; cellWidth?: number; title?: string } = {}): Promise<Blob> {
  const columns = Math.max(1, Math.min(options.columns ?? 4, stills.length))
  const cellWidth = options.cellWidth ?? 480
  const aspect = stills[0] ? stills[0].height / stills[0].width : 9 / 16
  const cellHeight = Math.round(cellWidth * aspect)
  const caption = 28
  const header = options.title ? 40 : 0
  const gap = 8
  const rows = Math.ceil(stills.length / columns)
  const canvas = new OffscreenCanvas(columns * (cellWidth + gap) + gap, header + rows * (cellHeight + caption + gap) + gap)
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#0c0e0d'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.textBaseline = 'middle'
  if (options.title) {
    ctx.fillStyle = '#e4e8e2'
    ctx.font = '600 20px "IBM Plex Sans", sans-serif'
    ctx.fillText(options.title, gap + 4, header / 2 + 2)
  }
  for (const [i, still] of stills.entries()) {
    const x = gap + (i % columns) * (cellWidth + gap)
    const y = header + gap + Math.floor(i / columns) * (cellHeight + caption + gap)
    const bitmap = await createImageBitmap(still.blob)
    ctx.drawImage(bitmap, x, y, cellWidth, cellHeight)
    bitmap.close()
    ctx.fillStyle = '#c7ff39'
    ctx.font = '500 14px "IBM Plex Mono", monospace'
    ctx.fillText(formatTime(still.seconds), x + 2, y + cellHeight + caption / 2)
    ctx.fillStyle = '#a0a8a2'
    ctx.font = '400 14px "IBM Plex Sans", sans-serif'
    ctx.fillText(still.label.slice(0, 48), x + 52, y + cellHeight + caption / 2)
  }
  return canvas.convertToBlob({ type: 'image/png' })
}

/** Section names and start times, as YouTube-style chapters ("0:25 Drop 1"). */
export function chapters(project: studio.StudioProject): string {
  const bar = studio.barSeconds(project)
  const sections = [...project.sections].sort((a, z) => a.start - z.start)
  const lines = sections.map((section) => `${formatTime(section.start * bar)} ${section.name}`)
  // Chapter lists start at 0:00.
  if (lines.length && sections[0].start > 0) lines.unshift('0:00 Intro')
  return lines.join('\n')
}

/** Credits for the footage a storyboard uses, grouped by licence. */
export function footageCredits(board: studio.Storyboard): string {
  const used = new Set(board.scenes.flatMap((scene) => scene.clips))
  const clips = board.footage.filter((clip) => used.has(clip.id) && clip.status === 'fetched')
  if (!clips.length) return ''
  return [
    'Footage',
    ...clips.map((clip) => `- "${clip.title}" by ${clip.author || 'unknown'} (${clip.provider}), ${clip.licenceName}${clip.licenceUrl ? ` ${clip.licenceUrl}` : ''}. Source: ${clip.page}`),
  ].join('\n')
}
