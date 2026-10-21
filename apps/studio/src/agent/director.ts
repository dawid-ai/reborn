import { type AgentResultPart, type FootageCandidate, studio } from '@reborn/studio-core'
import { LOOKS, Timeline, featureAt } from '@reborn/video'
import { dispatch, getState } from '../state/store'
import { exportVideo } from '../video/export'
import { addLibraryFootage, applyPreset, createFromTemplate, libraryItem, saveFootage, savePreset, saveTemplate, searchLibrary } from '../video/library'
import { renderLookDev } from '../video/lookdev'
import { getAnalysis, isAnalysisCurrent } from '../video/session'
import { addCandidates, downloadClip, searchFootage } from '../video/stock'
import { videoFileUrl } from '../video/media'

// The Director's tools. The in-app agent calls them directly; the Claude CLI
// reaches them through `reborn mcp --role director` and the local API. Every
// edit goes through the video commands with the Director's role check, so it
// can never change the music or approve its own stages.

export interface ToolOutcome {
  content: string | AgentResultPart[]
  isError?: boolean
}

const json = (value: unknown) => JSON.stringify(value).slice(0, 40000)
const history = { origin: 'agent' as const }

function board(): studio.Storyboard {
  return studio.requireStoryboard(getState().project)
}

/** Runs director commands as one undo step, after the role check. */
function edit(commands: studio.Command[], label: string): unknown[] {
  const checked = studio.checkRoleCommands('director', commands)
  const results = dispatch(checked, { origin: 'agent', label: `Director: ${label}`, quiet: false })
  return results ?? []
}

async function pngData(fileId: string): Promise<string | null> {
  const url = await videoFileUrl(fileId)
  if (!url) return null
  const blob = await (await fetch(url)).blob()
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

/** A grid of footage thumbnails with result numbers, so the model can judge them. */
async function thumbnailGrid(candidates: FootageCandidate[]): Promise<string | null> {
  const shown = candidates.slice(0, 16)
  if (!shown.length) return null
  const columns = 4
  const cell = { width: 240, height: 135 }
  const canvas = new OffscreenCanvas(columns * cell.width, Math.ceil(shown.length / columns) * (cell.height + 22))
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#0c0e0d'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  for (const [i, c] of shown.entries()) {
    const x = (i % columns) * cell.width
    const y = Math.floor(i / columns) * (cell.height + 22)
    if (c.thumbnail) {
      try {
        const bitmap = await createImageBitmap(await (await fetch(c.thumbnail)).blob())
        ctx.drawImage(bitmap, x + 2, y + 2, cell.width - 4, cell.height - 4)
        bitmap.close()
      } catch {
        // A broken thumbnail leaves its cell empty.
      }
    }
    ctx.fillStyle = '#c7ff39'
    ctx.font = '600 15px sans-serif'
    ctx.fillText(String(i + 1), x + 6, y + cell.height + 16)
    ctx.fillStyle = '#a0a8a2'
    ctx.font = '13px sans-serif'
    ctx.fillText(c.title.slice(0, 28), x + 30, y + cell.height + 16)
  }
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 })
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

let lastSearch: FootageCandidate[] = []

function cueSummary() {
  const { project } = getState()
  const active = project.video?.storyboards.length ? board() : studio.createStoryboard('cues')
  const analysis = getAnalysis()
  const features = isAnalysisCurrent(project) ? analysis.features : null
  const timeline = new Timeline(project, active, features)
  const bar = timeline.cues.barSeconds
  const count = (channel: studio.CutEvent, from: number, to: number) => [...timeline.events(channel)].filter((t) => t >= from && t < to).length
  const sections = [...project.sections]
    .sort((a, z) => a.start - z.start)
    .map((section) => {
      const from = section.start * bar
      const to = (section.start + section.length) * bar
      const perBar = (channel: studio.CutEvent) => Math.round((count(channel, from, to) / section.length) * 10) / 10
      let bands: Record<string, number> | undefined
      if (features) {
        const sums: Record<string, number> = { sub: 0, bass: 0, mid: 0, harsh: 0, air: 0 }
        for (let t = from; t < to; t += 1 / 10) for (const band of Object.keys(sums)) sums[band] += featureAt(features, band as 'sub', t)
        const total = Object.values(sums).reduce((a, z) => a + z, 0) || 1
        bands = Object.fromEntries(Object.entries(sums).map(([band, v]) => [band, Math.round((v / total) * 100) / 100]))
      }
      return { id: section.id, name: section.name, role: studio.sectionRole(section.name), startBar: section.start + 1, bars: section.length, start: Math.round(from * 100) / 100, end: Math.round(to * 100) / 100, kicksPerBar: perBar('kick'), snaresPerBar: perBar('snare'), hatsPerBar: perBar('hat'), ...(bands && { bandShares: bands }) }
    })
  return {
    tempo: project.tempo,
    barSeconds: Math.round(bar * 1000) / 1000,
    seconds: Math.round(timeline.duration * 100) / 100,
    mixAnalyzed: Boolean(features),
    sections,
    impacts: [...timeline.events('impact')].map((t) => Math.round(t * 100) / 100),
    risers: timeline.cues.risers.map(([a, z]) => [Math.round(a * 100) / 100, Math.round(z * 100) / 100]),
    noteTracks: Object.fromEntries(Object.entries(timeline.cues.notes).map(([name, notes]) => [name, notes.length])),
  }
}

export async function runDirectorTool(name: string, input: Record<string, unknown>): Promise<ToolOutcome> {
  try {
    const { project } = getState()
    switch (name) {
      case 'project_summary':
        return { content: json(studio.execute(project, { type: 'project.summary' }).results[0]) }
      case 'video_brief_get': {
        if (!project.video?.storyboards.length) return { content: 'There is no storyboard yet. Create one with video_storyboard_edit and the command video.storyboard.create.' }
        return { content: json(studio.execute(project, { type: 'video.get', params: input.storyboardId ? { storyboardId: input.storyboardId } : {} }).results[0]) }
      }
      case 'video_reference':
        return {
          content: json({
            ...(studio.execute(project, { type: 'video.reference' }).results[0] as object),
            looks: LOOKS.map((look) => ({ id: look.id, title: look.title, layer: look.layer, fits: look.fits, mood: look.mood, description: look.description, params: look.params.map((p) => ({ name: p.name, default: p.default.length === 1 ? p.default[0] : p.default, description: p.description })) })),
          }),
        }
      case 'video_cues':
        return { content: json(cueSummary()) }
      case 'video_library_search':
        return {
          content: json(
            searchLibrary({ text: input.text as string | undefined, kind: input.kind as studio.LibraryKind | undefined, fits: input.fits as studio.SectionRole | undefined })
              .slice(0, 20)
              .map(({ preview: _preview, ...item }) => item),
          ),
        }
      case 'video_library_apply': {
        const item = libraryItem(String(input.itemId))
        if (!item) return { content: `No library item "${String(input.itemId)}".`, isError: true }
        if (item.kind === 'preset') {
          if (typeof input.sceneId !== 'string') return { content: 'Give the sceneId to apply the preset to.', isError: true }
          return applyPreset(item, input.sceneId, history) ? { content: `Applied ${item.name} (version ${item.version}).` } : { content: 'The preset could not be applied.', isError: true }
        }
        if (item.kind === 'template') return { content: json({ storyboardId: createFromTemplate(item, history) }) }
        const clipId = await addLibraryFootage(item, board().id, history)
        return clipId ? { content: json({ clipId, note: 'Added from the library, already downloaded.' }) } : { content: 'The clip could not be added.', isError: true }
      }
      case 'video_storyboard_edit': {
        const commands = (input.commands as studio.Command[]) ?? []
        if (!commands.length) return { content: 'Give at least one command.', isError: true }
        const results = edit(commands, String(input.intent ?? 'edit'))
        return { content: json({ applied: commands.length, results }) }
      }
      case 'video_stills': {
        const moments = Array.isArray(input.moments) ? (input.moments as { seconds: number; label?: string }[]).map((m) => ({ seconds: Number(m.seconds), label: m.label ?? `${Number(m.seconds).toFixed(1)} s` })) : undefined
        const result = await renderLookDev({ moments, history })
        if (!result) return { content: 'Rendering stills failed.', isError: true }
        const sheet = result.sheetId ? await pngData(result.sheetId) : null
        const text = json({ stills: result.stills, sheetId: result.sheetId, note: 'The contact sheet is attached. Pass sheetId or still fileIds to video_stage_request for the user to review.' })
        return { content: sheet ? [{ type: 'text', text }, { type: 'image', mediaType: 'image/png', data: sheet }] : text }
      }
      case 'video_render': {
        const quality = input.quality === 'final' ? 'final' : 'draft'
        if (quality === 'final' && board().stage !== 'final') return { content: `The storyboard is at the ${board().stage} stage. Render a final only after the user approves the draft.`, isError: true }
        const range = typeof input.from === 'number' && typeof input.to === 'number' ? ([input.from, input.to] as [number, number]) : undefined
        const result = await exportVideo({ scale: quality === 'final' ? 1 : 0.5, range })
        if (!result) return { content: 'The render did not finish.', isError: true }
        return { content: json(result.path ? { ...result, note: 'Saved where the user chose.' } : { note: 'The user cancelled saving.' }) }
      }
      case 'video_footage_search': {
        const found = await searchFootage(board().id, String(input.query ?? ''), { providers: input.providers as studio.FootageProvider[] | undefined })
        lastSearch = found.candidates
        const list = found.candidates.slice(0, 16).map((c, i) => ({ number: i + 1, title: c.title, provider: c.provider, licence: c.licenceName, author: c.author, seconds: Math.round(c.duration), height: c.height }))
        const text = json({ results: list, errors: found.errors, note: 'Look at the thumbnails. Propose only clips that fit and are safe; the user approves before anything downloads.' })
        const grid = await thumbnailGrid(found.candidates)
        return { content: grid ? [{ type: 'text', text }, { type: 'image', mediaType: 'image/jpeg', data: grid }] : text }
      }
      case 'video_footage_propose': {
        const picks = ((input.picks as unknown[]) ?? []).map((p) => lastSearch[Number(p) - 1]).filter(Boolean)
        if (!picks.length) return { content: 'Pick result numbers from the last video_footage_search.', isError: true }
        const ids = addCandidates(board().id, picks, 'director', history)
        if (typeof input.reason === 'string' && input.reason.trim()) edit([{ type: 'video.comment.add', params: { text: `Footage for review: ${input.reason.trim()}` } }], 'note on footage')
        return { content: json({ clipIds: ids, note: 'Waiting for the user to approve or reject them in the Footage panel.' }) }
      }
      case 'video_footage_download':
        return { content: json({ fileId: await downloadClip(String(input.clipId), history) }) }
      case 'video_comment_reply':
        edit([{ type: 'video.comment.reply', params: { commentId: input.commentId, text: input.text, ...(input.status !== undefined && { status: input.status }) } }], 'reply to comment')
        return { content: 'Replied.' }
      case 'video_stage_request': {
        const results = edit([{ type: 'video.stage.request', params: { summary: input.summary, ...(Array.isArray(input.fileIds) && { fileIds: input.fileIds }) } }], 'request approval')
        const outcome = results[0] as { approved: boolean; stage: string }
        return { content: outcome.approved ? `The user lets you approve this stage yourself; you are now at ${outcome.stage}.` : 'Approval requested. Stop now and wait for the user to approve or comment.' }
      }
      case 'video_library_promote': {
        const pending = { reason: String(input.reason ?? ''), proposedBy: 'director' as const }
        const itemName = String(input.name ?? 'Untitled')
        const item =
          input.kind === 'preset' && typeof input.sceneId === 'string'
            ? await savePreset(input.sceneId, { name: itemName, pending })
            : input.kind === 'template'
              ? await saveTemplate(board().id, { name: itemName, pending })
              : input.kind === 'footage' && typeof input.clipId === 'string'
                ? await saveFootage(input.clipId, { pending })
                : null
        return item ? { content: `Suggested "${item.name}" for the library. The user keeps or dismisses it.` } : { content: 'Give sceneId for a preset or clipId for footage.', isError: true }
      }
      default:
        return { content: `Unknown tool ${name}.`, isError: true }
    }
  } catch (error) {
    return { content: error instanceof Error ? error.message : String(error), isError: true }
  }
}
