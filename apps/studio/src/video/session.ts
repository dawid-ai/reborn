import { useSyncExternalStore } from 'react'
import { renderStudio } from '@reborn/audio-engine/studio'
import { studio } from '@reborn/studio-core'
import { type AudioFeatures, analyzeMix } from '@reborn/video'
import { engine, ensureAssets } from '../audio/host'
import { getState, toast, upsertJob } from '../state/store'

type StudioProject = studio.StudioProject

// The rendered mix and its per-frame envelopes, shared by the Video view's
// preview and the MP4 export. Video edits never invalidate it; any change to
// the music does, and the view shows that the analysis is out of date
// instead of re-rendering on its own.

export interface MixRender {
  channels: Float32Array<ArrayBuffer>[]
  sampleRate: number
}

interface AnalysisState {
  features: AudioFeatures | null
  mix: MixRender | null
  /** Music signature the analysis was made from. */
  signature: string | null
  running: boolean
}

let state: AnalysisState = { features: null, mix: null, signature: null, running: false }
const listeners = new Set<() => void>()

function setAnalysis(patch: Partial<AnalysisState>) {
  state = { ...state, ...patch }
  for (const listener of listeners) listener()
}

function subscribeAnalysis(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useAnalysis(): AnalysisState {
  return useSyncExternalStore(subscribeAnalysis, () => state, () => state)
}

export const getAnalysis = () => state

const signatures = new WeakMap<StudioProject, string>()

/** Everything that changes the sound, and nothing that only changes the video or history. */
export function musicSignature(project: StudioProject): string {
  let signature = signatures.get(project)
  if (signature === undefined) {
    const { video: _video, audit: _audit, revision: _revision, name: _name, createdAt: _created, ...music } = project
    signature = JSON.stringify(music)
    signatures.set(project, signature)
  }
  return signature
}

export const isAnalysisCurrent = (project: StudioProject) => state.signature !== null && state.signature === musicSignature(project)

let controller: AbortController | null = null

/** Renders the mix and measures it. Resolves with the result, or null when cancelled or failed. */
export async function analyzeSong(): Promise<{ features: AudioFeatures; mix: MixRender } | null> {
  const project = getState().project
  const signature = musicSignature(project)
  if (state.signature === signature && state.features && state.mix) return { features: state.features, mix: state.mix }
  controller?.abort()
  const current = new AbortController()
  controller = current
  const id = 'video-analysis'
  const label = 'Analyzing the mix for video'
  const cancel = () => current.abort()
  setAnalysis({ running: true })
  upsertJob({ id, label, completed: 0, total: 2, status: 'running', cancel })
  try {
    await ensureAssets(project)
    const result = await renderStudio(project, engine.assetBuffers(), {
      signal: current.signal,
      onProgress: (done, total) => upsertJob({ id, label, completed: done / total, total: 2, status: 'running', cancel }),
    })
    const features = await analyzeMix(result.channels, result.sampleRate, 30, {
      signal: current.signal,
      onProgress: (done, total) => upsertJob({ id, label, completed: 1 + done / total, total: 2, status: 'running', cancel }),
    })
    const mix = { channels: result.channels, sampleRate: result.sampleRate }
    setAnalysis({ features, mix, signature, running: false })
    upsertJob({ id, label, completed: 2, total: 2, status: 'done' })
    return { features, mix }
  } catch (error) {
    const cancelled = current.signal.aborted
    if (controller === current) setAnalysis({ running: false })
    upsertJob({ id, label, completed: 0, total: 2, status: cancelled ? 'cancelled' : 'failed', message: String(error) })
    if (!cancelled) toast(`Video analysis failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
    return null
  }
}
