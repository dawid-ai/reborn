import type { AgentContent, AgentMessage, AgentSettings, IsmailPresets } from '@reborn/studio-core'
import { desktop } from '../platform/desktop'

// Turns a plain description ("rubbery acid bassline in A minor") into an
// Ismail instrument and notes, using whichever agent provider is set up.

/** What the agent wrote: the Generate tab's fields. */
export interface SoundDraft {
  /** `preset:<name>` or `voice:<name>`, as the instrument list names them. */
  instrument: string
  notes: string
  name: string
  tailSeconds: number
  /** One sentence on what the agent wrote and why. */
  summary: string
}

export interface SoundContext {
  tempo: number
  /** What receives the sound: a Sampler chops it, an audio clip plays it on the timeline. */
  destination: 'sampler' | 'audio'
  /** Notes already in the fields, for "make it darker" follow-ups. */
  current?: { instrument: string; notes: string }
}

const PITCH = /^([A-Ga-g][#b]?-?\d|\d{1,3})$/
const NUMBER = /^-?\d+(\.\d+)?$/

/**
 * Checks notes against Ismail's notation (`start pitch length [velocity]`,
 * one per line or separated by `;`, `C3,E3,G3` for a chord). Returns the
 * first problem, or null when the notes are valid.
 */
export function checkNotes(notes: string): string | null {
  const entries = notes.split(/[;\n]/).map((raw) => raw.replace(/(^|\s)#.*$/, '').trim()).filter(Boolean)
  if (!entries.length) return 'There are no notes.'
  if (entries.length > 256) return 'Write at most 256 notes.'
  for (const entry of entries) {
    const parts = entry.split(/\s+/)
    if (parts.length < 3 || parts.length > 4) return `"${entry}" needs start, pitch, length, and an optional velocity.`
    const [start, pitch, length, velocity] = parts
    if (!NUMBER.test(start) || Number(start) < 0) return `"${entry}": the start must be a beat number of 0 or more.`
    if (!pitch.split(',').every((p) => PITCH.test(p))) return `"${entry}": "${pitch}" is not a pitch such as C3, F#2, or a chord such as C3,E3,G3.`
    if (!NUMBER.test(length) || !(Number(length) > 0)) return `"${entry}": the length must be a positive number of beats.`
    if (velocity !== undefined && !(/^\d+$/.test(velocity) && Number(velocity) >= 1 && Number(velocity) <= 127)) return `"${entry}": velocity must be a whole number from 1 to 127.`
  }
  return null
}

/** Maps an instrument as a model may write it to the instrument list's value, or null. */
export function resolveInstrument(value: string, catalog: IsmailPresets): string | null {
  const name = value.trim().replace(/^(preset|voice):/, '')
  const kind = value.trim().startsWith('voice:') ? 'voice' : value.trim().startsWith('preset:') ? 'preset' : null
  const lower = name.toLowerCase().replace(/[\s-]+/g, '_')
  if (kind !== 'voice') {
    const preset = catalog.presets.find((p) => p.name.toLowerCase() === lower)
    if (preset) return `preset:${preset.name}`
  }
  if (kind !== 'preset') {
    const voice = catalog.voices.find((v) => v.name.toLowerCase() === lower)
    if (voice) return `voice:${voice.name}`
  }
  return null
}

/** Validates a draft from the model. Returns the draft or the problem to send back. */
export function validateDraft(raw: unknown, catalog: IsmailPresets): SoundDraft | string {
  if (!raw || typeof raw !== 'object') return 'Answer with a JSON object.'
  const input = raw as Record<string, unknown>
  const instrument = typeof input.instrument === 'string' ? resolveInstrument(input.instrument, catalog) : null
  if (!instrument) return `"${String(input.instrument)}" is not an instrument. Use one of the preset or voice names listed.`
  const notes = typeof input.notes === 'string' ? input.notes.trim() : ''
  const problem = checkNotes(notes)
  if (problem) return problem
  const tail = typeof input.tailSeconds === 'number' && Number.isFinite(input.tailSeconds) ? Math.max(0, Math.min(10, input.tailSeconds)) : 1
  const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim().slice(0, 40) : instrument.split(':')[1].replace(/_/g, ' ')
  return { instrument, notes, name, tailSeconds: tail, summary: typeof input.summary === 'string' ? input.summary.trim() : '' }
}

/** Finds the JSON object in a reply that may wrap it in prose or a code fence. */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const body = fenced ? fenced[1] : text
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(body.slice(start, end + 1))
  } catch {
    return null
  }
}

/** Why the agent can't run yet, in words the user can act on, or null when it can. */
export function agentProblem(settings: AgentSettings | null): string | null {
  if (!settings) return 'The agent runs in the desktop app.'
  if (settings.provider === 'claude-cli' && !settings.cliAvailable) return 'The claude command was not found. Install Claude Code, or choose another provider under Agent.'
  if (settings.provider === 'anthropic' && !settings.hasKey) return 'Add your Claude API key under Agent.'
  if (settings.provider === 'openai-compatible' && !settings.model) return 'Choose a model for your local server under Agent.'
  return null
}

function prompt(description: string, catalog: IsmailPresets, context: SoundContext): string {
  const presets = catalog.presets.map((p) => `${p.name} (${p.type})`).join(', ')
  const voices = catalog.voices.map((v) => `voice:${v.name} — ${v.summary}`).join('\n')
  return [
    'You write sounds for Ismail, the synthesizer inside the RE:BORN music workstation. Pick one instrument and write the notes that realize the description.',
    `Presets: ${presets}`,
    voices && `Voices:\n${voices}`,
    'Notes: one per line or separated by ";", each "start pitch length velocity". Start and length are in beats (4 beats per bar), pitch is a note name such as C2 or F#3, velocity is 1 to 127. "0 C3,E3,G3 2 100" is a chord.',
    `The project runs at ${context.tempo} BPM. ${context.destination === 'sampler' ? 'The sound loads into a Sampler that chops it into pads, so write a single hit or a short phrase whose notes are easy to slice.' : 'The sound becomes an audio clip that loops, so write a phrase that loops cleanly in 1, 2, or 4 bars, or a single hit.'}`,
    'Drum presets (kick, snare, clap, hat, kit types) ignore pitch; use C1 and write the rhythm. Keep basslines in octaves 1 to 2, leads and pads in 3 to 5.',
    context.current && `The fields currently hold instrument ${context.current.instrument} and notes "${context.current.notes}". If the description asks for a change to this sound, start from it.`,
    `Description: ${description}`,
  ].filter(Boolean).join('\n\n')
}

const SCHEMA = {
  type: 'object',
  properties: {
    instrument: { type: 'string', description: 'A preset name such as acid_bass, or voice:<name>.' },
    notes: { type: 'string', description: 'Notes in the format above.' },
    name: { type: 'string', description: 'A short name for the sound, 2 to 4 words.' },
    tailSeconds: { type: 'number', description: 'Seconds the last note may ring out, 0 to 10.' },
    summary: { type: 'string', description: 'One sentence: what you wrote and why.' },
  },
  required: ['instrument', 'notes', 'name', 'summary'],
  additionalProperties: false,
}

const JSON_SHAPE = '{"instrument": "...", "notes": "...", "name": "...", "tailSeconds": 1, "summary": "..."}'

/** Asks the configured agent for an instrument and notes. Throws with a readable message on failure. */
export async function draftSound(description: string, catalog: IsmailPresets, context: SoundContext, settings: AgentSettings): Promise<SoundDraft> {
  if (!desktop) throw new Error('The agent runs in the desktop app.')
  const problem = agentProblem(settings)
  if (problem) throw new Error(problem)
  const ask = prompt(description, catalog, context)
  let lastProblem = ''
  if (settings.provider === 'claude-cli') {
    // The CLI answers in text; ask for the JSON object alone and retry once with the problem.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const retry = lastProblem ? `\n\nYour last answer had a problem: ${lastProblem} Fix it.` : ''
      const reply = await desktop.agentRunCli(`${ask}${retry}\n\nDo not call any tools. Reply with only this JSON object and nothing else: ${JSON_SHAPE}`)
      const draft = validateDraft(extractJson(reply.text), catalog)
      if (typeof draft !== 'string') return draft
      lastProblem = draft
    }
    throw new Error(`The agent's notes didn't work: ${lastProblem}`)
  }
  const messages: AgentMessage[] = [{ role: 'user', content: [{ type: 'text', text: `${ask}\n\nCall write_sound once with your answer.` }] }]
  const tools = [{ name: 'write_sound', description: 'Hand the instrument and notes to Ismail.', input_schema: SCHEMA }]
  for (let round = 0; round < 3; round += 1) {
    const response = await desktop.agentComplete({ system: 'You are a sound designer. Answer by calling write_sound.', messages, tools, maxTokens: 1500 })
    messages.push({ role: 'assistant', content: response.content })
    const calls = response.content.filter((c): c is Extract<AgentContent, { type: 'tool_use' }> => c.type === 'tool_use')
    const call = calls[0]
    // Some local models answer with JSON in text instead of a tool call.
    const raw = call ? call.input : extractJson(response.content.filter((c): c is Extract<AgentContent, { type: 'text' }> => c.type === 'text').map((c) => c.text).join('\n'))
    const draft = validateDraft(raw, catalog)
    if (typeof draft !== 'string') return draft
    lastProblem = draft
    messages.push(call
      ? { role: 'user', content: calls.map((c, i): AgentContent => ({ type: 'tool_result', tool_use_id: c.id, content: i === 0 ? draft : 'Ignored: call write_sound once.', is_error: true })) }
      : { role: 'user', content: [{ type: 'text', text: `${draft} Call write_sound with the corrected answer.` }] })
  }
  throw new Error(`The agent's notes didn't work: ${lastProblem}`)
}
