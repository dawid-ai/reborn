import { describe, expect, it } from 'vitest'
import { executeBatch, execute, listCommands } from './commands'
import { createDefaultStudioProject, emptyStudioProject, newId, type StudioProject } from './model'
import { migrateStudioProject } from './migrate'
import { compileExpr, compileValue } from './video-expr'
import { formatTimeRef, requireStoryboard, resolveTimeRef, sectionRole, timeRefSeconds } from './video'

function song(): StudioProject {
  const project = emptyStudioProject('Psych Drop')
  project.tempo = 150
  project.length = 48
  project.sections = [
    { id: 'sec_intro', name: 'Intro', start: 0, length: 8, color: '#555' },
    { id: 'sec_build', name: 'Build 1', start: 8, length: 8, color: '#555' },
    { id: 'sec_drop', name: 'Drop 1', start: 16, length: 16, color: '#555' },
    { id: 'sec_drop2', name: 'Drop 2', start: 32, length: 16, color: '#555' },
  ]
  return project
}

describe('video expressions', () => {
  const scope = { t: 2, kick: 0.5, x: 0.25, rise: 1, toImpact: 0.4, BAR: 1.6 }

  it('evaluates arithmetic with Python-style power, modulo, and ternaries', () => {
    expect(compileExpr('1 + 2 * 3')(scope)).toBe(7)
    expect(compileExpr('-2 ** 2')(scope)).toBe(-4)
    expect(compileExpr('2 ** 3 ** 2')(scope)).toBe(512)
    expect(compileExpr('-1 % 3')(scope)).toBe(2)
    expect(compileExpr('0.85*max(0, 1-toImpact/0.8)**2 if rise > 0 else 0')(scope)).toBeCloseTo(0.2125)
    expect(compileExpr('kick > 0.4 ? 10 : 20')(scope)).toBe(10)
    expect(compileExpr('not (x < 0.5) or kick == 0.5')(scope)).toBe(1)
  })

  it('reads variables and calls the allowed functions', () => {
    expect(compileExpr('smooth(0, 4, t)')(scope)).toBeCloseTo(0.5)
    expect(compileExpr('clamp(t)')(scope)).toBe(1)
    expect(compileExpr('mix(10, 20, x)')(scope)).toBe(12.5)
    expect(compileExpr('fract(t % BAR)')(scope)).toBeCloseTo(0.4)
    expect(compileExpr('1.344*exp(-(6.2*x*x+1.2*x))*(1-.04*kick)')(scope)).toBeCloseTo(1.344 * Math.exp(-(6.2 * 0.0625 + 0.3)) * 0.98)
  })

  it('rejects unknown names, functions, and syntax instead of running them', () => {
    expect(() => compileExpr('window.close()')).toThrow(/Unexpected "\."|Unknown/)
    expect(() => compileExpr('constructor')).toThrow(/Unknown name "constructor"/)
    expect(() => compileExpr('eval(1)')).toThrow(/Unknown function "eval"/)
    expect(() => compileExpr('1 +')).toThrow(/Unexpected end/)
    expect(() => compileExpr('sin(1, 2)')).toThrow(/takes 1 arguments/)
    expect(() => compileExpr('a'.repeat(500))).toThrow(/limited/)
  })

  it('compiles vectors that mix numbers and expressions', () => {
    expect(compileValue([0.5, 'kick*2'])(scope)).toEqual([0.5, 1])
    expect(compileValue('1/0')(scope)).toEqual([0])
  })
})

describe('video time references', () => {
  it('anchors to section starts and ends, and to the song start', () => {
    const project = song()
    expect(resolveTimeRef(project, { sectionId: 'sec_drop', at: 'start', bars: 8 })).toBe(24)
    expect(resolveTimeRef(project, { sectionId: 'sec_build', at: 'end', bars: -1 })).toBe(15)
    expect(resolveTimeRef(project, { sectionId: null, at: 'start', bars: 4 })).toBe(4)
    expect(resolveTimeRef(project, { sectionId: 'sec_gone', at: 'start', bars: 0 })).toBeNull()
    expect(timeRefSeconds(project, { sectionId: 'sec_drop', at: 'start', bars: 0 })).toBeCloseTo(16 * 1.6)
    expect(formatTimeRef(project, { sectionId: 'sec_drop', at: 'start', bars: 8 })).toBe('Drop 1 + 8 bars')
  })

  it('follows sections when they move', () => {
    const project = song()
    const moved = execute(project, { type: 'section.update', params: { sectionId: 'sec_drop', start: 20 } }).project
    expect(resolveTimeRef(moved, { sectionId: 'sec_drop', at: 'start', bars: 8 })).toBe(28)
  })

  it('maps section names to roles', () => {
    expect(['Intro', 'Build 2', 'Drop 3', 'Fast switch', 'Psych bridge', 'Outro', 'Verse'].map(sectionRole)).toEqual(['intro', 'build', 'drop', 'switch', 'bridge', 'outro', 'bridge'])
  })
})

describe('video commands', () => {
  it('creates a storyboard with one preset scene per section', () => {
    const { project, results } = execute(song(), { type: 'video.storyboard.create', params: {} }, { origin: 'agent' })
    const board = requireStoryboard(project)
    expect(results[0]).toEqual({ storyboardId: board.id })
    expect(project.video?.activeId).toBe(board.id)
    expect(board.scenes.map((s) => s.look)).toEqual(['julia-drift', 'julia-drift', 'vein-tunnel', 'neon-kaleido'])
    expect(board.scenes[1].post.strobe).toBe('rstrobe')
    expect(project.audit.at(-1)).toMatchObject({ origin: 'agent', commands: ['video.storyboard.create'] })
  })

  it('adds, updates, and removes scenes atomically with references', () => {
    const start = execute(song(), { type: 'video.storyboard.create', params: { empty: true } }).project
    const { project } = executeBatch(start, [
      { type: 'video.scene.add', params: { start: { sectionId: 'Drop 1', bars: 8 }, look: 'acid-vortex', params: { arms: 7, colA: [1, 'kick', 0] } }, ref: 'late' },
      { type: 'video.scene.add', params: { start: { sectionId: 'Drop 1' } } },
      { type: 'video.scene.update', params: { sceneId: '$late.sceneId', post: { ca: '0.004+0.006*kick', shake: 0.01 }, travel: { kick: 2 }, cutOn: ['kick', 'snare'] } },
    ])
    const board = requireStoryboard(project)
    expect(board.scenes.map((s) => s.look)).toEqual(['vein-tunnel', 'acid-vortex'])
    expect(board.scenes[1]).toMatchObject({ params: { arms: 7, colA: [1, 'kick', 0] }, post: { ca: '0.004+0.006*kick', shake: 0.01 }, cutOn: ['kick', 'snare'] })
    expect(board.scenes[1].travel.kick).toBe(2)

    const reset = execute(project, { type: 'video.scene.update', params: { sceneId: board.scenes[1].id, look: 'grid-tunnel', post: { shake: null } } }).project
    expect(requireStoryboard(reset).scenes[1]).toMatchObject({ look: 'grid-tunnel', params: {}, post: { ca: '0.004+0.006*kick' } })

    const removed = execute(reset, { type: 'video.scene.remove', params: { sceneId: board.scenes[0].id } }).project
    expect(requireStoryboard(removed).scenes).toHaveLength(1)
  })

  it('rejects unsafe or malformed values and leaves the project unchanged', () => {
    const start = execute(song(), { type: 'video.storyboard.create', params: {} }).project
    const sceneId = requireStoryboard(start).scenes[0].id
    expect(() => executeBatch(start, [{ type: 'video.scene.update', params: { sceneId, params: { zoom: 'process.exit()' } } }])).toThrow(/Unexpected|Unknown/)
    expect(() => execute(start, { type: 'video.scene.update', params: { sceneId, post: { blur: 1 } } })).toThrow(/not a post setting/)
    expect(() => execute(start, { type: 'video.scene.update', params: { sceneId, look: '../evil' } })).toThrow(/not a look ID/)
    expect(() => execute(start, { type: 'video.scene.update', params: { sceneId, cutOn: ['downbeat'] } })).toThrow(/must be one of kick/)
    expect(() => execute(start, { type: 'video.scene.add', params: { start: { sectionId: 'Chorus' } } })).toThrow(/No section "Chorus"/)
  })

  it('adds text, duplicates a storyboard as vertical, and removes it again', () => {
    let project = execute(song(), { type: 'video.storyboard.create', params: {} }).project
    project = execute(project, { type: 'video.text.add', params: { start: { sectionId: 'sec_drop' }, text: 'PSYCH\nDROP', style: 'slam', blend: 'difference', size: 330 } }).project
    const main = requireStoryboard(project)
    expect(main.text[0]).toMatchObject({ text: 'PSYCH\nDROP', style: 'slam', blend: 'difference', end: { sectionId: 'sec_drop', bars: 2 } })

    project = execute(project, { type: 'video.storyboard.duplicate', params: { name: 'Vertical', width: 1080, height: 1920 } }).project
    const vertical = requireStoryboard(project)
    expect(vertical).toMatchObject({ name: 'Vertical', width: 1080, height: 1920 })
    expect(vertical.scenes[0].id).not.toBe(main.scenes[0].id)
    expect(vertical.text[0].text).toBe('PSYCH\nDROP')

    project = execute(project, { type: 'video.storyboard.activate', params: { storyboardId: main.id } }).project
    expect(requireStoryboard(project).id).toBe(main.id)
    project = execute(project, { type: 'video.text.update', params: { textId: main.text[0].id, style: 'words', on: ['snare'], text: 'PSYCH|DROP' } }).project
    expect(requireStoryboard(project).text[0]).toMatchObject({ style: 'words', on: ['snare'], text: 'PSYCH|DROP' })
    project = execute(project, { type: 'video.text.remove', params: { textId: main.text[0].id } }).project
    expect(requireStoryboard(project).text).toHaveLength(0)

    project = execute(project, { type: 'video.storyboard.remove', params: { storyboardId: main.id } }).project
    expect(project.video?.activeId).toBe(vertical.id)
  })

  it('describes the expression language and settings', () => {
    const { results, changed } = execute(song(), { type: 'video.reference', params: {} })
    expect(changed).toBe(false)
    expect(results[0]).toMatchObject({ functions: expect.arrayContaining(['smooth']), cutEvents: expect.arrayContaining(['kick']) })
  })

  it('updates the brief, stage, fade, and impacts', () => {
    let project = execute(song(), { type: 'video.storyboard.create', params: {} }).project
    project = execute(project, { type: 'video.storyboard.update', params: { stage: 'treatment', brief: { mood: 'dark' }, fade: 'min(1, t/6.4)', impacts: [{ sectionId: 'Drop 2', bars: 8 }], width: 1279 } }).project
    expect(requireStoryboard(project)).toMatchObject({ stage: 'treatment', brief: { goal: '', mood: 'dark' }, fade: 'min(1, t/6.4)', impacts: [{ sectionId: 'sec_drop2', bars: 8 }], width: 1280 })
  })

  it('reads storyboards with resolved times and flags scenes whose section is gone', () => {
    let project = execute(song(), { type: 'video.storyboard.create', params: {} }).project
    project = execute(project, { type: 'section.remove', params: { sectionId: 'sec_drop2' } }).project
    const { results } = execute(project, { type: 'video.get', params: {} })
    const read = results[0] as { storyboard: { scenes: { when: string; missingSection: boolean }[] } }
    expect(read.storyboard.scenes.map((s) => s.when)).toEqual(['Intro', 'Build 1', 'Drop 1', 'Missing section'])
    expect(read.storyboard.scenes[3].missingSection).toBe(true)
  })

  it('is listed for MCP and HTTP clients and survives a save round trip', () => {
    expect(listCommands().map((c) => c.type)).toContain('video.scene.update')
    const project = execute(createDefaultStudioProject(), { type: 'video.storyboard.create', params: {} }).project
    const reopened = migrateStudioProject(JSON.parse(JSON.stringify(project)))
    expect(reopened.video).toEqual(project.video)
    expect(migrateStudioProject(JSON.parse(JSON.stringify({ ...project, video: undefined }))).video).toBeUndefined()
  })

  it('creates a single scene when the song has no sections', () => {
    const project = execute({ ...emptyStudioProject(), id: newId('prj') }, { type: 'video.storyboard.create', params: {} }).project
    expect(requireStoryboard(project).scenes).toHaveLength(1)
  })
})
