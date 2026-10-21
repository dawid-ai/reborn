import { integratedLoudness, truePeak } from '@reborn/analysis'
import { applyMaster, renderStudio } from '@reborn/audio-engine/studio'
import { dispatch, getState, toast, upsertJob } from '../state/store'
import { engine } from './host'

export const MAX_LOUDNESS = 18

export interface LoudnessMatch {
  loudness: number
  lufs: number
  truePeakDb: number
  /** True when even the most loudness stayed short of the target. */
  short: boolean
}

/**
 * Finds the master loudness that brings the whole song to `target` LUFS.
 * The song renders once without the master, as long as an export; each try
 * then runs only the master chain, about a second per minute of audio.
 */
export async function findLoudness(target: number, signal?: AbortSignal, onProgress?: (completed: number, total: number) => void): Promise<LoudnessMatch> {
  const { project } = getState()
  const premix = await renderStudio(project, engine.assetBuffers(), { master: false, signal, onProgress })
  const measure = async (loudness: number) => {
    const channels = await applyMaster({ ...project, master: { ...project.master, loudness } }, premix.channels, premix.sampleRate)
    return { loudness, lufs: integratedLoudness(channels, premix.sampleRate), truePeakDb: truePeak(channels, premix.sampleRate) }
  }
  const clampLoudness = (value: number) => Math.round(Math.min(MAX_LOUDNESS, Math.max(0, value)) * 2) / 2
  let previous = await measure(project.master.loudness ?? 0)
  if (!Number.isFinite(previous.lufs)) throw new Error('The song is silent, so there is nothing to measure.')
  let best = previous
  // Limiting makes each extra dB worth less than a dB, so step with the
  // measured slope (secant) instead of assuming one for one.
  let next = clampLoudness(previous.loudness + (target - previous.lufs))
  for (let attempt = 0; attempt < 6 && next !== previous.loudness; attempt += 1) {
    signal?.throwIfAborted()
    const current = await measure(next)
    if (Math.abs(current.lufs - target) < Math.abs(best.lufs - target)) best = current
    if (Math.abs(current.lufs - target) < 0.3) break
    const slope = (current.lufs - previous.lufs) / (current.loudness - previous.loudness)
    previous = current
    next = clampLoudness(current.loudness + (target - current.lufs) / (Number.isFinite(slope) && slope > 0.1 ? slope : 1))
  }
  return { ...best, short: best.loudness >= MAX_LOUDNESS && best.lufs < target - 0.5 }
}

/** Sets master loudness so the song plays at `target` LUFS, as one undo step. */
export async function matchLoudness(target: number): Promise<LoudnessMatch | null> {
  const controller = new AbortController()
  const id = `loudness-${Date.now()}`
  const label = `Matching ${target} LUFS`
  upsertJob({ id, label, completed: 0, total: 1, status: 'running', cancel: () => controller.abort() })
  try {
    const match = await findLoudness(target, controller.signal, (completed, total) => upsertJob({ id, label, completed, total, status: 'running', cancel: () => controller.abort() }))
    dispatch({ type: 'master.set', params: { loudness: match.loudness } }, { label: `Match ${target} LUFS` })
    upsertJob({ id, label, completed: 1, total: 1, status: 'done' })
    toast(
      match.short
        ? `Loudness is at its maximum and the song reaches ${match.lufs.toFixed(1)} LUFS. Raise track levels or master Compress to go louder.`
        : `The song now plays at ${match.lufs.toFixed(1)} LUFS (loudness +${match.loudness} dB, true peak ${match.truePeakDb.toFixed(1)} dBTP).`,
      match.short ? 'info' : 'success',
    )
    return match
  } catch (error) {
    const cancelled = controller.signal.aborted
    upsertJob({ id, label, completed: 0, total: 1, status: cancelled ? 'cancelled' : 'failed', message: String(error) })
    toast(cancelled ? 'Loudness match cancelled' : `Loudness match failed: ${error instanceof Error ? error.message : String(error)}`, cancelled ? 'info' : 'error')
    return null
  }
}
