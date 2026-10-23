import { beforeEach, describe, expect, it } from 'vitest'
import { studio } from '@reborn/studio-core'
import { describeCommands, describeEffect } from './proposalDiff'
import { addProposal, applyProposal, changePick, checkProposal, previewProject, toggleChange, toggleCommand } from './proposals'
import { getState, setState } from './store'

const fresh = () => studio.createDefaultStudioProject('Test')

describe('describeEffect', () => {
  it('names project, mixer, clip, and pattern changes in plain words', () => {
    const before = fresh()
    const { project: after } = studio.executeBatch(before, [
      { type: 'project.update', params: { tempo: 130, swing: 0.2 } },
      { type: 'mixer.set', params: { trackId: '909', volume: -4, mute: true } },
      { type: 'clip.create', params: { trackId: 'Wave', start: 4, length: 2, name: 'Pad' } },
    ])
    const lines = describeEffect(before, after)
    expect(lines).toContain('Tempo 124 → 130 BPM')
    expect(lines).toContain('Swing 8% → 20%')
    expect(lines).toContain('Mutes 909')
    expect(lines.some((line) => line.startsWith('909 volume') && line.endsWith('→ -4.0 dB'))).toBe(true)
    expect(lines).toContain('Adds the pattern “Pad”')
    expect(lines).toContain('Adds a clip on Wave at bar 5 (2 bars)')
  })

  it('returns nothing when nothing changed', () => {
    const project = fresh()
    expect(describeEffect(project, { ...project, revision: project.revision + 1 })).toEqual([])
  })
})

describe('describeCommands', () => {
  it('follows references between commands and keeps new IDs stable', () => {
    const steps = describeCommands(fresh(), [
      { type: 'clip.create', params: { trackId: 'Wave', start: 4, length: 4, name: 'Pad' }, ref: 'pad' },
      { type: 'pattern.write', params: { patternId: '$pad.patternId', steps: 'C3 . . .' } },
    ])
    expect(steps[0].error).toBeNull()
    expect(steps[1].error).toBeNull()
    expect(steps[1].lines).toContain('Rewrites the pattern “Pad” on Wave')
    expect(steps[1].lines.some((line) => line.startsWith('Adds') || line.startsWith('Removes'))).toBe(false)
  })

  it('reports a failing command and carries on', () => {
    const steps = describeCommands(fresh(), [
      { type: 'mixer.set', params: { trackId: 'No such track', volume: -3 } },
      { type: 'project.update', params: { tempo: 100 } },
    ])
    expect(steps[0].error).toBeTruthy()
    expect(steps[1].lines).toEqual(['Tempo 124 → 100 BPM'])
  })
})

describe('proposal picks', () => {
  beforeEach(() => setState({ project: fresh(), proposals: [], proposalPicks: {}, previewProposal: null, past: [], future: [] }))

  const propose = () =>
    addProposal({
      id: 'prp_test',
      source: 'agent',
      request: '',
      intent: 'Test',
      evidence: [],
      changes: [
        { id: 'c1', summary: 'Tempo', detail: '', commands: [{ type: 'project.update', params: { tempo: 130 } }] },
        {
          id: 'c2',
          summary: 'Pad',
          detail: '',
          commands: [
            { type: 'clip.create', params: { trackId: 'Wave', start: 4, length: 4, name: 'Pad' }, ref: 'pad' },
            { type: 'pattern.write', params: { patternId: '$pad.patternId', steps: 'C3 . . .' } },
            { type: 'mixer.set', params: { trackId: 'Wave', volume: -3 } },
          ],
        },
      ],
    })

  it('starts with every edit picked and preview off', () => {
    const proposal = propose()
    expect(getState().previewProposal).toBeNull()
    expect(changePick(proposal.id, proposal.changes[1])).toBe('all')
    expect(checkProposal(proposal)).toMatchObject({ error: null })
  })

  it('picks single edits inside a change and applies only those', () => {
    const proposal = propose()
    toggleCommand(proposal.id, 'c2', 2)
    expect(changePick(proposal.id, proposal.changes[1])).toBe('some')
    applyProposal(proposal.id)
    const project = getState().project
    expect(project.tempo).toBe(130)
    expect(project.tracks.find((t) => t.name === 'Wave')?.mixer.volume).toBe(fresh().tracks.find((t) => t.name === 'Wave')?.mixer.volume)
    expect(project.clips.length).toBe(fresh().clips.length + 1)
    expect(getState().proposals[0].status).toBe('partial')
  })

  it('reports picks that depend on an unpicked edit', () => {
    const proposal = propose()
    toggleCommand(proposal.id, 'c2', 0)
    const check = checkProposal(getState().proposals[0])
    expect(check.project).toBeNull()
    expect(check.error).toMatch(/pad/)
  })

  it('toggles a whole change, and previews only while asked', () => {
    const proposal = propose()
    toggleChange(proposal.id, proposal.changes[1])
    expect(changePick(proposal.id, proposal.changes[1])).toBe('none')
    expect(previewProject()).toBeNull()
    setState({ previewProposal: proposal.id })
    expect(previewProject()?.tempo).toBe(130)
    expect(getState().project.tempo).toBe(124)
  })
})
