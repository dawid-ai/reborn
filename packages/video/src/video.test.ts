import { describe, expect, it } from 'vitest'
import { studio } from '@reborn/studio-core'
import { buildCues, pulse } from './cues'
import { analyzeMix, featureAt, waveRows } from './features'
import { LOOKS, lookById, parseLook } from './looks'
import { buildSceneSource } from './renderer'
import { chapters, footageCredits, keyMoments } from './stills'
import { Timeline } from './timeline'

function song(): studio.StudioProject {
  let project = studio.emptyStudioProject('Cue test')
  project.tempo = 150
  project.swing = 0
  project.length = 8
  project.sections = [
    { id: 'sec_build', name: 'Build', start: 0, length: 4, color: '#555' },
    { id: 'sec_drop', name: 'Drop', start: 4, length: 4, color: '#555' },
  ]
  const run = (commands: studio.Command[]) => (project = studio.executeBatch(project, commands).project)
  run([
    { type: 'track.add', params: { kind: 'drum', name: 'Drums' }, ref: 'drums' },
    { type: 'clip.create', params: { trackId: '$drums.trackId', start: 4, length: 4, name: 'Drop beat' }, ref: 'beat' },
    { type: 'pattern.write', params: { patternId: '$beat.patternId', voice: 'kick', steps: 'X.........x.....' } },
    { type: 'pattern.write', params: { patternId: '$beat.patternId', voice: 'clap', steps: '....x.......x...' } },
    { type: 'track.add', params: { kind: 'drum', name: 'Muted' }, ref: 'muted' },
    { type: 'clip.create', params: { trackId: '$muted.trackId', start: 0, length: 8, name: 'Ghost' }, ref: 'ghost' },
    { type: 'pattern.write', params: { patternId: '$ghost.patternId', voice: 'kick', steps: 'XXXXXXXXXXXXXXXX' } },
    { type: 'mixer.set', params: { trackId: '$muted.trackId', mute: true } },
    { type: 'track.add', params: { kind: 'audio', name: 'FX' }, ref: 'fx' },
    { type: 'asset.add', params: { asset: { id: 'ast_riser', name: 'White Riser.wav', mimeType: 'audio/wav', bytes: 1, duration: 6.4, channels: 2, sampleRate: 44100, origin: { kind: 'import', createdAt: '' } } } },
    { type: 'asset.add', params: { asset: { id: 'ast_impact', name: 'Big Impact.wav', mimeType: 'audio/wav', bytes: 1, duration: 2, channels: 2, sampleRate: 44100, origin: { kind: 'import', createdAt: '' } } } },
    { type: 'clip.create', params: { trackId: '$fx.trackId', start: 0, length: 4, assetId: 'ast_riser' } },
    { type: 'clip.create', params: { trackId: '$fx.trackId', start: 4, length: 1, assetId: 'ast_impact' } },
  ])
  return project
}

describe('cues', () => {
  it('times drum hits like the scheduler and leaves out muted tracks', () => {
    const cues = buildCues(song())
    const bar = 1.6
    const sixteenth = bar / 16
    expect(cues.barSeconds).toBeCloseTo(bar)
    expect([...cues.channels.kick].slice(0, 2)).toEqual([4 * bar, 4 * bar + 10 * sixteenth].map((v) => Math.round(v * 1e5) / 1e5))
    expect(cues.channels.kick).toHaveLength(8)
    expect(cues.channels.snare[0]).toBeCloseTo(4 * bar + 4 * sixteenth)
    expect(cues.channels.bar).toHaveLength(9)
  })

  it('finds impacts and risers by clip name', () => {
    const cues = buildCues(song(), [10])
    expect([...cues.channels.impact]).toEqual([6.4, 10])
    expect(cues.risers).toEqual([[0, 6.4]])
  })

  it('decays pulses after each hit', () => {
    const cues = buildCues(song())
    const hit = cues.channels.kick[0]
    expect(pulse(cues, 'kick', hit).value).toBeCloseTo(1)
    expect(pulse(cues, 'kick', hit + 0.1).value).toBeCloseTo(Math.exp(-0.7))
    expect(pulse(cues, 'kick', hit - 0.1)).toEqual({ value: 0, since: 99 })
  })
})

describe('looks', () => {
  it('parses every built-in look header', () => {
    expect(LOOKS.map((l) => l.id).sort()).toEqual(['acid-vortex', 'footage-grade', 'footage-kaleido', 'grid-tunnel', 'julia-drift', 'neon-kaleido', 'shock-ring', 'star-sparkle', 'strobe-deck', 'vein-tunnel', 'wave-ring'])
    const vein = lookById('vein-tunnel')!
    expect(vein).toMatchObject({ title: 'Vein Tunnel', layer: false, fits: ['drop', 'heavy'] })
    expect(vein.params.find((p) => p.name === 'colB')).toMatchObject({ default: [0.85, 0.05, 0.18] })
    expect(lookById('shock-ring')?.layer).toBe(true)
  })

  it('builds one program with prefixed uniforms for each look', () => {
    const source = buildSceneSource([lookById('vein-tunnel')!, lookById('shock-ring')!])
    expect(source.startsWith('#version 300 es')).toBe(true)
    expect(source).toContain('uniform vec3 L0_colB;')
    expect(source).toContain('uniform float L1_speed;')
    expect(source).toContain('if(id==1) return look_1(uv);')
  })

  it('reads params with descriptions', () => {
    const look = parseLook('x/test.glsl', '// @title Test\n// @fits layer: any\n// @param gain 1,2   how loud\nvec3 look(vec2 uv){return vec3(0.);}')
    expect(look).toMatchObject({ id: 'test', layer: true, params: [{ name: 'gain', default: [1, 2], description: 'how loud' }] })
  })
})

describe('timeline', () => {
  function board(project: studio.StudioProject) {
    const next = studio.executeBatch(project, [
      { type: 'video.storyboard.create', params: { empty: true } },
      { type: 'video.scene.add', params: { start: { sectionId: 'Build' }, look: 'julia-drift', params: { zoom: '1.6-x' }, post: { white: 'rise' } } },
      { type: 'video.scene.add', params: { start: { sectionId: 'Drop' }, look: 'strobe-deck', cutOn: ['kick', 'snare'], travel: { base: 1, kick: 2 } } },
      { type: 'video.scene.add', params: { start: { sectionId: 'Drop', bars: 2 }, look: 'no-such-look' } },
      { type: 'video.text.add', params: { start: { sectionId: 'Drop' }, end: { sectionId: 'Drop', at: 'end' }, text: 'ONE|TWO|THREE', style: 'words', on: ['kick'] } },
    ]).project
    return new Timeline(next, studio.requireStoryboard(next))
  }

  it('times scenes from section markers and reports unknown looks', () => {
    const timeline = board(song())
    expect(timeline.scenes.map((s) => [Math.round(s.t0 * 1000) / 1000, s.look?.id ?? null])).toEqual([
      [0, 'julia-drift'],
      [6.4, 'strobe-deck'],
      [9.6, null],
    ])
    expect(timeline.warnings.join(' ')).toMatch(/unknown look, "no-such-look"/)
    expect(timeline.looks.map((l) => l.id)).toEqual(['julia-drift', 'strobe-deck'])
  })

  it('evaluates scene expressions with scene-relative time and riser progress', () => {
    const timeline = board(song())
    const build = timeline.scenes[0]
    const scope = timeline.scope(3.2, build)
    expect(scope).toMatchObject({ L: 3.2, x: 0.5, rise: 0.5 })
    expect(build.params.find((p) => p.name === 'zoom')!.fn(scope)).toEqual([1.1])
    expect(build.post.white(scope)).toBe(0.5)
    expect(scope.toImpact).toBeCloseTo(3.2)
  })

  it('counts cut events inside a scene and integrates camera travel', () => {
    const timeline = board(song())
    const drop = timeline.scenes[1]
    // The kick on the scene's first frame starts it; the clap on step 4 is the first cut.
    expect(drop.cuts[0]).toBeCloseTo(6.4 + 4 * 0.1)
    const scope = timeline.scope(6.4 + 0.45, drop)
    expect(scope.cut).toBe(1)
    expect(scope.cutT).toBeCloseTo(0.05)
    expect(timeline.pushAt(9)).toBeGreaterThan(timeline.pushAt(8))
    expect(timeline.texts[0].events.length).toBeGreaterThan(0)
  })
})

describe('audio features', () => {
  it('puts a 100 Hz tone in the bass band and silence at zero', async () => {
    const rate = 22050
    const tone = new Float32Array(rate * 2)
    for (let i = rate; i < tone.length; i += 1) tone[i] = 0.5 * Math.sin((2 * Math.PI * 100 * i) / rate)
    const features = await analyzeMix([tone, tone], rate, 30)
    expect(featureAt(features, 'bass', 1.8)).toBeGreaterThan(0.8)
    expect(featureAt(features, 'air', 1.8)).toBeLessThan(0.2)
    expect(featureAt(features, 'bass', 0.3)).toBeLessThan(0.05)
    expect(featureAt(null, 'bass', 1)).toBe(0)
    const rows = waveRows(features, 1.5)
    expect(Math.max(...rows.slice(0, 512))).toBeGreaterThan(0.9)
  })
})

describe('footage in scenes', () => {
  function withFootage() {
    let project = studio.executeBatch(song(), [
      { type: 'video.storyboard.create', params: { empty: true } },
      { type: 'video.storyboard.update', params: { brief: { footage: { enabled: true } } } },
    ]).project
    const clip = (sourceId: string, duration: number) => ({ provider: 'pexels', sourceId, title: `Clip ${sourceId}`, page: `https://www.pexels.com/video/${sourceId}/`, author: 'A. Filmer', licence: 'pexels', licenceName: 'Pexels License', url: `https://videos.pexels.com/${sourceId}.mp4`, duration, skip: 0 })
    const added = studio.execute(project, { type: 'video.footage.add', params: { clips: [clip('1', 20), clip('2', 30)] } })
    const ids = (added.results[0] as { clipIds: string[] }).clipIds
    project = added.project
    for (const [i, id] of ids.entries()) {
      project = studio.executeBatch(project, [
        { type: 'video.footage.review', params: { clipId: id, status: 'approved' } },
        { type: 'video.footage.fetched', params: { clipId: id, file: { id: `vfl_${i}`, kind: 'footage', name: `${i}.mp4`, mimeType: 'video/mp4', bytes: 1, width: 1920, height: 1080, duration: i ? 30 : 20 } } },
      ]).project
    }
    project = studio.execute(project, { type: 'video.scene.add', params: { start: { sectionId: 'Drop' }, look: 'footage-grade', clips: ids, cutOn: ['kick'], clipStart: 2 } }).project
    return { project, ids }
  }

  it('moves to the next clip on each cut and plays forward from the start point', () => {
    const { project } = withFootage()
    const timeline = new Timeline(project, studio.requireStoryboard(project))
    const scene = timeline.scenes[0]
    const first = timeline.footageAt(6.5, scene, timeline.scope(6.5, scene))
    expect(first).toMatchObject({ fileId: 'vfl_0' })
    expect(first!.seconds).toBeCloseTo(2.1)
    const afterCut = scene.cuts[0] + 0.25
    expect(timeline.footageAt(afterCut, scene, timeline.scope(afterCut, scene))).toMatchObject({ fileId: 'vfl_1', seconds: 2.25 })
  })

  it('credits only the clips scenes use', () => {
    const { project } = withFootage()
    const credits = footageCredits(studio.requireStoryboard(project))
    expect(credits).toContain('"Clip 1" by A. Filmer (pexels), Pexels License')
    expect(credits.split(String.fromCharCode(10))).toHaveLength(3)
  })
})

describe('look-dev helpers', () => {
  it('picks a still per scene, impact, and text item, in time order', () => {
    const project = studio.executeBatch(song(), [
      { type: 'video.storyboard.create', params: {} },
      { type: 'video.text.add', params: { start: { sectionId: 'Drop', bars: 1 }, text: 'TITLE' } },
    ]).project
    const moments = keyMoments(new Timeline(project, studio.requireStoryboard(project)))
    // The impact clip sits on the drop's first beat, so they share a still.
    expect(moments.map((m) => m.label)).toEqual(['Build', 'Impact · Drop', 'Text: TITLE'])
    expect(moments[1].seconds).toBeCloseTo(6.4 + 1 / 30)
  })

  it('lists sections as chapters starting at 0:00', () => {
    const project = song()
    project.sections = project.sections.map((s) => ({ ...s, start: s.start + 2 }))
    expect(chapters(project)).toBe(['0:00 Intro', '0:03 Build', '0:09 Drop'].join(String.fromCharCode(10)))
  })
})
