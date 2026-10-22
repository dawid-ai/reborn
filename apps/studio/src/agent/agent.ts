import { useSyncExternalStore } from 'react'
import { type AgentContent, type AgentMessage, type AgentSettings, type AgentToolSpec, studio } from '@reborn/studio-core'
import { latestAnalysis, runAnalysis, summarizeReport } from '../audio/analysis'
import { runGenerate } from '../audio/ismail'
import { desktop } from '../platform/desktop'
import { addProposal } from '../state/proposals'
import { dispatch, getState } from '../state/store'
import { type ToolOutcome, runDirectorTool } from './director'
import { checkNotes, resolveInstrument } from './sound'
import { describeStep } from './steps'

// The in-app agents. The Composer reads the project with the registry's read
// commands, measures rendered audio before making claims, and changes the
// music only by proposing command batches the user reviews (unless direct
// edits are on). The Director makes the music video: it edits storyboards
// directly, one undo step at a time, and stops at every stage gate for the
// user. Each has its own conversation.

export type AgentRole = studio.AgentRole

export interface ChatLine {
  role: 'user' | 'agent' | 'tool'
  text: string
}

interface AgentState {
  /** The agent the panel shows and new requests go to. */
  role: AgentRole
  conversations: Record<AgentRole, ChatLine[]>
  /** When each agent's running request started, or null while it is idle. Both can work at once. */
  startedAt: Record<AgentRole, number | null>
  settings: AgentSettings | null
}

let state: AgentState = { role: 'composer', conversations: { composer: [], director: [] }, startedAt: { composer: null, director: null }, settings: null }
const stopRequested: Record<AgentRole, boolean> = { composer: false, director: false }

/** Whether an agent is working on a request. */
export const isWorking = (s: AgentState, role: AgentRole) => s.startedAt[role] !== null
const listeners = new Set<() => void>()
const set = (patch: Partial<AgentState>) => {
  state = { ...state, ...patch }
  listeners.forEach((l) => l())
}
const sayTo = (role: AgentRole, line: ChatLine) => set({ conversations: { ...state.conversations, [role]: [...state.conversations[role].slice(-60), line] } })

/** Shows the Composer's or the Director's conversation. */
export function setAgentRole(role: AgentRole): void {
  set({ role })
}

export function useAgent<T>(select: (s: AgentState) => T): T {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => {
        listeners.delete(l)
      }
    },
    () => select(state),
  )
}

export async function loadAgentSettings(): Promise<AgentSettings | null> {
  if (!desktop) return null
  const settings = await desktop.getAgentSettings()
  set({ settings })
  return settings
}

export async function updateAgentSettings(patch: Parameters<NonNullable<typeof desktop>['setAgentSettings']>[0]): Promise<void> {
  if (!desktop) return
  set({ settings: await desktop.setAgentSettings(patch) })
}

const isLocalProvider = (s: AgentSettings) => s.provider === 'openai-compatible' && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(s.baseUrl)

const READ_TOOLS: Record<string, string> = {
  studio_reference: 'studio.reference',
  project_summary: 'project.summary',
  track_get: 'track.get',
  clip_list: 'clip.list',
  pattern_get: 'pattern.get',
  mixer_trace: 'mixer.trace',
}

function tools(): AgentToolSpec[] {
  const registry = new Map(studio.listCommands().map((c) => [c.type, c]))
  const read = Object.entries(READ_TOOLS).map(([name, type]) => ({ name, description: registry.get(type)!.summary, input_schema: registry.get(type)!.schema }))
  return [
    ...read,
    {
      name: 'analysis_run',
      description: 'Render the song (or a bar range) offline and measure loudness, true peak, crest, band energy shares, stereo correlation, and warnings per section. Use before making any claim about how the mix sounds.',
      input_schema: { type: 'object', properties: { from: { type: 'integer', description: 'First bar, 1-based.' }, to: { type: 'integer', description: 'Last bar, 1-based.' } }, additionalProperties: false },
    },
    {
      name: 'ismail_presets',
      description: 'List the Ismail synth presets and voices that ismail_generate can play.',
      input_schema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'ismail_generate',
      description:
        'Synthesize a sound with Ismail and add it to the project right away, as one undo step. It loads into a Sampler track, lands on an Audio track at a bar, or gets a new looping audio track. Notes: one per line or separated by ";", each "start pitch length velocity", start and length in beats (4 per bar), for example "0 C2 0.5 110; 0.5 D#2 0.5 100"; "0 C3,E3,G3 2" is a chord. Drum presets ignore pitch.',
      input_schema: {
        type: 'object',
        properties: {
          instrument: { type: 'string', description: 'A preset name such as acid_bass, or voice:<name>. See ismail_presets.' },
          notes: { type: 'string' },
          name: { type: 'string', description: 'A short name for the sound and its track.' },
          tailSeconds: { type: 'number', description: 'Seconds the last note may ring out, 0 to 10. Default 1.' },
          trackId: { type: 'string', description: 'A Sampler or Audio track to receive the sound. Omit for a new audio track.' },
          bar: { type: 'integer', description: 'Bar (1-based) for the clip on an Audio track. Defaults to the playhead.' },
          bpm: { type: 'number', description: 'Tempo the notes are played at. Defaults to the project tempo; set it to the tempo your proposal will set.' },
          place: { type: 'boolean', description: 'False adds the sound to the project audio without placing it; place it in propose_changes with clip.create (assetId) and clip.loop. Default true.' },
        },
        required: ['instrument', 'notes', 'name'],
        additionalProperties: false,
      },
    },
    {
      name: 'command_help',
      description: 'Get the parameter schema for one or more mutating commands before proposing them.',
      input_schema: { type: 'object', properties: { types: { type: 'array', items: { type: 'string' } } }, required: ['types'], additionalProperties: false },
    },
    {
      name: 'propose_changes',
      description: 'Propose edits for the user to review. Each change is a short summary, a detail line with the evidence, and the exact commands. Commands are validated before the proposal is shown; invalid ones come back as an error to fix. A command can name its result with ref so later commands use it: {"type": "clip.create", "params": {"trackId": "Acid 1", "start": 8, "length": 4, "name": "Drop line"}, "ref": "drop"} then {"type": "pattern.write", "params": {"patternId": "$drop.patternId", "steps": "..."}}.',
      input_schema: {
        type: 'object',
        properties: {
          intent: { type: 'string', description: 'One sentence: what the changes achieve.' },
          evidence: { type: 'array', items: { type: 'string' }, description: 'Measurements or user instructions that justify the changes.' },
          changes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                summary: { type: 'string' },
                detail: { type: 'string', description: 'Before → after values and why.' },
                commands: {
                  type: 'array',
                  items: { type: 'object', properties: { type: { type: 'string' }, params: { type: 'object' }, ref: { type: 'string', description: 'Name this command\'s result; later commands use "$name.key", for example "$verse.patternId".' } }, required: ['type'] },
                },
              },
              required: ['summary', 'commands'],
            },
          },
        },
        required: ['intent', 'changes'],
        additionalProperties: false,
      },
    },
  ]
}

function systemPrompt(): string {
  const { project } = getState()
  const mutating = studio
    .listCommands()
    .filter((c) => c.mutates && studio.roleAllows('composer', c.type))
    .map((c) => `- ${c.type}: ${c.summary}`)
    .join('\n')
  return [
    'You are the production assistant inside RE:BORN, a groovebox-style music workstation. You help the user finish beats: diagnose mixes, write patterns, arrange sections, and set up sounds.',
    'Rules:',
    '1. Read before you change anything (project_summary, track_get, pattern_get, clip_list, mixer_trace). Use studio_reference for knob names, drum voices, and notation.',
    '2. Never claim how something sounds without measuring it first with analysis_run. Quote the numbers you rely on.',
    '3. Change the project only through propose_changes. Keep each change small, labeled, and reversible; the user can accept some and reject others.',
    '4. Respect artistic choices. Diagnose and explain; do not "fix" style unless asked.',
    '5. Bars in your answers are 1-based. Command parameters for start and at are 0-based bars.',
    '6. To make a new sound (a bassline, a hit, a chord), use ismail_generate. It adds audio without changing anything else, so it applies right away; say what you made.',
    '7. For a whole song or several sections, plan the sections and parts first, then send everything in one propose_changes call: tempo, tracks, clips with their own patterns (use ref to write into the clip you just created), sections, and mixer settings, grouped into changes the user can accept one by one. Make any Ismail sounds first with place false and bpm set to the song tempo, then place them in the same proposal with clip.create (assetId) and clip.loop.',
    '8. Before each step, write one short sentence about what you are doing, so the user can follow along.',
    `Project "${project.name}": ${project.tempo} BPM, ${project.length} bars, ${project.tracks.length} tracks (${project.tracks.map((t) => `${t.name} [${t.kind}]`).join(', ')}).`,
    'Mutating commands you can propose:',
    mutating,
  ].join('\n')
}

async function runTool(name: string, input: Record<string, unknown>, settings: AgentSettings): Promise<{ content: string; isError?: boolean }> {
  try {
    if (name in READ_TOOLS) {
      const result = studio.executeBatch(getState().project, [{ type: READ_TOOLS[name], params: input }]).results[0]
      return { content: JSON.stringify(result).slice(0, 20000) }
    }
    if (name === 'analysis_run') {
      const cloud = !isLocalProvider(settings)
      if (cloud && !settings.shareMeasurements) return { content: 'The user has not allowed sharing measurements with this provider. Ask them to turn on “Share measurements” in the agent settings, or reason from the project structure and mixer_trace only.', isError: true }
      const from = typeof input.from === 'number' ? input.from - 1 : undefined
      const to = typeof input.to === 'number' ? input.to : undefined
      const report = await runAnalysis({ from, to })
      return { content: JSON.stringify(summarizeReport(report)) }
    }
    if (name === 'ismail_presets') {
      if (!desktop) return { content: 'Ismail runs in the desktop app.', isError: true }
      return { content: JSON.stringify(await desktop.ismailPresets()) }
    }
    if (name === 'ismail_generate') {
      if (!desktop) return { content: 'Ismail runs in the desktop app.', isError: true }
      const catalog = await desktop.ismailPresets()
      const instrument = resolveInstrument(String(input.instrument ?? ''), catalog)
      if (!instrument) return { content: `"${String(input.instrument)}" is not an Ismail instrument. Call ismail_presets for the names.`, isError: true }
      const notes = String(input.notes ?? '')
      const problem = checkNotes(notes)
      if (problem) return { content: problem, isError: true }
      const [kind, value] = instrument.split(':')
      const soundName = String(input.name ?? value).slice(0, 40)
      const sound = await runGenerate(
        { name: soundName, instrument: kind === 'voice' ? { type: 'code', voice: value } : value, notes, tailSeconds: typeof input.tailSeconds === 'number' ? input.tailSeconds : 1, ...(typeof input.bpm === 'number' && { bpm: input.bpm }) },
        { trackId: typeof input.trackId === 'string' ? input.trackId : undefined, bar: typeof input.bar === 'number' ? input.bar - 1 : undefined, place: input.place !== false },
        { origin: 'agent' },
      )
      return { content: JSON.stringify({ assetId: sound.assetId, trackId: sound.trackId, bars: sound.bars, loopBars: sound.loopBars, summary: sound.summary }) }
    }
    if (name === 'command_help') {
      const types = (input.types as string[]) ?? []
      return { content: JSON.stringify(studio.listCommands().filter((c) => types.includes(c.type) && studio.roleAllows('composer', c.type))) }
    }
    if (name === 'propose_changes') {
      const changes = (input.changes as { summary: string; detail?: string; commands: studio.Command[] }[]) ?? []
      const commands = changes.flatMap((c) => c.commands)
      if (!commands.length) return { content: 'No commands were given.', isError: true }
      studio.checkRoleCommands('composer', commands)
      studio.executeBatch(getState().project, commands, { origin: 'agent' })
      if (settings.directEdits) {
        dispatch(commands, { origin: 'agent', label: `Agent: ${String(input.intent ?? 'edit')}` })
        return { content: `Applied ${changes.length} changes directly (the user enabled direct edits). They can undo them in one step.` }
      }
      const proposal = addProposal({
        id: studio.newId('prp'),
        source: 'agent',
        request: state.conversations.composer.filter((l) => l.role === 'user').at(-1)?.text ?? '',
        intent: String(input.intent ?? 'Proposed changes'),
        evidence: ((input.evidence as string[]) ?? []).map(String),
        changes: changes.map((c, i) => ({ id: `c${i + 1}`, summary: c.summary, detail: c.detail ?? '', commands: c.commands })),
      })
      return { content: `Proposal ${proposal.id} is waiting for the user's review with ${changes.length} changes. Tell the user what you proposed and why; do not repeat the commands.` }
    }
    return { content: `Unknown tool ${name}.`, isError: true }
  } catch (error) {
    return { content: error instanceof Error ? error.message : String(error), isError: true }
  }
}

/** Stops the shown agent's request: the Claude CLI at once, the in-app agent after its current step. */
export function stopAgent(): void {
  const role = state.role
  if (!isWorking(state, role) || stopRequested[role]) return
  stopRequested[role] = true
  sayTo(role, { role: 'tool', text: 'Stopping…' })
  desktop?.agentCancel(role)
}

/** Starts a new conversation with the shown agent. It forgets earlier turns; the project is unchanged. */
export function clearConversation(): void {
  if (isWorking(state, state.role)) return
  set({ conversations: { ...state.conversations, [state.role]: [] } })
}

/** The Director's view of where the video stands, added to its instructions each turn. */
function directorContext(): string {
  const { project } = getState()
  const video = project.video
  const board = video?.storyboards.find((b) => b.id === video.activeId) ?? video?.storyboards[0]
  if (!board) return `Song "${project.name}": ${project.tempo} BPM, ${project.length} bars, sections: ${project.sections.map((s) => s.name).join(', ') || 'none'}. There is no storyboard yet.`
  const open = studio.openComments(board).length
  return `Song "${project.name}": ${project.tempo} BPM, ${project.length} bars. Active storyboard "${board.name}" (${board.width}x${board.height}, ${board.fps} fps) is at the ${board.stage} stage${board.request ? ', waiting for the user to approve it' : ''}, with ${board.scenes.length} scenes and ${open} open comment${open === 1 ? '' : 's'}.`
}

const DIRECTOR_TOOLS: AgentToolSpec[] = studio.DIRECTOR_TOOLS.map((t) => ({ ...t }))

export async function ask(prompt: string): Promise<void> {
  const text = prompt.trim()
  const role = state.role
  if (!text || isWorking(state, role)) return
  const say = (line: ChatLine) => sayTo(role, line)
  say({ role: 'user', text })
  if (!desktop) {
    say({ role: 'agent', text: 'The agents run in the desktop edition, which keeps API keys in your OS credential store. In the browser you can still use the analyzer and signal trace in Mix view, and build the video yourself in Video view.' })
    return
  }
  const settings = state.settings ?? (await loadAgentSettings())
  if (!settings) return
  stopRequested[role] = false
  set({ startedAt: { ...state.startedAt, [role]: Date.now() } })
  try {
    if (settings.provider === 'claude-cli') {
      if (!settings.cliAvailable) throw new Error('The claude command was not found. Install Claude Code, or pick another provider.')
      const summary = JSON.stringify(studio.executeBatch(getState().project, [{ type: 'project.summary' }]).results[0])
      // The CLI streams each tool call and note while it works.
      let lastNote = ''
      const off = desktop.onAgentActivity((activity) => {
        if ((activity.role ?? 'composer') !== role) return
        if (activity.kind === 'tool') say({ role: 'tool', text: describeStep(activity.name, activity.input) })
        else say({ role: 'agent', text: (lastNote = activity.text) })
      })
      try {
        const instructions =
          role === 'director'
            ? `${studio.DIRECTOR_PROMPT}\n\n${directorContext()}\n\nUser request: ${text}\n\nUse the reborn MCP tools (video_brief_get first). Storyboard edits apply directly, one undo step each.`
            : `${systemPrompt()}\n\nCurrent project: ${summary}\n\nUser request: ${text}\n\nUse the reborn MCP tools. Edits become proposals the user reviews unless direct edits are on. For a song or anything with several steps, send everything, including the tempo, in one edit_batch proposal, using ref to build on earlier steps; make Ismail sounds before it with place false and bpm set to the song tempo.`
        const result = await desktop.agentRunCli(instructions, role)
        if (result.text.trim() && result.text.trim() !== lastNote) say({ role: 'agent', text: result.text.trim() })
        else if (!lastNote) say({ role: 'agent', text: 'Done.' })
      } finally {
        off()
      }
      return
    }
    const messages: AgentMessage[] = [...historyAsMessages(role), { role: 'user', content: [{ type: 'text', text }] }]
    const rounds = role === 'director' ? 40 : 20
    for (let round = 0; round < rounds && !stopRequested[role]; round += 1) {
      const response =
        role === 'director'
          ? await desktop.agentComplete({ system: `${studio.DIRECTOR_PROMPT}\n\n${directorContext()}`, messages, tools: DIRECTOR_TOOLS, maxTokens: 8192 })
          : await desktop.agentComplete({ system: systemPrompt(), messages, tools: tools(), maxTokens: 8192 })
      messages.push({ role: 'assistant', content: response.content })
      const texts = response.content.filter((c): c is Extract<AgentContent, { type: 'text' }> => c.type === 'text').map((c) => c.text.trim()).filter(Boolean)
      if (texts.length) say({ role: 'agent', text: texts.join('\n\n') })
      const calls = response.content.filter((c): c is Extract<AgentContent, { type: 'tool_use' }> => c.type === 'tool_use')
      if (!calls.length || stopRequested[role]) break
      const results: AgentContent[] = []
      for (const call of calls) {
        say({ role: 'tool', text: describeStep(call.name, call.input) })
        const outcome: ToolOutcome = stopRequested[role] ? { content: 'The user stopped the agent.', isError: true } : role === 'director' ? await runDirectorTool(call.name, call.input) : await runTool(call.name, call.input, settings)
        if (outcome.isError && !stopRequested[role]) say({ role: 'tool', text: `That failed: ${String(outcome.content).slice(0, 200)}` })
        results.push({ type: 'tool_result', tool_use_id: call.id, content: outcome.content, is_error: outcome.isError })
      }
      messages.push({ role: 'user', content: results })
    }
    if (stopRequested[role]) say({ role: 'agent', text: 'Stopped.' })
  } catch (error) {
    const message = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error)
    say({ role: 'agent', text: stopRequested[role] || message === 'Stopped.' ? 'Stopped.' : `Something went wrong: ${message}` })
  } finally {
    stopRequested[role] = false
    set({ startedAt: { ...state.startedAt, [role]: null } })
  }
}

function historyAsMessages(role: AgentRole): AgentMessage[] {
  // Keep a short text-only memory of the conversation.
  // Providers need alternating turns that start with the user and end with
  // the assistant, because the new request is appended as a user turn.
  const turns = state.conversations[role]
    .slice(-9, -1)
    .filter((l) => l.role !== 'tool')
    .map((l) => ({ role: l.role === 'user' ? ('user' as const) : ('assistant' as const), content: [{ type: 'text' as const, text: l.text }] }))
    .filter((m, i, all) => i === 0 || m.role !== all[i - 1].role)
  while (turns.length && turns[0].role !== 'user') turns.shift()
  while (turns.length && turns[turns.length - 1].role !== 'assistant') turns.pop()
  return turns
}

export const analysisAvailable = () => Boolean(latestAnalysis())
