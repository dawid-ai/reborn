import { describe, expect, it } from 'vitest'
import { studio } from '@reborn/studio-core'
import { chance, collectEvents, loopSegments, swungPosition } from './schedule'
import { estimateTail, isolateTrack } from './render'
import { encodeWav } from './wav'

function project() {
  return studio.createDefaultStudioProject('Schedule')
}

describe('swing', () => {
  it('delays odd steps by the swing fraction of a step', () => {
    expect(swungPosition(0, 16, 0.2)).toBe(0)
    expect(swungPosition(1, 16, 0.2)).toBeCloseTo((1 + 0.2) / 16)
    expect(swungPosition(2, 16, 0.2)).toBeCloseTo(2 / 16)
  })
})

describe('collectEvents', () => {
  it('loops a one-bar pattern across a multi-bar clip', () => {
    let p = { ...project(), swing: 0 }
    const kicks = collectEvents(p, 0, 8).filter((e) => e.kind === 'drum' && e.voice === 'kick')
    expect(kicks.map((e) => e.bar)).toEqual([0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3, 3.25, 3.5, 3.75, 4, 4.25, 4.5, 4.75, 5, 5.25, 5.5, 5.75, 6, 6.25, 6.5, 6.75, 7, 7.25, 7.5, 7.75])
    p = studio.execute(p, { type: 'clip.set', params: { clipId: p.clips[0].id, mute: true } }).project
    expect(collectEvents(p, 0, 4).some((e) => e.kind === 'drum')).toBe(false)
  })

  it('returns only events inside the window and none before a clip starts', () => {
    const p = { ...project(), swing: 0 }
    const acid = collectEvents(p, 0, 4).filter((e) => e.kind === 'note')
    expect(acid).toHaveLength(0)
    const window = collectEvents(p, 4.5, 4.75)
    expect(window.every((e) => e.bar >= 4.5 && e.bar < 4.75)).toBe(true)
  })

  it('honors clip offset, transpose, and gain', () => {
    let p = { ...project(), swing: 0 }
    const acidClip = p.clips.find((c) => c.trackId === p.tracks[0].id)!
    p = studio.execute(p, { type: 'clip.set', params: { clipId: acidClip.id, offset: 0.5, transpose: 12, gain: -6 } }).project
    const notes = collectEvents(p, 4, 5).filter((e) => e.kind === 'note')
    const pattern = p.patterns[acidClip.patternId!]
    // The offset starts playback half a bar (8 steps) into the pattern.
    const index = pattern.kind === 'notes' ? pattern.steps.findIndex((s, i) => i >= 8 && s.on) : -1
    const firstStep = pattern.kind === 'notes' ? pattern.steps[index] : null
    expect(notes[0].bar).toBeCloseTo(4 + (index - 8) / 16)
    expect(notes[0].kind === 'note' && notes[0].note).toBe(firstStep!.note + 12)
    expect(notes[0].kind === 'note' && notes[0].velocity).toBeCloseTo(firstStep!.velocity * 10 ** (-6 / 20))
  })

  it('applies probability deterministically and ratchets evenly', () => {
    let p = { ...project(), swing: 0 }
    const beat = p.clips[0].patternId!
    p = studio.execute(p, { type: 'drum.step.set', params: { patternId: beat, voice: 'kick', index: 0, probability: 50 } }).project
    // Seeds include the random clip ID, so stretch the clip to 64 bars: some
    // kicks play and some don't, whatever the seed.
    p = studio.execute(p, { type: 'clip.resize', params: { clipId: p.clips[0].id, length: 64 } }).project
    const kicks = () => collectEvents(p, 0, 64).filter((e) => e.kind === 'drum' && e.voice === 'kick' && Number.isInteger(e.bar)).map((e) => e.bar)
    const first = kicks()
    expect(first).toEqual(kicks())
    expect(first.length).toBeGreaterThan(0)
    expect(first.length).toBeLessThan(64)
    p = studio.execute(p, { type: 'drum.step.set', params: { patternId: beat, voice: 'clap', index: 4, ratchet: 4 } }).project
    const claps = collectEvents(p, 0, 1).filter((e) => e.kind === 'drum' && e.voice === 'clap').map((e) => e.bar)
    expect(claps.slice(0, 4).map((b) => Math.round(b * 64))).toEqual([16, 17, 18, 19])
  })

  it('plays launched scene slots instead of the arrangement for those tracks', () => {
    const p = { ...project(), swing: 0 }
    const groove = p.scenes[1]
    const events = collectEvents(p, 0, 1, { sceneId: groove.id, slots: groove.slots, start: 0 })
    expect(events.some((e) => e.kind === 'note' && e.trackId === p.tracks[0].id)).toBe(true)
    const stopped = collectEvents(p, 0, 1, { sceneId: null, slots: { [p.tracks[3].id]: null }, start: 0 })
    expect(stopped.some((e) => e.trackId === p.tracks[3].id)).toBe(false)
  })

  it('emits one audio event at the clip start', () => {
    let p = project()
    p = studio.execute(p, { type: 'track.add', params: { kind: 'audio', name: 'Vox' } }).project
    p = studio.execute(p, { type: 'asset.add', params: { asset: { id: 'v', name: 'v.wav', mimeType: 'audio/wav', bytes: 1, duration: 4, channels: 2, sampleRate: 44100, origin: { kind: 'import', createdAt: '' } } } }).project
    p = studio.execute(p, { type: 'clip.create', params: { trackId: 'Vox', start: 2, length: 2, assetId: 'v' } }).project
    expect(collectEvents(p, 0, 8).filter((e) => e.kind === 'audio')).toHaveLength(1)
    expect(collectEvents(p, 2.5, 8).filter((e) => e.kind === 'audio')).toHaveLength(0)
  })

  it('hashes consistently', () => {
    expect(chance('a')).toBe(chance('a'))
    expect(chance('a')).not.toBe(chance('b'))
  })
})

describe('chords', () => {
  it('carries chord intervals on note events', () => {
    let p = { ...project(), swing: 0 }
    const clip = p.clips.find((c) => p.patterns[c.patternId!]?.kind === 'notes')!
    p = studio.execute(p, { type: 'pattern.write', params: { patternId: clip.patternId, steps: 'C3:min7 . . . C3 . . . . . . . . . . .' } }).project
    const notes = collectEvents(p, clip.start, clip.start + 1).filter((e) => e.kind === 'note')
    expect(notes.map((e) => (e.kind === 'note' ? [...e.chord] : []))).toEqual([[0, 3, 7, 10], [0]])
  })
})

describe('loopSegments', () => {
  const round = (segments: ReturnType<typeof loopSegments>) => segments.map((s) => ({ ...s, at: +s.at.toFixed(4), from: +s.from.toFixed(4), length: +s.length.toFixed(4) }))

  it('plays straight through without a loop', () => {
    expect(loopSegments(0.5, 2, 0, 4, null)).toEqual([{ at: 0, from: 0.5, length: 2, cut: false }])
    // A clip longer than its source stops when the source runs out.
    expect(loopSegments(0, 3, 0, 1, null)).toEqual([{ at: 0, from: 0, length: 1, cut: false }])
    expect(loopSegments(0, 3, 1.5, 4, null)).toEqual([{ at: 0, from: 1.5, length: 1.5, cut: false }])
  })

  it('repeats a short sound to fill the clip, with silence after the sound', () => {
    // A 0.3 s sound looped every 0.5 s across 1.6 s.
    expect(round(loopSegments(0, 1.6, 0, 0.3, { start: 0, length: 0.5 }))).toEqual([
      { at: 0, from: 0, length: 0.3, cut: false },
      { at: 0.5, from: 0, length: 0.3, cut: false },
      { at: 1, from: 0, length: 0.3, cut: false },
      { at: 1.5, from: 0, length: 0.1, cut: true },
    ])
  })

  it('cuts a long sound at the loop point and starts mid-loop when skipping in', () => {
    expect(round(loopSegments(0, 2, 0.75, 4, { start: 0, length: 0.5 }))).toEqual([
      { at: 0, from: 0.25, length: 0.25, cut: true },
      { at: 0.25, from: 0, length: 0.5, cut: true },
      { at: 0.75, from: 0, length: 0.5, cut: true },
    ])
  })

  it('keeps split halves in phase through the offset', () => {
    const loop = { start: 1, length: 0.5 }
    const whole = round(loopSegments(1, 2, 0, 4, loop))
    const right = round(loopSegments(1 + 0.8, 1.2, 0, 4, loop)).map((s) => ({ ...s, at: +(s.at + 0.8).toFixed(4) }))
    expect(whole.filter((s) => s.at >= 0.8).map((s) => s.from)).toEqual(right.filter((s) => s.at > 0.8).map((s) => s.from))
    expect(right[0].from).toBeCloseTo(1.3)
  })

  it('emits one audio event that carries the loop', () => {
    let p = project()
    p = studio.execute(p, { type: 'track.add', params: { kind: 'audio', name: 'Hit' } }).project
    p = studio.execute(p, { type: 'asset.add', params: { asset: { id: 'h', name: 'h.wav', mimeType: 'audio/wav', bytes: 1, duration: 0.3, channels: 2, sampleRate: 44100, origin: { kind: 'import', createdAt: '' } } } }).project
    const created = studio.execute(p, { type: 'clip.create', params: { trackId: 'Hit', start: 0, length: 4, assetId: 'h' } })
    p = studio.execute(created.project, { type: 'clip.loop', params: { clipId: (created.results[0] as { clipId: string }).clipId, length: 0.25 } }).project
    const events = collectEvents(p, 0, 8).filter((e) => e.kind === 'audio')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ length: 4, loop: { start: 0, length: 0.25 } })
  })
})

describe('render helpers', () => {
  it('estimates longer tails for high delay feedback', () => {
    const p = project()
    const short = estimateTail({ ...p, returns: p.returns.map((r) => (r.kind === 'delay' ? { ...r, feedback: 0.2 } : r)) })
    const long = estimateTail({ ...p, returns: p.returns.map((r) => (r.kind === 'delay' ? { ...r, feedback: 0.9 } : r)) })
    expect(long).toBeGreaterThan(short)
    expect(long).toBeLessThanOrEqual(12)
  })

  it('isolates a track with its groups and silences other tracks’ sends', () => {
    let p = project()
    p = studio.execute(p, { type: 'track.add', params: { kind: 'group', name: 'Bus' } }).project
    const bus = p.tracks.at(-1)!.id
    p = studio.execute(p, { type: 'mixer.set', params: { trackId: '808', output: bus } }).project
    p = studio.execute(p, { type: 'send.set', params: { trackId: 'Acid 2', returnId: 'delay', level: 0.5, tap: 'pre' } }).project
    const isolated = isolateTrack(p, p.tracks[3].id)
    const audible = isolated.tracks.filter((t) => studio.isTrackAudible(isolated, t)).map((t) => t.name)
    expect(audible).toEqual(['808', 'Bus'])
    expect(isolated.tracks[1].mixer.sends.delay.level).toBe(0)
  })
})

describe('encodeWav', () => {
  it('writes 16- and 24-bit PCM with a correct header and deterministic dither', () => {
    const left = new Float32Array([0, 0.5, -0.5, 1])
    const right = new Float32Array([0, -0.25, 0.25, -1])
    const a = new DataView(encodeWav([left, right], 48000, 16, { seed: 7 }))
    const b = new DataView(encodeWav([left, right], 48000, 16, { seed: 7 }))
    expect(a.getUint32(24, true)).toBe(48000)
    expect(a.getUint16(34, true)).toBe(16)
    expect(a.byteLength).toBe(44 + 4 * 2 * 2)
    expect(new Uint8Array(a.buffer)).toEqual(new Uint8Array(b.buffer))
    const c = new DataView(encodeWav([left, right], 44100, 24, { dither: false }))
    expect(c.getUint16(34, true)).toBe(24)
    const sample = c.getUint8(44 + 6) | (c.getUint8(44 + 7) << 8) | (c.getInt8(44 + 8) << 16)
    expect(sample).toBe(Math.round(0.5 * 0x7fffff))
  })
})
