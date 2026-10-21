import { studio } from '@reborn/studio-core'

type StudioProject = studio.StudioProject
type Track = studio.Track
type Pattern = studio.Pattern
type Clip = studio.Clip
type DrumVoiceName = studio.DrumVoiceName
type ParamLocks = studio.ParamLocks
type ClipLoop = studio.ClipLoop

const { chordIntervals } = studio

// Pure event generation shared by live playback and offline render, so both
// paths hear the same notes. Positions are in bars; the graph converts them
// to seconds.

export interface NoteEvent {
  kind: 'note'
  trackId: string
  bar: number
  /** Gate length in bars. */
  length: number
  note: number
  velocity: number
  accent: boolean
  slide: boolean
  /** Next note when sliding. */
  slideTo: number | null
  /** Semitone offsets to play on top of `note`: [0] for one note, more for a chord. */
  chord: readonly number[]
  locks: ParamLocks
}

export interface DrumEvent {
  kind: 'drum'
  trackId: string
  bar: number
  voice: DrumVoiceName
  velocity: number
  accent: boolean
  locks: ParamLocks
}

export interface PadEvent {
  kind: 'pad'
  trackId: string
  bar: number
  length: number
  pad: number
  velocity: number
  locks: ParamLocks
}

export interface AudioEvent {
  kind: 'audio'
  trackId: string
  clipId: string
  assetId: string
  bar: number
  /** Bars into the asset where playback starts. */
  offset: number
  length: number
  gain: number
  fadeIn: number
  fadeOut: number
  /** Region of the asset, in bars, that repeats to fill the clip. */
  loop: ClipLoop | null
}

/** The audio event for a whole clip, cut to `length` bars when given. */
export function audioClipEvent(clip: Clip & { assetId: string }, length = clip.length): AudioEvent {
  return { kind: 'audio', trackId: clip.trackId, clipId: clip.id, assetId: clip.assetId, bar: clip.start, offset: clip.offset, length, gain: clip.gain, fadeIn: clip.fadeIn, fadeOut: clip.fadeOut, loop: clip.loop ?? null }
}

/** One stretch of a looped clip that plays straight through the source. */
export interface LoopSegment {
  /** Seconds after playback starts. */
  at: number
  /** Seconds into the source. */
  from: number
  /** Seconds of source to play; the rest of the stretch is silence. */
  length: number
  /** Whether the source keeps sounding past this stretch, so it needs a short fade to avoid a click. */
  cut: boolean
}

/**
 * Splits playback of an audio clip into stretches of the source. Without a
 * loop that is one stretch from the offset; with a loop, the region repeats
 * so that the clip position x plays the source at
 * loop.start + ((offset + x - loop.start) mod loop.length). Splitting or
 * trimming a clip shifts its offset, which keeps every copy in phase.
 * All values are seconds; `skip` starts playback part-way into the clip.
 */
export function loopSegments(offset: number, duration: number, skip: number, sourceDuration: number, loop: { start: number; length: number } | null): LoopSegment[] {
  const segments: LoopSegment[] = []
  const begin = Math.max(0, skip)
  if (!loop || !(loop.length > 0.001)) {
    const from = offset + begin
    const remaining = duration - begin
    if (remaining > 0.001 && from < sourceDuration) segments.push({ at: 0, from, length: Math.min(remaining, sourceDuration - from), cut: false })
    return segments
  }
  const { start, length: period } = loop
  let t = begin
  while (t < duration - 0.001) {
    const phase = (((offset + t - start) % period) + period) % period
    const span = Math.min(period - phase, duration - t)
    const from = start + phase
    const audible = Math.min(span, sourceDuration - from)
    if (audible > 0.001) segments.push({ at: t - begin, from, length: audible, cut: from + audible < sourceDuration - 0.001 })
    // Rounding can leave a sliver of a period; always move forward.
    t += Math.max(span, 0.0005)
  }
  return segments
}

export type StudioEvent = NoteEvent | DrumEvent | PadEvent | AudioEvent

/** Deterministic 0..1 hash so probability gives the same result live and offline. */
export function chance(seed: string): number {
  let h = 2166136261
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  h ^= h >>> 13
  h = Math.imul(h, 0x5bd1e995)
  h ^= h >>> 15
  return (h >>> 0) / 4294967296
}

const stepsPerBar = (pattern: Pattern) => pattern.division || 16

/** Bar offset of a step after swing. Swing delays every second step. */
export function swungPosition(step: number, division: number, swing: number): number {
  const stepBars = 1 / division
  const base = step * stepBars
  return step % 2 === 1 ? base + swing * stepBars : base
}

export interface PlaySource {
  trackId: string
  patternId: string | null
  assetId: string | null
  /** Bars from song start where this source begins. */
  start: number
  /** Bars it plays for; Infinity for launched scene loops. */
  length: number
  offset: number
  gain: number
  transpose: number
  fadeIn: number
  fadeOut: number
  loop: ClipLoop | null
  id: string
}

export function clipSource(clip: Clip): PlaySource {
  return { trackId: clip.trackId, patternId: clip.patternId, assetId: clip.assetId, start: clip.start, length: clip.length, offset: clip.offset, gain: clip.gain, transpose: clip.transpose, fadeIn: clip.fadeIn, fadeOut: clip.fadeOut, loop: clip.loop ?? null, id: clip.id }
}

/** Events from one source that start in [from, to) bars. */
export function sourceEvents(project: StudioProject, track: Track, source: PlaySource, from: number, to: number): StudioEvent[] {
  const events: StudioEvent[] = []
  const end = source.start + source.length
  const windowStart = Math.max(from, source.start)
  const windowEnd = Math.min(to, end)
  if (windowEnd <= windowStart) return events

  if (source.assetId) {
    if (source.start >= from && source.start < to) {
      events.push({ kind: 'audio', trackId: track.id, clipId: source.id, assetId: source.assetId, bar: source.start, offset: source.offset, length: source.length, gain: source.gain, fadeIn: source.fadeIn, fadeOut: source.fadeOut, loop: source.loop })
    }
    return events
  }
  const pattern = source.patternId ? project.patterns[source.patternId] : undefined
  if (!pattern || pattern.length < 1) return events
  const division = stepsPerBar(pattern)
  const swing = pattern.swing ?? project.swing
  const stepBars = 1 / division
  const gain = 10 ** (source.gain / 20)
  // Pattern position (in bars) at the source start, after the clip offset.
  const firstLocal = Math.floor(((windowStart - source.start + source.offset) / stepBars) - 1)
  const lastLocal = Math.ceil((windowEnd - source.start + source.offset) / stepBars) + 1
  for (let local = Math.max(0, firstLocal); local <= lastLocal; local += 1) {
    const step = local % pattern.length
    const cycle = Math.floor(local / pattern.length)
    const stepInBar = local % division
    const barIndex = Math.floor(local / division)
    const base = source.start - source.offset + barIndex + swungPosition(stepInBar, division, swing)
    const emit = (micro: number, probability: number, ratchet: number, key: string, make: (bar: number, length: number) => StudioEvent | null) => {
      if (probability < 100 && chance(`${source.id}:${key}:${cycle}`) * 100 >= probability) return
      const count = Math.max(1, Math.min(4, Math.round(ratchet)))
      const sub = stepBars / count
      for (let r = 0; r < count; r += 1) {
        const bar = base + micro * stepBars + r * sub
        if (bar < windowStart - 1e-9 || bar >= windowEnd - 1e-9 || bar < source.start - 1e-9) continue
        const event = make(bar, sub)
        if (event) events.push(event)
      }
    }
    if (pattern.kind === 'notes') {
      const s = pattern.steps[step]
      if (!s?.on) continue
      const next = pattern.steps[(step + 1) % pattern.length]
      emit(s.micro, s.probability, s.ratchet, String(step), (bar, length) => ({
        kind: 'note',
        trackId: track.id,
        bar,
        length: s.slide ? length * 2 : length,
        note: s.note + source.transpose,
        velocity: Math.min(127, s.velocity * gain),
        accent: s.accent,
        slide: s.slide && Boolean(next?.on),
        slideTo: s.slide && next?.on ? next.note + source.transpose : null,
        chord: chordIntervals(s.chord),
        locks: s.locks,
      }))
    } else if (pattern.kind === 'drums') {
      for (const [voice, lane] of Object.entries(pattern.lanes) as [DrumVoiceName, (typeof pattern.lanes)[DrumVoiceName]][]) {
        const hit = lane[step]
        if (!hit?.on) continue
        emit(hit.micro, hit.probability, hit.ratchet, `${voice}:${step}`, (bar) => ({ kind: 'drum', trackId: track.id, bar, voice, velocity: Math.min(127, hit.velocity * gain), accent: hit.accent, locks: hit.locks }))
      }
    } else {
      for (const hit of pattern.hits) {
        if (hit.step !== step) continue
        emit(hit.micro, hit.probability, hit.ratchet, `${hit.pad}:${step}`, (bar, length) => ({ kind: 'pad', trackId: track.id, bar, length, pad: hit.pad, velocity: Math.min(127, hit.velocity * gain), locks: hit.locks }))
      }
    }
  }
  return events
}

export interface Launch {
  sceneId: string | null
  /** Pattern per track that a launched scene plays from `start`. */
  slots: Record<string, string | null>
  start: number
}

/**
 * All events in [from, to). Tracks with a launched scene slot play that
 * pattern as an endless loop from the launch bar; all other tracks follow the
 * arrangement.
 */
export function collectEvents(project: StudioProject, from: number, to: number, launch: Launch | null = null): StudioEvent[] {
  const events: StudioEvent[] = []
  for (const track of project.tracks) {
    if (track.kind === 'group' || track.kind === 'deck') continue
    const launched = launch && track.id in launch.slots
    if (launched) {
      const patternId = launch.slots[track.id]
      if (patternId) {
        const source: PlaySource = { trackId: track.id, patternId, assetId: null, start: launch.start, length: Infinity, offset: 0, gain: 0, transpose: 0, fadeIn: 0, fadeOut: 0, loop: null, id: `scene:${launch.sceneId}:${track.id}` }
        events.push(...sourceEvents(project, track, source, from, to))
      }
      continue
    }
    for (const clip of project.clips) {
      if (clip.trackId !== track.id || clip.mute) continue
      events.push(...sourceEvents(project, track, clipSource(clip), from, to))
    }
  }
  return events.sort((a, b) => a.bar - b.bar)
}
