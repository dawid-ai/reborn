import { COMMANDS, type Command } from './commands'
import { StudioError } from './ops'

// Two agents, each with its own domain. The Composer edits the music. The
// Director edits only storyboards and video files, reads the music, and
// never makes the user's decisions (approving stages, approving footage).
// The app enforces this on every request, whichever client sends it.

export const AGENT_ROLES = ['composer', 'director'] as const
export type AgentRole = (typeof AGENT_ROLES)[number]

/** Music reads the Director may use. */
export const DIRECTOR_MUSIC_READS: readonly string[] = ['project.summary', 'studio.reference', 'track.get', 'clip.list', 'pattern.get']

/** Whether an agent in a role may run a command. */
export function roleAllows(role: AgentRole, type: string): boolean {
  const spec = COMMANDS.get(type)
  if (!spec || spec.userOnly) return false
  if (role === 'composer') return spec.domain !== 'video'
  return spec.domain === 'video' || (!spec.mutates && DIRECTOR_MUSIC_READS.includes(type))
}

/** Commands whose author parameter records who wrote a comment or found footage. */
const AUTHORED = new Set(['video.comment.add', 'video.comment.reply', 'video.footage.add'])

/**
 * Checks a batch against a role and returns it ready to run: the Director's
 * comments and footage candidates are always marked as its own.
 */
export function checkRoleCommands(role: AgentRole, commands: Command[]): Command[] {
  const refused = commands.filter((c) => !roleAllows(role, c.type))
  if (refused.length) {
    const types = [...new Set(refused.map((c) => c.type))].join(', ')
    const why =
      role === 'director'
        ? 'The Director edits only storyboards and video files, and stage and footage approvals are the user’s. Ask the user, or suggest a music change for the Composer.'
        : 'The Composer edits only the music. Video storyboards belong to the Director.'
    throw new StudioError('invalid', `${types}: ${why}`)
  }
  if (role !== 'director') return commands
  return commands.map((c) => (AUTHORED.has(c.type) ? { ...c, params: { ...(c.params ?? {}), author: 'director' } } : c))
}

export interface DirectorToolSpec {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false })
const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: 'string', description, ...extra })

/** The Director's tools, shared by the in-app agent and `reborn mcp --role director`. */
export const DIRECTOR_TOOLS: readonly DirectorToolSpec[] = [
  { name: 'video_brief_get', description: 'Read the active storyboard: brief (goal, mood, words, footage policy and budget), stage, pending stage request, scenes with their times, text, comments (answer every open one), footage, and stills.', input_schema: obj({ storyboardId: str('Storyboard ID; defaults to the active one.') }) },
  { name: 'video_reference', description: 'The look catalog (each look with its fits, mood, description, and parameters with defaults) plus expression variables and functions, post settings, cut events, text styles, fonts, and the time format.', input_schema: obj({}) },
  { name: 'video_cues', description: 'What the song gives the video: tempo, sections with their role and drum density (kicks, snares, hats per bar), band energy shares per section when the mix is analyzed, impacts, risers, and which tracks carry notes.', input_schema: obj({}) },
  { name: 'video_library_search', description: 'Search the Visual Library before making anything new: scene presets, storyboard templates, and footage, by words, kind, and section role.', input_schema: obj({ text: str('Words to match in names, descriptions, tags.'), kind: str('Item kind.', { enum: ['preset', 'template', 'footage'] }), fits: str('Section role.', { enum: ['intro', 'build', 'drop', 'switch', 'bridge', 'outro', 'other'] }) }) },
  { name: 'video_library_apply', description: 'Apply a library preset to a scene (copies its look settings and pins the version), start a new storyboard from a template, or add library footage to the storyboard.', input_schema: obj({ itemId: str('Library item ID.'), sceneId: str('Scene to apply a preset to.') }, ['itemId']) },
  {
    name: 'video_storyboard_edit',
    description: 'Change the storyboard with video commands, applied together as one undo step. Use command types from video_reference and video.* names, for example {"type": "video.scene.update", "params": {"sceneId": "...", "look": "vein-tunnel", "post": {"bloom": 0.6}}}. A command can name its result with ref for later commands ("$name.sceneId").',
    input_schema: obj(
      {
        intent: str('One sentence: what this edit achieves.'),
        commands: { type: 'array', minItems: 1, items: { type: 'object', properties: { type: { type: 'string' }, params: { type: 'object' }, ref: { type: 'string' } }, required: ['type'] } },
      },
      ['intent', 'commands'],
    ),
  },
  { name: 'video_stills', description: 'Render stills and an overview sheet of them all, and look at them. Without moments, renders one per scene, impact, and text item. Do this before any long render, and fix framing and brightness problems you see.', input_schema: obj({ moments: { type: 'array', items: { type: 'object', properties: { seconds: { type: 'number' }, label: { type: 'string' } }, required: ['seconds'] }, description: 'Specific moments in seconds.' } }) },
  { name: 'video_render', description: 'Render the video to MP4: a half-size draft or the full-size final. The user chooses where to save it. Only render a final after the Final stage is reached.', input_schema: obj({ quality: str('Draft or final.', { enum: ['draft', 'final'] }), from: { type: 'number', description: 'Start in seconds; omit for the whole song.' }, to: { type: 'number', description: 'End in seconds.' } }, ['quality']) },
  { name: 'video_footage_search', description: 'Search stock footage the brief allows and look at a thumbnail grid of the results. Keyword search is literal: drop anything off-topic, distressing, violent, police or news footage, logos, or identifiable private people.', input_schema: obj({ query: str('What to show, in a few words.'), providers: { type: 'array', items: { type: 'string', enum: ['pexels', 'pixabay', 'wikimedia', 'archive'] } } }, ['query']) },
  { name: 'video_footage_propose', description: 'Offer clips from the last search to the user. They appear as candidates the user approves or rejects; nothing downloads until they approve.', input_schema: obj({ picks: { type: 'array', items: { type: 'string' }, description: 'Result numbers from the last search, for example ["1", "4"].' }, reason: str('Why these clips fit.') }, ['picks']) },
  { name: 'video_footage_download', description: 'Download a clip the user approved, within the brief’s download limits.', input_schema: obj({ clipId: str('Footage clip ID.') }, ['clipId']) },
  { name: 'video_comment_reply', description: 'Answer a comment: say what you changed, or ask a question. Mark it addressed when it is done.', input_schema: obj({ commentId: str('Comment ID.'), text: str('Your reply.'), status: str('New status.', { enum: ['open', 'addressed', 'wontfix'] }) }, ['commentId', 'text']) },
  { name: 'video_stage_request', description: 'Ask the user to approve the current stage, with a short summary and the stills to look at. Answer open comments first. Then stop and wait for the user.', input_schema: obj({ summary: str('What you did in this stage and what to check.'), fileIds: { type: 'array', items: { type: 'string' }, description: 'Stills or overview sheets to review.' } }, ['summary']) },
  { name: 'video_library_promote', description: 'Suggest keeping something that worked in the Visual Library: a scene as a preset, the storyboard as a template, or a downloaded clip. The user keeps or dismisses the suggestion.', input_schema: obj({ kind: str('What to keep.', { enum: ['preset', 'template', 'footage'] }), sceneId: str('Scene, for a preset.'), clipId: str('Footage clip, for footage.'), name: str('Name for the item.'), reason: str('Why it is worth keeping.') }, ['kind', 'name', 'reason']) },
  { name: 'project_summary', description: 'Read the song: tempo, length, tracks, sections, and scenes. The Director reads music but never changes it.', input_schema: obj({}) },
]

export const DIRECTOR_PROMPT = [
  'You are the Director inside RE:BORN, a music workstation. You make a music video for the open song: you plan it, set up its storyboard, check it with stills, and render it. You change only the video. You never change the music; if the music seems to need a change, say so and suggest the user asks the Composer.',
  'Work in stages, and never skip a gate:',
  '1. Brief: the user describes the goal. Ask about anything essential that is missing (what the video is for, vertical or not, words to show, whether stock footage is allowed), then wait for them to start.',
  '2. Treatment: set up one scene per section with a look, colours, motion, text, and footage ideas, each with a one-line reason tied to the music (for example "Drop 2 is mostly bass, so a heavy pulse"). Search the library first and apply presets that fit. Then request approval.',
  '3. Look-dev: render stills (video_stills), look at them, and fix what is off-centre, washed out, or too bright before asking for approval. For footage scenes, search footage, propose the clips that fit, and wait for the user to approve them.',
  '4. Draft: render a draft for the user to watch, then request approval.',
  '5. Final: render the final. Then suggest keeping in the library the presets, template, or clips that worked.',
  'Rules:',
  '- Read the brief and comments first (video_brief_get). Answer every open comment, with what you changed or a question, before you request approval. The user can leave requests at any time; take them on your next turn.',
  '- Stay inside the brief: its licence policy, footage sources, and download limits.',
  '- Library first: search presets and templates before building scenes by hand.',
  '- The recipe that works: builds zoom or accelerate with a strobe that follows the riser (rstrobe) and white out in the last beat before the impact; drops hard-cut on the impact and stay mostly black with bright accents (full-frame bright colour reads weak); switch sections cut on kick and snare with strobe-deck; bridges use kaleidoscopes with trails and colour cycling; the outro fades with the music. A sample swap or new part inside a section deserves its own scene. Cut on real hits (cutOn kick, snare) rather than a fixed grid.',
  '- Text for instrumentals: a typewriter intro, a countdown on the bars of a riser, a title slam on the drop, words on snares, a ticker from the project data. Check that text is readable in stills.',
  '- Footage: show the user candidates and wait for their approval; never use footage of people in distress, violence, police or news, logos, or identifiable private people unless the brief asks for it. Credits are written automatically.',
  '- Before each step, write one short sentence about what you are doing, so the user can follow along. When you request approval, stop and wait.',
  '- Where the user approves: in the Video view, your request shows under the stage steps above the preview, with the stills you attach and an Approve button named after the stage (for example Approve Treatment). Comments go in the inspector or on a still. You cannot approve for them. Keep a request summary to a few short lines: what changed and what to check.',
  '- The stage you request approval for is the current stage of the storyboard (video_brief_get shows it). If the user reopened an earlier stage, say which stage they need to approve to move on.',
].join('\n')
