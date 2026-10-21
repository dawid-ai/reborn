// Plain-language lines for agent tool calls, so the agent panel shows what
// the agent is doing while it works. Names may come from the in-app agent
// (project_summary) or the Claude CLI over MCP (mcp__reborn__project_summary).

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : '')

function batchSize(changes: unknown): string {
  if (!Array.isArray(changes)) return ''
  const commands = changes.reduce((sum: number, change: { commands?: unknown[] }) => sum + (Array.isArray(change?.commands) ? change.commands.length : 0), 0)
  return ` (${changes.length} change${changes.length === 1 ? '' : 's'}, ${commands} edit${commands === 1 ? '' : 's'})`
}

/** One line describing a tool call. */
export function describeStep(name: string, input: Record<string, unknown> = {}): string {
  const base = name.replace(/^mcp__reborn__/, '')
  const track = text(input.trackId)
  switch (base) {
    case 'project_summary':
      return 'Reading the project'
    case 'track_get':
      return track ? `Reading track ${track}` : 'Reading a track'
    case 'clip_list':
      return track ? `Listing clips on ${track}` : 'Listing clips'
    case 'pattern_get':
      return 'Reading a pattern'
    case 'mixer_trace':
      return 'Tracing the signal path'
    case 'analysis_run':
    case 'render_mix':
      return 'Rendering and measuring the mix'
    case 'render_stems':
      return 'Rendering stems'
    case 'command_help':
      return `Looking up ${Array.isArray(input.types) ? input.types.join(', ') : 'commands'}`
    case 'propose_changes':
    case 'edit_batch':
      return `Proposing: ${text(input.intent) || 'changes'}${batchSize(input.changes)}`
    case 'ismail_presets':
      return 'Listing Ismail instruments'
    case 'ismail_generate': {
      const instrument = typeof input.instrument === 'string' ? input.instrument : text((input.instrument as Record<string, unknown> | undefined)?.voice)
      return `Generating ${text(input.name) || 'a sound'} with Ismail${instrument ? ` (${instrument})` : ''}`
    }
    case 'ismail_separate':
      return 'Separating stems with Ismail'
    case 'proposal_status':
      return 'Checking the proposal'
    case 'transport_play':
      return 'Starting playback'
    case 'transport_stop':
      return 'Stopping playback'
    case 'history_undo':
      return 'Undoing the last edit'
    case 'video_brief_get':
      return 'Reading the brief and comments'
    case 'video_reference':
      return 'Reading the look catalog'
    case 'video_cues':
      return 'Reading the song’s sections and drums'
    case 'video_library_search':
      return `Searching the library${text(input.text) ? ` for “${text(input.text)}”` : ''}`
    case 'video_library_apply':
      return 'Applying a library item'
    case 'video_storyboard_edit': {
      const count = Array.isArray(input.commands) ? input.commands.length : 0
      return `Editing the storyboard: ${text(input.intent) || 'changes'}${count ? ` (${count} edit${count === 1 ? '' : 's'})` : ''}`
    }
    case 'video_stills':
      return Array.isArray(input.moments) ? `Rendering ${input.moments.length} stills` : 'Rendering stills and a contact sheet'
    case 'video_render':
      return input.quality === 'final' ? 'Rendering the final video' : 'Rendering a draft video'
    case 'video_footage_search':
      return `Searching footage for “${text(input.query)}”`
    case 'video_footage_propose':
      return 'Offering clips for your review'
    case 'video_footage_download':
      return 'Downloading an approved clip'
    case 'video_comment_reply':
      return 'Answering a comment'
    case 'video_stage_request':
      return 'Asking for your approval'
    case 'video_library_promote':
      return `Suggesting “${text(input.name)}” for the library`
  }
  const words = base.replace(/_/g, ' ')
  const intent = text(input.intent)
  if (intent) return `${words.charAt(0).toUpperCase()}${words.slice(1)}: ${intent}`
  const target = track || text(input.name) || text(input.patternId) || text(input.clipId)
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}${target ? ` (${target})` : ''}`
}
