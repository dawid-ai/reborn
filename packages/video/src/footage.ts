import { ALL_FORMATS, BlobSource, CanvasSink, Input, type WrappedCanvas } from 'mediabunny'

// Decodes footage clips for the footage looks with WebCodecs, through
// Mediabunny. Playback within a cut is sequential, so each clip keeps one
// running decoder and only seeks when the picture jumps: on a cut, a loop,
// or a scrub.

export interface FootageFrame {
  image: TexImageSource
  width: number
  height: number
}

/** Where the renderer gets footage frames. `frame` never blocks; `prepare` decodes ahead. */
export interface FootageSource {
  frame(fileId: string, seconds: number): FootageFrame | null
  prepare(fileId: string, seconds: number): Promise<void>
}

interface ClipState {
  input: Input
  sink: CanvasSink
  duration: number
  frames: AsyncGenerator<WrappedCanvas, void, unknown> | null
  current: WrappedCanvas | null
  /** Serializes decoder work per clip. */
  queue: Promise<void>
  /** The latest time asked for while work was queued; older requests are skipped. */
  wanted: number | null
}

/** Seconds ahead of the current frame that the decoder steps through instead of seeking. */
const STEP_LIMIT = 1.5

export class FootageDecoder implements FootageSource {
  private readonly clips = new Map<string, Promise<ClipState | null>>()
  private readonly ready = new Map<string, ClipState>()

  constructor(
    private readonly load: (fileId: string) => Promise<Blob | null>,
    /** Decoded frames are scaled to this width to save memory. */
    private readonly width = 1920,
  ) {}

  frame(fileId: string, seconds: number): FootageFrame | null {
    const clip = this.ready.get(fileId)
    if (!clip) {
      void this.open(fileId)
      return null
    }
    void this.prepare(fileId, seconds)
    const current = clip.current
    return current ? { image: current.canvas as TexImageSource, width: current.canvas.width, height: current.canvas.height } : null
  }

  async prepare(fileId: string, seconds: number): Promise<void> {
    const clip = await this.open(fileId)
    if (!clip) return
    const target = clip.duration > 0 ? ((seconds % clip.duration) + clip.duration) % clip.duration : Math.max(0, seconds)
    if (covers(clip.current, target)) return
    clip.wanted = target
    clip.queue = clip.queue.then(() => this.advance(clip)).catch(() => undefined)
    await clip.queue
  }

  dispose(): void {
    for (const clip of this.ready.values()) {
      void clip.frames?.return()
      clip.input.dispose()
    }
    this.ready.clear()
    this.clips.clear()
  }

  private open(fileId: string): Promise<ClipState | null> {
    let pending = this.clips.get(fileId)
    if (!pending) {
      pending = (async () => {
        const blob = await this.load(fileId)
        if (!blob) return null
        const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
        const track = await input.getPrimaryVideoTrack()
        if (!track || !(await track.canDecode())) {
          input.dispose()
          return null
        }
        const clip: ClipState = {
          input,
          sink: new CanvasSink(track, { width: Math.min(this.width, track.displayWidth), poolSize: 3 }),
          duration: await track.computeDuration(),
          frames: null,
          current: null,
          queue: Promise.resolve(),
          wanted: null,
        }
        this.ready.set(fileId, clip)
        return clip
      })().catch(() => null)
      this.clips.set(fileId, pending)
    }
    return pending
  }

  private async advance(clip: ClipState): Promise<void> {
    const target = clip.wanted
    clip.wanted = null
    if (target === null || covers(clip.current, target)) return
    const current = clip.current
    const stepping = clip.frames && current && target >= current.timestamp && target - current.timestamp < STEP_LIMIT
    if (!stepping) {
      void clip.frames?.return()
      clip.frames = clip.sink.canvases(target)
    }
    for (;;) {
      const next = await clip.frames!.next()
      if (next.done) {
        clip.frames = null
        return
      }
      clip.current = next.value
      if (next.value.timestamp + next.value.duration > target || clip.wanted !== null) return
    }
  }
}

function covers(frame: WrappedCanvas | null, seconds: number): boolean {
  return Boolean(frame && seconds >= frame.timestamp - 1e-3 && seconds < frame.timestamp + Math.max(frame.duration, 1 / 120))
}
