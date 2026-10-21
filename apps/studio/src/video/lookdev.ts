import { studio } from '@reborn/studio-core'
import { type StillMoment, Timeline, contactSheet, keyMoments, renderStills } from '@reborn/video'
import { type DispatchOptions, getState, toast, upsertJob } from '../state/store'
import { loadVideoFonts } from './export'
import { footage, storeStill } from './media'
import { getAnalysis, isAnalysisCurrent } from './session'

// Look-dev: renders stills at the moments that matter and a contact sheet of
// them, stored on the storyboard so the user (and the Director) can review
// framing and brightness before any long render.

export interface LookDevResult {
  stills: { fileId: string; seconds: number; label: string }[]
  sheetId: string | null
}

/** Long edge of look-dev stills, in pixels. */
const STILL_EDGE = 960

export async function renderLookDev(options: { storyboardId?: string; moments?: StillMoment[]; history?: DispatchOptions } = {}): Promise<LookDevResult | null> {
  const { project } = getState()
  const board = studio.requireStoryboard(project, options.storyboardId)
  const analysis = getAnalysis()
  const timeline = new Timeline(project, board, isAnalysisCurrent(project) ? analysis.features : null)
  const moments = options.moments?.length ? options.moments : keyMoments(timeline)
  if (!moments.length) {
    toast('There are no scenes to render stills of.', 'error')
    return null
  }
  const scale = STILL_EDGE / Math.max(board.width, board.height)
  const size = { width: Math.round((board.width * scale) / 2) * 2, height: Math.round((board.height * scale) / 2) * 2 }
  const id = `video-stills-${Date.now()}`
  const label = `Rendering ${moments.length} still${moments.length === 1 ? '' : 's'}`
  upsertJob({ id, label, completed: 0, total: moments.length + 1, status: 'running' })
  try {
    await loadVideoFonts(board)
    const rendered = await renderStills(timeline, moments, size, footage)
    const history = { origin: 'manual' as const, ...options.history }
    const stills = []
    for (const [i, still] of rendered.entries()) {
      const fileId = await storeStill(still.blob, { storyboardId: board.id, kind: 'still', name: `${still.label} ${still.seconds.toFixed(2)}s.png`, width: still.width, height: still.height, seconds: still.seconds }, { ...history, label: 'Add still' })
      if (fileId) stills.push({ fileId, seconds: still.seconds, label: still.label })
      upsertJob({ id, label, completed: i + 1, total: moments.length + 1, status: 'running' })
    }
    const sheet = await contactSheet(rendered, { title: `${project.name} · ${board.name} · ${board.stage}` })
    const sheetBitmap = await createImageBitmap(sheet)
    const sheetId = await storeStill(sheet, { storyboardId: board.id, kind: 'sheet', name: `Contact sheet ${new Date().toISOString().slice(0, 16)}.png`, width: sheetBitmap.width, height: sheetBitmap.height, seconds: null }, { ...history, label: 'Add contact sheet' })
    sheetBitmap.close()
    upsertJob({ id, label, completed: moments.length + 1, total: moments.length + 1, status: 'done' })
    return { stills, sheetId }
  } catch (error) {
    upsertJob({ id, label, completed: 0, total: 1, status: 'failed', message: String(error) })
    toast(`Stills failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
    return null
  }
}
