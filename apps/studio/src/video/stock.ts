import { ALL_FORMATS, BlobSource, Input } from 'mediabunny'
import { type FootageCandidate, type FootageSearchResult, studio } from '@reborn/studio-core'
import { desktop } from '../platform/desktop'
import { type DispatchOptions, dispatch, getState, toast, upsertJob } from '../state/store'
import { storeFootage } from './media'

// Stock footage in the studio. Searches and downloads run in the desktop
// app's main process, which only talks to the footage providers; the page
// sees thumbnails and finished downloads. A clip downloads only after the
// user approves it, and only within the brief's limits.

export const footageAvailable = () => Boolean(desktop)

export async function searchFootage(storyboardId: string, query: string, options: { providers?: studio.FootageProvider[]; perProvider?: number } = {}): Promise<FootageSearchResult> {
  if (!desktop) throw new Error('Footage search runs in the desktop app.')
  const board = studio.requireStoryboard(getState().project, storyboardId)
  const policy = board.brief.footage
  if (!policy.enabled) throw new Error('Footage is off for this storyboard. Turn it on in the brief.')
  const providers = (options.providers ?? policy.providers).filter((p) => policy.providers.includes(p))
  if (!providers.length) throw new Error('The brief allows no footage sources.')
  return desktop.footageSearch({ query, providers, licences: policy.licences, perProvider: options.perProvider })
}

/** Adds search results as candidates for review. Returns the new clip IDs. */
export function addCandidates(storyboardId: string, candidates: FootageCandidate[], author: studio.CommentAuthor, history: DispatchOptions = {}): string[] {
  const results = dispatch({ type: 'video.footage.add', params: { storyboardId, clips: candidates, author } }, { label: `Add ${candidates.length} footage candidate${candidates.length === 1 ? '' : 's'}`, ...history })
  return (results?.[0] as { clipIds?: string[] } | undefined)?.clipIds ?? []
}

/** Downloads an approved clip within the brief's limits and stores it in the project. */
export async function downloadClip(clipId: string, history: DispatchOptions = {}): Promise<string | null> {
  if (!desktop) throw new Error('Footage downloads run in the desktop app.')
  const project = getState().project
  const board = project.video?.storyboards.find((b) => b.footage.some((c) => c.id === clipId))
  const clip = board?.footage.find((c) => c.id === clipId)
  if (!board || !clip) throw new Error(`No footage clip "${clipId}".`)
  if (clip.status === 'fetched') return clip.fileId
  if (clip.status !== 'approved') throw new Error(`Approve "${clip.title}" before downloading it.`)
  const budget = footageBudgetOf(project, board)
  if (budget.clips >= budget.maxClips) throw new Error(`The brief allows ${budget.maxClips} downloaded clips, and all are used.`)
  const remaining = Math.max(0, budget.maxMegabytes - budget.megabytes) * 1e6
  const id = `video-footage-${clipId}`
  upsertJob({ id, label: `Downloading ${clip.title}`, completed: 0, total: 1, status: 'running' })
  try {
    const { data, mimeType } = await desktop.footageDownload({ url: clip.url, maxBytes: remaining })
    const blob = new Blob([data], { type: mimeType })
    const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
    const track = await input.getPrimaryVideoTrack()
    if (!track || !(await track.canDecode())) throw new Error(`"${clip.title}" is in a format the app can't play.`)
    const meta = { name: `${clip.title}.${mimeType === 'video/webm' ? 'webm' : 'mp4'}`, width: track.displayWidth, height: track.displayHeight, duration: await track.computeDuration() }
    input.dispose()
    const fileId = await storeFootage(clipId, blob, meta, history)
    upsertJob({ id, label: `Downloading ${clip.title}`, completed: 1, total: 1, status: 'done' })
    return fileId
  } catch (error) {
    upsertJob({ id, label: `Downloading ${clip.title}`, completed: 0, total: 1, status: 'failed', message: String(error) })
    throw error
  }
}

export function footageBudgetOf(project: studio.StudioProject, board: studio.Storyboard) {
  return studio.footageBudget(project, board)
}

/** Approves a candidate and downloads it, reporting problems as toasts. */
export async function approveAndDownload(clipId: string): Promise<void> {
  dispatch({ type: 'video.footage.review', params: { clipId, status: 'approved' } }, { label: 'Approve clip' })
  try {
    await downloadClip(clipId)
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error')
  }
}
