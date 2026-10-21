import { registerAacEncoder } from '@mediabunny/aac-encoder'
import { AudioBufferSource, BufferTarget, CanvasSource, Mp4OutputFormat, Output, Quality, canEncodeAudio, getFirstEncodableAudioCodec, getFirstEncodableVideoCodec } from 'mediabunny'
import { studio } from '@reborn/studio-core'
import { Timeline, VideoRenderer, chapters, footageCredits } from '@reborn/video'
import { desktop } from '../platform/desktop'
import { getState, toast, upsertJob } from '../state/store'
import { footage } from './media'
import { analyzeSong } from './session'

// Offline MP4 export: renders every frame with the same WebGL2 renderer as
// the preview, encodes it with WebCodecs, and muxes it with the offline mix.
// Nothing leaves the machine and no Python or ffmpeg is involved.

export interface VideoExportOptions {
  /** Scale of the storyboard size: 1 for the final, 0.5 for a quick draft. */
  scale: number
  /** Seconds to export; defaults to the whole song including the tail. */
  range?: [number, number]
  storyboardId?: string
}

export interface VideoExportResult {
  /** Where the file was saved, or null when the save dialog was cancelled. */
  path: string | null
  bytes: number
  width: number
  height: number
  seconds: number
  codec: string
}

/** A text file saved next to the video. */
interface Extra {
  name: string
  text: string
}

/**
 * Video bitrate: 14 Mbps at 1080p30, scaled by pixels and frame rate. Grain
 * and fractals look clean at this rate; an uncapped high-quality encode of
 * the first test video was over four times larger.
 */
const videoBitrate = (width: number, height: number, fps: number) => Math.max(1.5e6, Math.round(14e6 * ((width * height) / (1920 * 1080)) * (fps / 30)))

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'video'
const even = (value: number) => Math.max(2, Math.round(value / 2) * 2)

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

async function save(data: ArrayBuffer, name: string, extras: Extra[]): Promise<string | null> {
  if (desktop) return desktop.saveVideo(data, name, extras)
  download(new Blob([data], { type: 'video/mp4' }), name)
  for (const extra of extras) download(new Blob([extra.text], { type: 'text/plain' }), extra.name)
  return name
}

/** The publishing kit: a description with chapters and the footage credits. */
export function publishingText(project: studio.StudioProject, board: studio.Storyboard, fullSong: boolean): string {
  const parts = [project.name]
  const chapterList = fullSong ? chapters(project) : ''
  if (chapterList) parts.push(`Chapters\n${chapterList}`)
  const credits = footageCredits(board)
  if (credits) parts.push(credits)
  return parts.join('\n\n')
}

/** Loads every font the storyboard's text uses, so the first frames don't fall back. */
export async function loadVideoFonts(board: studio.Storyboard): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts) return
  const specs = new Set(board.text.map((item) => `${item.weight} 100px "${item.font}"`))
  await Promise.all([...specs].map((spec) => document.fonts.load(spec).catch(() => [])))
}

let running: AbortController | null = null
let aacReady: Promise<void> | null = null

/**
 * Electron's WebCodecs has no AAC encoder, and AAC is what every player and
 * platform accepts in MP4. Where the platform lacks one, a WebAssembly build
 * of FFmpeg's AAC encoder stands in.
 */
function ensureAac(): Promise<void> {
  aacReady ??= canEncodeAudio('aac').then((native) => {
    if (!native) registerAacEncoder()
  })
  return aacReady
}

export async function exportVideo(options: VideoExportOptions): Promise<VideoExportResult | null> {
  if (running) {
    toast('A video export is already running.')
    return null
  }
  const { project } = getState()
  const board = studio.requireStoryboard(project, options.storyboardId)
  const controller = new AbortController()
  running = controller
  const id = `video-export-${Date.now()}`
  const label = options.scale < 1 ? 'Rendering video draft' : 'Rendering video'
  const cancel = () => controller.abort()
  try {
    const analysis = await analyzeSong()
    if (!analysis) return null
    if (controller.signal.aborted) throw new DOMException('Export cancelled.', 'AbortError')
    const { features, mix } = analysis
    const width = even(board.width * options.scale)
    const height = even(board.height * options.scale)
    const fps = board.fps
    const timeline = new Timeline(project, board, features)
    const audioSeconds = mix.channels[0].length / mix.sampleRate
    const [from, to] = options.range ?? [0, audioSeconds]
    const fullSong = from <= 0 && to >= audioSeconds - 0.01
    const first = Math.round(from * fps)
    const last = Math.round(Math.min(to, audioSeconds) * fps)

    await ensureAac()
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
    renderer.setFootage(footage)

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
      await renderer.prepare(t)
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
    const base = `${slug(project.name)}-${slug(board.name)}${options.scale < 1 ? '-draft' : ''}${fullSong ? '' : `-${Math.round(from)}s`}`
    const kit = publishingText(project, board, fullSong)
    const target = await save(data, `${base}.mp4`, options.scale < 1 ? [] : [{ name: `${base}-description.txt`, text: kit }])
    upsertJob({ id, label, completed: total, total, status: 'done' })
    const shareAlike = board.footage.some((clip) => clip.licence === 'cc-by-sa' && board.scenes.some((scene) => scene.clips.includes(clip.id)))
    if (target) toast(`Exported ${width}×${height} ${videoCodec.toUpperCase()} video (${(data.byteLength / 1e6).toFixed(0)} MB).${shareAlike ? ' It uses CC BY-SA footage, which may require releasing the video under the same licence.' : ''}`, shareAlike ? 'info' : 'success')
    return { path: target, bytes: data.byteLength, width, height, seconds: total / fps, codec: videoCodec }
  } catch (error) {
    const cancelled = controller.signal.aborted
    upsertJob({ id, label, completed: 0, total: 1, status: cancelled ? 'cancelled' : 'failed', message: String(error) })
    toast(cancelled ? 'Video export cancelled' : `Video export failed: ${error instanceof Error ? error.message : String(error)}`, cancelled ? 'info' : 'error')
    return null
  } finally {
    running = null
  }
}

export function cancelVideoExport(): void {
  running?.abort()
}
