import { AudioBufferSource, BufferTarget, CanvasSource, Mp4OutputFormat, Output, Quality, getFirstEncodableAudioCodec, getFirstEncodableVideoCodec } from 'mediabunny'
import { studio } from '@reborn/studio-core'
import { Timeline, VideoRenderer } from '@reborn/video'
import { desktop } from '../platform/desktop'
import { getState, toast, upsertJob } from '../state/store'
import { analyzeSong } from './session'

// Offline MP4 export: renders every frame with the same WebGL2 renderer as
// the preview, encodes it with WebCodecs, and muxes it with the offline mix.
// Nothing leaves the machine and no Python or ffmpeg is involved.

export interface VideoExportOptions {
  /** Scale of the storyboard size: 1 for the final, 0.5 for a quick draft. */
  scale: number
  /** Seconds to export; defaults to the whole song including the tail. */
  range?: [number, number]
}

/**
 * Video bitrate: 14 Mbps at 1080p30, scaled by pixels and frame rate. Grain
 * and fractals look clean at this rate; an uncapped high-quality encode of
 * the first test video was over four times larger.
 */
const videoBitrate = (width: number, height: number, fps: number) => Math.max(1.5e6, Math.round(14e6 * ((width * height) / (1920 * 1080)) * (fps / 30)))

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'video'
const even = (value: number) => Math.max(2, Math.round(value / 2) * 2)

async function save(data: ArrayBuffer, name: string): Promise<string | null> {
  if (desktop) return desktop.saveVideo(data, name)
  const url = URL.createObjectURL(new Blob([data], { type: 'video/mp4' }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
  return name
}

/** Loads every font the storyboard's text uses, so the first frames don't fall back. */
export async function loadVideoFonts(board: studio.Storyboard): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts) return
  const specs = new Set(board.text.map((item) => `${item.weight} 100px "${item.font}"`))
  await Promise.all([...specs].map((spec) => document.fonts.load(spec).catch(() => [])))
}

let running: AbortController | null = null

export async function exportVideo(options: VideoExportOptions): Promise<void> {
  if (running) return toast('A video export is already running.')
  const { project } = getState()
  const board = studio.requireStoryboard(project)
  const controller = new AbortController()
  running = controller
  const id = `video-export-${Date.now()}`
  const label = options.scale < 1 ? 'Rendering video draft' : 'Rendering video'
  const cancel = () => controller.abort()
  try {
    const analysis = await analyzeSong()
    if (!analysis) return
    if (controller.signal.aborted) throw new DOMException('Export cancelled.', 'AbortError')
    const { features, mix } = analysis
    const width = even(board.width * options.scale)
    const height = even(board.height * options.scale)
    const fps = board.fps
    const timeline = new Timeline(project, board, features)
    const audioSeconds = mix.channels[0].length / mix.sampleRate
    const [from, to] = options.range ?? [0, audioSeconds]
    const first = Math.round(from * fps)
    const last = Math.round(Math.min(to, audioSeconds) * fps)

    const videoQuality = new Quality({ bitrate: videoBitrate(width, height, fps), bitrateMode: 'variable' })
    const audioQuality = new Quality({ bitrate: 320_000 })
    const videoCodec = await getFirstEncodableVideoCodec(['avc', 'hevc', 'vp9', 'av1'], { width, height, frameRate: fps, quality: videoQuality })
    const audioCodec = await getFirstEncodableAudioCodec(['aac', 'opus'], { numberOfChannels: 2, sampleRate: mix.sampleRate, quality: audioQuality })
    if (!videoCodec) throw new Error('This system has no video encoder for MP4.')
    if (!audioCodec) throw new Error('This system has no audio encoder for MP4.')

    await loadVideoFonts(board)
    const canvas = new OffscreenCanvas(width, height)
    const renderer = new VideoRenderer(canvas, { preserveDrawingBuffer: true })
    renderer.setSize(width, height)
    renderer.setTimeline(timeline)

    const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() })
    const video = new CanvasSource(canvas, { codec: videoCodec, quality: videoQuality, keyFrameInterval: 2 })
    const audio = new AudioBufferSource({ codec: audioCodec, quality: audioQuality })
    output.addVideoTrack(video, { frameRate: fps })
    output.addAudioTrack(audio)
    await output.start()

    // Audio goes in one-second blocks just ahead of the frames that play over
    // them, so the muxer interleaves the tracks without buffering the song.
    const startSample = Math.round(from * mix.sampleRate)
    const endSample = Math.round(Math.min(to, audioSeconds) * mix.sampleRate)
    let audioCursor = startSample
    const addAudioUntil = async (seconds: number) => {
      const until = Math.min(endSample, Math.round(seconds * mix.sampleRate))
      while (audioCursor < until) {
        const length = Math.min(mix.sampleRate, until - audioCursor)
        const buffer = new AudioBuffer({ length, numberOfChannels: 2, sampleRate: mix.sampleRate })
        for (let c = 0; c < 2; c += 1) buffer.copyToChannel(mix.channels[Math.min(c, mix.channels.length - 1)].subarray(audioCursor, audioCursor + length), c)
        await audio.add(buffer)
        audioCursor += length
      }
    }

    const total = last - first
    const started = performance.now()
    for (let frame = first; frame < last; frame += 1) {
      if (controller.signal.aborted) {
        await output.cancel()
        throw new DOMException('Export cancelled.', 'AbortError')
      }
      const t = frame / fps
      await addAudioUntil(t + 1)
      renderer.render(t)
      await video.add((frame - first) / fps, 1 / fps)
      if ((frame - first) % 15 === 0) {
        const done = frame - first
        const rate = done / ((performance.now() - started) / 1000 || 1)
        const eta = done > 30 ? ` · about ${Math.ceil((total - done) / rate / 60)} min left` : ''
        upsertJob({ id, label: `${label} · ${Math.round((done / total) * 100)}%${eta}`, completed: done, total, status: 'running', cancel })
      }
    }
    await addAudioUntil(Infinity)
    await output.finalize()
    renderer.dispose()
    const data = (output.target as BufferTarget).buffer
    if (!data) throw new Error('The encoder produced no data.')
    const name = `${slug(project.name)}-${slug(board.name)}${options.scale < 1 ? '-draft' : ''}.mp4`
    const target = await save(data, name)
    upsertJob({ id, label, completed: total, total, status: 'done' })
    if (target) toast(`Exported ${width}×${height} ${videoCodec.toUpperCase()} video (${(data.byteLength / 1e6).toFixed(0)} MB).`, 'success')
  } catch (error) {
    const cancelled = controller.signal.aborted
    upsertJob({ id, label, completed: 0, total: 1, status: cancelled ? 'cancelled' : 'failed', message: String(error) })
    toast(cancelled ? 'Video export cancelled' : `Video export failed: ${error instanceof Error ? error.message : String(error)}`, cancelled ? 'info' : 'error')
  } finally {
    running = null
  }
}

export function cancelVideoExport(): void {
  running?.abort()
}
