import { describe, expect, it } from 'vitest'
import { describeStep } from './steps'

describe('describeStep', () => {
  it('describes reads, renders, and Ismail calls from either agent', () => {
    expect(describeStep('project_summary')).toBe('Reading the project')
    expect(describeStep('mcp__reborn__track_get', { trackId: 'Acid 1' })).toBe('Reading track Acid 1')
    expect(describeStep('mcp__reborn__analysis_run', { from: 1 })).toBe('Rendering and measuring the mix')
    expect(describeStep('ismail_generate', { name: 'Sub', instrument: 'acid_bass' })).toBe('Generating Sub with Ismail (acid_bass)')
    expect(describeStep('mcp__reborn__ismail_generate', { name: 'Wub', instrument: { type: 'code', voice: 'growl' } })).toBe('Generating Wub with Ismail (growl)')
  })

  it('counts changes and edits in a proposal', () => {
    expect(describeStep('mcp__reborn__edit_batch', { intent: 'Build a 16-bar song', changes: [{ commands: [1, 2] }, { commands: [3] }] })).toBe('Proposing: Build a 16-bar song (2 changes, 3 edits)')
    expect(describeStep('propose_changes', { intent: 'Tame the hats', changes: [{ commands: [1] }] })).toBe('Proposing: Tame the hats (1 change, 1 edit)')
  })

  it('falls back to the tool name with its intent or target', () => {
    expect(describeStep('mcp__reborn__pattern_write', { trackId: 'Acid 1', intent: 'Darker verse line' })).toBe('Pattern write: Darker verse line')
    expect(describeStep('mcp__reborn__mixer_set', { trackId: '909' })).toBe('Mixer set (909)')
    expect(describeStep('ToolSearch')).toBe('ToolSearch')
  })
})
