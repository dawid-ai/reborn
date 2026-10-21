import { describe, expect, it } from 'vitest'
import { DIRECTOR_TOOLS, checkRoleCommands, roleAllows } from './director'

describe('agent roles', () => {
  it('keeps the Composer on music and the Director on video', () => {
    expect(roleAllows('composer', 'pattern.write')).toBe(true)
    expect(roleAllows('composer', 'video.scene.update')).toBe(false)
    expect(roleAllows('composer', 'video.get')).toBe(false)
    expect(roleAllows('director', 'video.scene.update')).toBe(true)
    expect(roleAllows('director', 'project.summary')).toBe(true)
    expect(roleAllows('director', 'pattern.write')).toBe(false)
    expect(roleAllows('director', 'mixer.trace')).toBe(false)
  })

  it('gives neither agent the user’s decisions', () => {
    for (const role of ['composer', 'director'] as const) {
      expect(roleAllows(role, 'video.stage.approve')).toBe(false)
      expect(roleAllows(role, 'video.footage.review')).toBe(false)
      expect(roleAllows(role, 'video.comment.remove')).toBe(false)
    }
  })

  it('refuses a batch with any command outside the role, and explains why', () => {
    expect(() => checkRoleCommands('director', [{ type: 'video.scene.add', params: {} }, { type: 'project.update', params: { tempo: 140 } }])).toThrow(/project.update: The Director edits only storyboards/)
    expect(() => checkRoleCommands('composer', [{ type: 'video.storyboard.create' }])).toThrow(/belong to the Director/)
  })

  it('marks the Director’s comments and footage as its own', () => {
    const [comment, reply, footage, scene] = checkRoleCommands('director', [
      { type: 'video.comment.add', params: { text: 'Done', author: 'user' } },
      { type: 'video.comment.reply', params: { commentId: 'c', text: 'Changed it' } },
      { type: 'video.footage.add', params: { clips: [] } },
      { type: 'video.scene.remove', params: { sceneId: 's' } },
    ])
    expect([comment.params?.author, reply.params?.author, footage.params?.author]).toEqual(['director', 'director', 'director'])
    expect(scene.params).toEqual({ sceneId: 's' })
  })

  it('describes every Director tool with a schema', () => {
    expect(DIRECTOR_TOOLS.map((t) => t.name)).toContain('video_stage_request')
    for (const tool of DIRECTOR_TOOLS) expect(tool.input_schema).toMatchObject({ type: 'object' })
  })
})
