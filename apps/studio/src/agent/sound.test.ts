import { describe, expect, it } from 'vitest'
import { agentProblem, checkNotes, extractJson, resolveInstrument, validateDraft } from './sound'

const catalog = {
  presets: [{ name: 'acid_bass', type: 'synth' }, { name: 'kick', type: 'kick' }],
  voices: [{ name: 'growl', family: 'built-in/bass', summary: 'Wobbly bass' }],
}

describe('checkNotes', () => {
  it('accepts notes, chords, velocities, and comments', () => {
    expect(checkNotes('0 C2 0.5 110; 0.5 F#2 0.5\n1 C3,E3,G3 2 # chord')).toBeNull()
  })

  it('names the problem in a bad note', () => {
    expect(checkNotes('')).toMatch(/no notes/)
    expect(checkNotes('0 C2')).toMatch(/needs start, pitch, length/)
    expect(checkNotes('0 H2 1')).toMatch(/"H2" is not a pitch/)
    expect(checkNotes('0 C2 0')).toMatch(/length must be a positive/)
    expect(checkNotes('0 C2 1 200')).toMatch(/velocity/)
    expect(checkNotes('-1 C2 1')).toMatch(/start must be/)
  })
})

describe('resolveInstrument', () => {
  it('maps presets and voices as a model may write them', () => {
    expect(resolveInstrument('acid_bass', catalog)).toBe('preset:acid_bass')
    expect(resolveInstrument('Acid Bass', catalog)).toBe('preset:acid_bass')
    expect(resolveInstrument('voice:growl', catalog)).toBe('voice:growl')
    expect(resolveInstrument('growl', catalog)).toBe('voice:growl')
    expect(resolveInstrument('voice:kick', catalog)).toBeNull()
    expect(resolveInstrument('theremin', catalog)).toBeNull()
  })
})

describe('validateDraft', () => {
  it('returns a usable draft with defaults', () => {
    expect(validateDraft({ instrument: 'kick', notes: '0 C1 0.25 120; 1 C1 0.25 120', summary: 'Two kicks.' }, catalog)).toEqual({
      instrument: 'preset:kick',
      notes: '0 C1 0.25 120; 1 C1 0.25 120',
      name: 'kick',
      tailSeconds: 1,
      summary: 'Two kicks.',
    })
    expect(validateDraft({ instrument: 'growl', notes: '0 C1 4', name: 'Wub', tailSeconds: 30 }, catalog)).toMatchObject({ name: 'Wub', tailSeconds: 10 })
  })

  it('explains what to fix', () => {
    expect(validateDraft(null, catalog)).toMatch(/JSON object/)
    expect(validateDraft({ instrument: 'theremin', notes: '0 C2 1' }, catalog)).toMatch(/not an instrument/)
    expect(validateDraft({ instrument: 'kick', notes: '0 C1' }, catalog)).toMatch(/needs start/)
  })
})

describe('extractJson', () => {
  it('finds the object in prose and code fences', () => {
    expect(extractJson('Here you go:\n```json\n{"a": 1}\n```')).toEqual({ a: 1 })
    expect(extractJson('Sure. {"a": {"b": 2}} Enjoy.')).toEqual({ a: { b: 2 } })
    expect(extractJson('no json')).toBeNull()
  })
})

describe('agentProblem', () => {
  const base = { provider: 'anthropic' as const, model: '', baseUrl: '', directEdits: false, shareMeasurements: false, otherMcp: false, hasKey: true, cliAvailable: true }
  it('says what to set up before the agent can run', () => {
    expect(agentProblem(base)).toBeNull()
    expect(agentProblem({ ...base, hasKey: false })).toMatch(/API key/)
    expect(agentProblem({ ...base, provider: 'claude-cli', cliAvailable: false })).toMatch(/claude command/)
    expect(agentProblem({ ...base, provider: 'openai-compatible' })).toMatch(/model/)
  })
})
