import { describe, expect, it } from 'vitest'
import { type Command, execute, executeBatch, listCommands } from './commands'
import { type StudioProject, emptyStudioProject } from './model'
import { migrateStudioProject } from './migrate'
import { licenceAllowed, requireStoryboard } from './video'
import { footageBudget } from './video-commands'
import type { StoryboardTemplate } from './video-library'

function song(): StudioProject {
  const project = emptyStudioProject('Workflow')
  project.tempo = 150
  project.length = 32
  project.sections = [
    { id: 'sec_build', name: 'Build', start: 0, length: 8, color: '#555' },
    { id: 'sec_drop', name: 'Drop', start: 8, length: 16, color: '#555' },
    { id: 'sec_outro', name: 'Outro', start: 24, length: 8, color: '#555' },
  ]
  return execute(project, { type: 'video.storyboard.create', params: {} }).project
}

const run = (project: StudioProject, ...commands: Command[]) => executeBatch(project, commands)

const candidate = (patch: Record<string, unknown> = {}) => ({
  provider: 'pexels',
  sourceId: '123',
  title: 'Lightning storm',
  page: 'https://www.pexels.com/video/123/',
  author: 'Someone',
  licence: 'pexels',
  licenceName: 'Pexels License',
  url: 'https://videos.pexels.com/123.mp4',
  width: 1920,
  height: 1080,
  duration: 12,
  query: 'lightning storm',
  thumbnail: 'data:image/jpeg;base64,AAAA',
  ...patch,
})

const fileRecord = (id: string, kind = 'still', bytes = 1000) => ({ id, kind, name: `${id}.png`, mimeType: kind === 'footage' ? 'video/mp4' : 'image/png', bytes, width: 960, height: 540, seconds: 12.8 })

describe('stage gates and comments', () => {
  it('blocks approval while comments are open, and records an override', () => {
    let project = song()
    project = execute(project, { type: 'video.comment.add', params: { text: 'Make the drop more purple', target: { kind: 'scene', sceneId: requireStoryboard(project).scenes[1].id } } }).project
    expect(() => execute(project, { type: 'video.stage.approve', params: {} })).toThrow(/1 comment is still open/)
    const approved = execute(project, { type: 'video.stage.approve', params: { override: true } }).project
    expect(requireStoryboard(approved)).toMatchObject({ stage: 'treatment', approvals: [{ stage: 'brief', override: true }] })
  })

  it('lets the Director answer a comment so the user can approve', () => {
    let project = song()
    const { results } = execute(project, { type: 'video.comment.add', params: { text: 'No text in the outro' } })
    project = execute(project, { type: 'video.comment.add', params: { text: 'No text in the outro' } }).project
    const commentId = requireStoryboard(project).comments[0].id
    expect(results[0]).toHaveProperty('commentId')
    project = execute(project, { type: 'video.comment.reply', params: { commentId, text: 'Removed the outro credits.', status: 'addressed', author: 'director' } }).project
    expect(requireStoryboard(project).comments[0]).toMatchObject({ status: 'addressed', replies: [{ author: 'director', text: 'Removed the outro credits.' }] })
    project = execute(project, { type: 'video.stage.approve', params: {} }).project
    expect(requireStoryboard(project).stage).toBe('treatment')
    project = execute(project, { type: 'video.comment.resolve', params: { commentId, status: 'open' } }).project
    project = execute(project, { type: 'video.comment.remove', params: { commentId } }).project
    expect(requireStoryboard(project).comments).toHaveLength(0)
  })

  it('auto-approves only the stages the user listed, and reopens earlier stages', () => {
    let project = run(song(), { type: 'video.stage.approve', params: {} }, { type: 'video.storyboard.update', params: { autoAdvance: ['lookdev'] } }).project
    let out = execute(project, { type: 'video.stage.request', params: { summary: 'One row per section.' } })
    expect(out.results[0]).toEqual({ approved: false, stage: 'treatment' })
    expect(requireStoryboard(out.project).request?.summary).toBe('One row per section.')
    project = execute(out.project, { type: 'video.stage.approve', params: {} }).project
    out = execute(project, { type: 'video.stage.request', params: { summary: 'Stills look right.' } })
    expect(out.results[0]).toEqual({ approved: true, stage: 'draft' })
    expect(requireStoryboard(out.project).request).toBeNull()
    project = execute(out.project, { type: 'video.stage.reopen', params: { stage: 'lookdev' } }).project
    expect(requireStoryboard(project).stage).toBe('lookdev')
    expect(() => execute(project, { type: 'video.stage.reopen', params: { stage: 'final' } })).toThrow(/comes after/)
  })

  it('marks user-only commands so agents never get them', () => {
    const info = new Map(listCommands().map((c) => [c.type, c]))
    expect(info.get('video.stage.approve')).toMatchObject({ domain: 'video', userOnly: true })
    expect(info.get('video.footage.review')).toMatchObject({ userOnly: true })
    expect(info.get('video.stage.request')).toMatchObject({ domain: 'video', userOnly: false })
    expect(info.get('pattern.write')).toMatchObject({ domain: 'music', userOnly: false })
  })
})

describe('footage', () => {
  it('needs footage turned on and a licence the policy allows', () => {
    let project = song()
    expect(() => execute(project, { type: 'video.footage.add', params: { clips: [candidate()] } })).toThrow(/footage turned off/)
    project = execute(project, { type: 'video.storyboard.update', params: { brief: { footage: { enabled: true } } } }).project
    expect(() => execute(project, { type: 'video.footage.add', params: { clips: [candidate({ licence: 'cc-by-sa', licenceName: 'CC BY-SA 4.0', provider: 'wikimedia' })] } })).toThrow(/CC BY-SA 4.0.*does not allow/)
    expect(() => execute(project, { type: 'video.footage.add', params: { clips: [candidate({ url: 'http://insecure/x.mp4' })] } })).toThrow(/https/)
    expect(licenceAllowed('cc-by', 'attribution')).toBe(true)
    expect(licenceAllowed('cc-by-sa', 'attribution')).toBe(false)
    expect(licenceAllowed('other', 'sharealike')).toBe(false)
  })

  it('goes from candidate to approved to fetched, and plays in scenes', () => {
    let project = execute(song(), { type: 'video.storyboard.update', params: { brief: { footage: { enabled: true } } } }).project
    const added = execute(project, { type: 'video.footage.add', params: { clips: [candidate(), candidate()], author: 'director' } })
    const [clipId] = (added.results[0] as { clipIds: string[] }).clipIds
    project = added.project
    expect(requireStoryboard(project).footage).toHaveLength(1)
    expect(requireStoryboard(project).footage[0]).toMatchObject({ status: 'candidate', proposedBy: 'director' })
    expect(() => execute(project, { type: 'video.footage.fetched', params: { clipId, file: fileRecord('vfl_1', 'footage') } })).toThrow(/not been approved/)
    project = execute(project, { type: 'video.footage.review', params: { clipId, status: 'approved' } }).project
    project = execute(project, { type: 'video.footage.fetched', params: { clipId, file: fileRecord('vfl_1', 'footage', 40e6) } }).project
    const board = requireStoryboard(project)
    expect(board.footage[0]).toMatchObject({ status: 'fetched', fileId: 'vfl_1' })
    expect(project.video?.files.vfl_1.kind).toBe('footage')
    expect(footageBudget(project, board)).toMatchObject({ clips: 1, megabytes: 40 })

    const sceneId = board.scenes[1].id
    project = execute(project, { type: 'video.scene.update', params: { sceneId, look: 'footage-grade', clips: [clipId], clipStart: -1, clipOrder: 'shuffle' } }).project
    expect(requireStoryboard(project).scenes[1]).toMatchObject({ clips: [clipId], clipStart: 'random', clipOrder: 'shuffle' })
    expect(() => execute(project, { type: 'video.scene.update', params: { sceneId, clips: ['vft_nope'] } })).toThrow(/not a footage clip/)

    project = execute(project, { type: 'video.file.remove', params: { fileId: 'vfl_1' } }).project
    expect(requireStoryboard(project).footage[0]).toMatchObject({ status: 'approved', fileId: null })
    project = execute(project, { type: 'video.footage.update', params: { clipId, skip: 3, tags: ['storm'] } }).project
    expect(requireStoryboard(project).footage[0]).toMatchObject({ skip: 3, tags: ['storm'] })
    project = execute(project, { type: 'video.footage.review', params: { clipId, status: 'rejected' } }).project
    expect(requireStoryboard(project).scenes[1].clips).toEqual([])
    project = execute(project, { type: 'video.footage.remove', params: { clipId } }).project
    expect(requireStoryboard(project).footage).toHaveLength(0)
  })
})

describe('stills and templates', () => {
  it('registers stills on the storyboard and comments can point at them', () => {
    let project = execute(song(), { type: 'video.file.add', params: { file: fileRecord('vfl_still') } }).project
    expect(requireStoryboard(project).stills).toEqual(['vfl_still'])
    project = execute(project, { type: 'video.comment.add', params: { text: 'Too bright', target: { kind: 'still', fileId: 'vfl_still' } } }).project
    expect(requireStoryboard(project).comments[0].target).toEqual({ kind: 'still', fileId: 'vfl_still' })
    expect(() => execute(project, { type: 'video.file.add', params: { file: { ...fileRecord('x'), mimeType: 'text/html' } } })).toThrow(/not a supported/)
  })

  it('builds a storyboard from a library template by section role', () => {
    const template: StoryboardTemplate = {
      roles: { drop: [{ look: 'grid-tunnel', params: { twist: 0.3 }, layers: [], post: { bloom: 0.9 }, travel: { base: 1, kick: 2, snare: 1, bass: 0 }, cutOn: [], xfade: 0 }] },
      text: [{ ...{ text: 'DROP', style: 'slam', font: 'Big Shoulders Display', weight: 900, size: 300, pos: [0.5, 0.5], color: [1, 1, 1], on: ['beat'], blend: 'difference', glitch: 0.05, fadeIn: 0, fadeOut: 0, pulse: 0, tracking: 0 }, role: 'drop', offset: 0, length: 2 }],
      fade: 'min(1, t/4)',
      impact: { flash: 1, ca: 0.01, shake: 0.01 },
    }
    const project = execute(song(), { type: 'video.storyboard.create', params: { name: 'From template', template: { id: 'lib_tpl', version: 3, name: 'Dark drops', template } } }).project
    const board = requireStoryboard(project)
    expect(board.template).toEqual({ id: 'lib_tpl', version: 3, name: 'Dark drops' })
    expect(board.scenes.map((s) => s.look)).toEqual(['julia-drift', 'grid-tunnel', 'julia-drift'])
    expect(board.scenes[1]).toMatchObject({ params: { twist: 0.3 }, post: { bloom: 0.9 }, travel: { kick: 2 } })
    expect(board.text[0]).toMatchObject({ text: 'DROP', style: 'slam', start: { sectionId: 'sec_drop', bars: 0 }, end: { sectionId: 'sec_drop', bars: 2 } })
    expect(board.fade).toBe('min(1, t/4)')
  })
})

describe('normalizing saved video data', () => {
  it('fills fields that older storyboards lack', () => {
    const project = song()
    const old = JSON.parse(JSON.stringify(project))
    const board = old.video.storyboards[0]
    for (const key of ['comments', 'approvals', 'request', 'autoAdvance', 'footage', 'stills', 'template']) delete board[key]
    board.brief = { goal: 'Release video', mood: '', notes: '' }
    for (const scene of board.scenes) for (const key of ['clips', 'clipOrder', 'clipStart', 'clipSpeed', 'preset']) delete scene[key]
    delete old.video.files
    const reopened = migrateStudioProject(old)
    const fixed = requireStoryboard(reopened)
    expect(fixed).toMatchObject({ comments: [], approvals: [], request: null, footage: [], stills: [], brief: { goal: 'Release video', words: '', footage: { enabled: false, licences: 'safe' } } })
    expect(fixed.scenes[0]).toMatchObject({ clips: [], clipOrder: 'cycle', clipStart: 'random', clipSpeed: 1, preset: null })
    expect(reopened.video?.files).toEqual({})
  })
})
