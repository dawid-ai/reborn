import { studio } from '@reborn/studio-core'
import { type Channel, type Cues, buildCues, lastIndex, pulse } from './cues'
import { type AudioFeatures, featureAt } from './features'
import { type Look, lookById } from './looks'

type StudioProject = studio.StudioProject
type Storyboard = studio.Storyboard
type VideoScene = studio.VideoScene
type VideoText = studio.VideoText
type PostKey = studio.PostKey
type ExprScope = studio.ExprScope
type FootageClip = studio.FootageClip

// A storyboard resolved against the song: scenes with start and end times,
// compiled expressions, cut events, and the camera travel integrated over the
// whole song. The renderer asks it for everything that changes per frame.

export type ValueFn = (scope: ExprScope) => number[]
export type ScalarFn = (scope: ExprScope) => number

export interface ResolvedParam {
  name: string
  fn: ValueFn
  /** Components the look's uniform expects. */
  size: number
}

export interface ResolvedLayer {
  look: Look
  amount: ScalarFn
  params: ResolvedParam[]
}

export interface ResolvedScene {
  scene: VideoScene
  index: number
  t0: number
  t1: number
  look: Look | null
  params: ResolvedParam[]
  layers: ResolvedLayer[]
  post: Record<PostKey, ScalarFn>
  /** Cut event times inside the scene. */
  cuts: Float64Array
  /** Downloaded footage clips the scene plays, in its order. */
  clips: FootageClip[]
}

/** Which footage frame a scene shows at a moment. */
export interface FootageRequest {
  clip: FootageClip
  fileId: string
  /** Seconds into the clip file. */
  seconds: number
}

const seeded = (n: number) => {
  const x = Math.sin(n * 12.9898) * 43758.5453
  return x - Math.floor(x)
}

export interface ResolvedText {
  item: VideoText
  t0: number
  t1: number
  /** Word change times for the words style. */
  events: Float64Array
}

function safeScalar(value: studio.VideoExpr | undefined, fallback: number, warn: (message: string) => void): ScalarFn {
  if (value === undefined) return () => fallback
  try {
    return studio.compileScalar(value)
  } catch (error) {
    warn(error instanceof Error ? error.message : String(error))
    return () => fallback
  }
}

function resolveParams(look: Look, values: Record<string, studio.VideoValue>, warn: (message: string) => void): ResolvedParam[] {
  return look.params.map((param) => {
    const value = values[param.name]
    let fn: ValueFn = () => param.default
    if (value !== undefined) {
      try {
        const compiled = studio.compileValue(value)
        // A scalar given for a vector parameter fills every component.
        fn = param.default.length > 1 && !Array.isArray(value) ? (s) => Array(param.default.length).fill(compiled(s)[0]) : compiled
      } catch (error) {
        warn(`${look.title} ${param.name}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return { name: param.name, fn, size: param.default.length }
  })
}

function mergeTimes(lists: Float64Array[], from: number, to: number): Float64Array {
  const all = new Set<number>()
  for (const times of lists) for (const t of times) if (t > from + 1e-4 && t < to) all.add(Math.round(t * 1e5) / 1e5)
  return Float64Array.from([...all].sort((a, z) => a - z))
}

export class Timeline {
  readonly cues: Cues
  readonly duration: number
  readonly fps: number
  readonly scenes: ResolvedScene[] = []
  readonly texts: ResolvedText[] = []
  readonly warnings: string[] = []
  readonly fade: ScalarFn
  readonly impact: Storyboard['impact']
  /** Every look the storyboard uses, scenes first, then layers. */
  readonly looks: Look[]
  private readonly push: Float64Array

  constructor(
    readonly project: StudioProject,
    readonly board: Storyboard,
    readonly features: AudioFeatures | null = null,
  ) {
    const warn = (message: string) => {
      if (!this.warnings.includes(message)) this.warnings.push(message)
    }
    const seconds = (ref: studio.TimeRef) => studio.timeRefSeconds(project, ref)
    const impacts = board.impacts.map(seconds).filter((t): t is number => t !== null)
    this.cues = buildCues(project, impacts)
    this.duration = this.cues.duration
    this.fps = board.fps
    this.fade = safeScalar(board.fade, 1, warn)
    this.impact = board.impact

    const timed = board.scenes
      .map((scene) => ({ scene, t0: seconds(scene.start) }))
      .filter((entry): entry is { scene: VideoScene; t0: number } => {
        if (entry.t0 === null) warn(`Scene "${entry.scene.name || entry.scene.look}" starts at a section that no longer exists.`)
        return entry.t0 !== null
      })
      .sort((a, z) => a.t0 - z.t0)
    timed.forEach(({ scene, t0 }, index) => {
      const t1 = index + 1 < timed.length ? timed[index + 1].t0 : this.duration + 60
      const look = lookById(scene.look) ?? null
      if (!look) warn(`Scene "${scene.name || scene.look}" uses an unknown look, "${scene.look}".`)
      const post = Object.fromEntries(studio.POST_KEYS.map((key) => [key, safeScalar(scene.post[key], studio.POST_DEFAULTS[key], warn)])) as Record<PostKey, ScalarFn>
      const layers = scene.layers.slice(0, 3).flatMap((layer) => {
        const layerLook = lookById(layer.look)
        if (!layerLook) {
          warn(`A layer in "${scene.name || scene.look}" uses an unknown look, "${layer.look}".`)
          return []
        }
        return [{ look: layerLook, amount: safeScalar(layer.amount, 1, warn), params: resolveParams(layerLook, layer.params, warn) }]
      })
      const cuts = mergeTimes(
        scene.cutOn.map((channel) => this.cues.channels[channel]),
        t0,
        t1,
      )
      const clips = scene.clips.flatMap((id) => {
        const clip = board.footage.find((c) => c.id === id)
        return clip?.status === 'fetched' && clip.fileId ? [clip] : []
      })
      if (scene.clips.length && !clips.length) warn(`Scene "${scene.name || scene.look}" has no downloaded footage yet.`)
      this.scenes.push({ scene, index, t0, t1, look, params: look ? resolveParams(look, scene.params, warn) : [], layers, post, cuts, clips })
    })

    for (const item of board.text) {
      const t0 = seconds(item.start)
      const t1 = seconds(item.end)
      if (t0 === null || t1 === null) {
        warn(`Text "${item.text.slice(0, 20)}" is timed to a section that no longer exists.`)
        continue
      }
      const events = mergeTimes(item.on.map((channel) => this.cues.channels[channel]), t0 - 1e-3, t1)
      this.texts.push({ item, t0, t1, events })
    }

    const used = new Map<string, Look>()
    for (const s of this.scenes) if (s.look) used.set(s.look.id, s.look)
    for (const s of this.scenes) for (const layer of s.layers) used.set(layer.look.id, layer.look)
    this.looks = [...used.values()]

    // Camera travel integrates speed plus kick and snare bursts, so tunnels
    // lunge forward on the drums.
    const frames = Math.ceil((this.duration + 1) * this.fps) + 2
    this.push = new Float64Array(frames)
    let acc = 0
    for (let f = 0; f < frames; f += 1) {
      const t = f / this.fps
      const travel = this.sceneAt(t)?.scene.travel
      if (travel) {
        acc += (travel.base + travel.kick * pulse(this.cues, 'kick', t).value + travel.snare * pulse(this.cues, 'snare', t).value + travel.bass * featureAt(features, 'bass', t)) / this.fps
      }
      this.push[f] = acc
    }
  }

  sceneAt(t: number): ResolvedScene | null {
    let current: ResolvedScene | null = null
    for (const scene of this.scenes) if (scene.t0 <= t + 1e-6) current = scene
    return current
  }

  /** Camera travel at t, interpolated between frames. */
  pushAt(t: number): number {
    const pos = Math.max(0, t * this.fps)
    const i = Math.min(this.push.length - 2, Math.floor(pos))
    return this.push[i] + (this.push[i + 1] - this.push[i]) * (pos - i)
  }

  /** Every value expressions can read at time t, for a scene (or the song when null). */
  scope(t: number, scene: ResolvedScene | null): Record<string, number> {
    const { cues, features } = this
    const kick = pulse(cues, 'kick', t)
    const snare = pulse(cues, 'snare', t)
    let rise = 0
    let rstrobe = 1
    for (const [a, b] of cues.risers) {
      if (t >= a && t < b) {
        rise = (t - a) / (b - a)
        // The strobe subdivides from quarters to eighths to sixteenths through the riser.
        const sub = rise < 0.5 ? cues.beatSeconds : rise < 0.75 ? cues.beatSeconds / 2 : cues.beatSeconds / 4
        rstrobe = 1 - 0.65 * rise + 0.9 * rise * Math.exp(-((t - a) % sub) * 18)
      }
    }
    const impacts = cues.channels.impact
    const last = lastIndex(impacts, t)
    const scope: Record<string, number> = {
      t,
      songLen: this.duration,
      beat: t / cues.beatSeconds,
      bar: t / cues.barSeconds,
      BEAT: cues.beatSeconds,
      BAR: cues.barSeconds,
      kick: kick.value,
      kt: kick.since,
      snare: snare.value,
      st: snare.since,
      hat: pulse(cues, 'hat', t).value,
      rise,
      rstrobe,
      toImpact: last + 1 < impacts.length ? impacts[last + 1] - t : 99,
      sinceImpact: last >= 0 ? t - impacts[last] : 99,
      sub: featureAt(features, 'sub', t),
      bass: featureAt(features, 'bass', t),
      mid: featureAt(features, 'mid', t),
      harsh: featureAt(features, 'harsh', t),
      air: featureAt(features, 'air', t),
      rms: featureAt(features, 'rms', t),
      hatEnv: featureAt(features, 'hatEnv', t),
      L: 0,
      len: 1,
      x: 0,
      cut: 0,
      cutT: 0,
    }
    if (scene) {
      const L = t - scene.t0
      const len = Math.min(scene.t1, this.duration) - scene.t0 || 1
      const cut = lastIndex(scene.cuts, t) + 1
      scope.L = L
      scope.len = len
      scope.x = Math.min(1, Math.max(0, L / len))
      scope.cut = cut
      scope.cutT = cut > 0 ? t - scene.cuts[cut - 1] : L
    }
    return scope
  }

  /**
   * The footage frame a scene shows: each cut moves to the next clip (or a
   * seeded random one when shuffled), starting at the clip's start point and
   * playing forward at the clip speed.
   */
  footageAt(t: number, scene: ResolvedScene | null, scope: Readonly<Record<string, number>>): FootageRequest | null {
    if (!scene?.clips.length) return null
    const { clips } = scene
    const cut = scope.cut
    const clip = scene.scene.clipOrder === 'shuffle' ? clips[Math.floor(seeded(scene.index * 1000 + cut + 1) * clips.length) % clips.length] : clips[cut % clips.length]
    const usable = Math.max(0, clip.duration - clip.skip - 4)
    const start = scene.scene.clipStart === 'random' ? clip.skip + seeded(scene.index * 7919 + cut + 3) * usable : clip.skip + scene.scene.clipStart
    return { clip, fileId: clip.fileId!, seconds: start + scope.cutT * scene.scene.clipSpeed }
  }

  /** Times of one channel's events, for drawing cue lanes. */
  events(channel: Channel): Float64Array {
    return this.cues.channels[channel]
  }
}

export const evaluatePost = (scene: ResolvedScene | null, scope: ExprScope): Record<PostKey, number> =>
  Object.fromEntries(studio.POST_KEYS.map((key) => [key, scene ? scene.post[key](scope) : studio.POST_DEFAULTS[key]])) as Record<PostKey, number>
