import { collectEvents } from '@reborn/audio-engine/studio'
import { studio } from '@reborn/studio-core'

type StudioProject = studio.StudioProject

// Exact cue times for a video, from the same scheduler the audio engine
// plays: every drum hit with swing, microtiming, ratchets, and probability,
// plus impacts and risers found by clip name. Muted tracks are left out.

export type Channel = studio.CutEvent

/** How fast each pulse decays after a hit, per second. */
export const PULSE_DECAY: Readonly<Record<Channel, number>> = { kick: 7, snare: 8, hat: 20, beat: 9, half: 6, bar: 4, '2bar': 3, '8th': 14, impact: 4 }

export interface Cues {
  tempo: number
  beatSeconds: number
  barSeconds: number
  /** Song length in seconds, from the arrangement length. */
  duration: number
  /** Sorted event times in seconds for each channel. */
  channels: Record<Channel, Float64Array>
  /** Riser spans in seconds. */
  risers: [number, number][]
  /** Note onsets per track name, for overlays. */
  notes: Record<string, { t: number; note: number }[]>
}

const KICK = /kick|\bbd\b|bass ?drum/i
const SNARE = /snare|clap|\bsd\b|\bcp\b|rim/i
const HAT = /hat|\bhh\b|\bch\b|\boh\b|shaker|ride/i

function voiceChannel(voice: studio.DrumVoiceName): Channel | null {
  if (voice === 'kick') return 'kick'
  if (voice === 'snare' || voice === 'clap') return 'snare'
  if (voice === 'closedHat' || voice === 'openHat') return 'hat'
  return null
}

function padChannel(name: string): Channel | null {
  if (KICK.test(name)) return 'kick'
  if (SNARE.test(name)) return 'snare'
  if (HAT.test(name)) return 'hat'
  return null
}

function grid(step: number, duration: number): Float64Array {
  const count = Math.max(0, Math.floor(duration / step + 1e-9) + 1)
  return Float64Array.from({ length: count }, (_, i) => i * step)
}

function sorted(values: number[]): Float64Array {
  const unique = [...new Set(values.map((v) => Math.round(v * 1e5) / 1e5))]
  return Float64Array.from(unique.sort((a, z) => a - z))
}

/** Builds the cue sheet for a project. `extraImpacts` are seconds from the storyboard. */
export function buildCues(project: StudioProject, extraImpacts: readonly number[] = []): Cues {
  const barSeconds = studio.barSeconds(project)
  const beatSeconds = barSeconds / project.meter.numerator
  const duration = project.length * barSeconds
  const audible = new Set(project.tracks.filter((t) => studio.isTrackAudible(project, t)).map((t) => t.id))
  const hits: Record<'kick' | 'snare' | 'hat', number[]> = { kick: [], snare: [], hat: [] }
  const notes: Cues['notes'] = {}
  const trackName = new Map(project.tracks.map((t) => [t.id, t.name]))

  for (const event of collectEvents(project, 0, project.length)) {
    if (!audible.has(event.trackId)) continue
    const t = event.bar * barSeconds
    if (event.kind === 'drum') {
      const channel = voiceChannel(event.voice)
      if (channel === 'kick' || channel === 'snare' || channel === 'hat') hits[channel].push(t)
    } else if (event.kind === 'pad') {
      const track = project.tracks.find((tr) => tr.id === event.trackId)
      const pad = track?.device.kind === 'sampler' ? track.device.pads[event.pad] : undefined
      const channel = pad ? padChannel(pad.name) : null
      if (channel === 'kick' || channel === 'snare' || channel === 'hat') hits[channel].push(t)
    } else if (event.kind === 'note') {
      const name = trackName.get(event.trackId) ?? event.trackId
      ;(notes[name] ??= []).push({ t, note: event.note })
    }
  }

  const impacts: number[] = [...extraImpacts]
  const risers: [number, number][] = []
  for (const clip of project.clips) {
    if (clip.mute || !audible.has(clip.trackId)) continue
    const name = [clip.patternId ? project.patterns[clip.patternId]?.name : null, clip.assetId ? project.assets[clip.assetId]?.name : null, trackName.get(clip.trackId)].filter(Boolean).join(' ').toLowerCase()
    if (name.includes('impact')) impacts.push(clip.start * barSeconds)
    if (/riser|uplift/.test(name)) risers.push([clip.start * barSeconds, (clip.start + clip.length) * barSeconds])
  }

  return {
    tempo: project.tempo,
    beatSeconds,
    barSeconds,
    duration,
    channels: {
      kick: sorted(hits.kick),
      snare: sorted(hits.snare),
      hat: sorted(hits.hat),
      beat: grid(beatSeconds, duration),
      half: grid(beatSeconds * 2, duration),
      bar: grid(barSeconds, duration),
      '2bar': grid(barSeconds * 2, duration),
      '8th': grid(beatSeconds / 2, duration),
      impact: sorted(impacts),
    },
    risers: risers.sort((a, z) => a[0] - z[0]),
    notes,
  }
}

/** Index of the last event at or before t, or -1. */
export function lastIndex(times: Float64Array, t: number): number {
  let lo = 0
  let hi = times.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (times[mid] <= t + 1e-6) lo = mid + 1
    else hi = mid
  }
  return lo - 1
}

/** Decaying pulse for a channel: 1 on a hit, falling toward 0. Also returns seconds since the hit. */
export function pulse(cues: Cues, channel: Channel, t: number): { value: number; since: number } {
  const times = cues.channels[channel]
  const i = lastIndex(times, t)
  if (i < 0) return { value: 0, since: 99 }
  const since = t - times[i]
  return { value: Math.exp(-since * PULSE_DECAY[channel]), since }
}
