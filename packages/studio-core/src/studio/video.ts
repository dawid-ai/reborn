import { type StudioProject, barSeconds, newId } from './model'
import { StudioError } from './ops'
import { compileExpr } from './video-expr'

// The music video side of a project: storyboards of scenes and text, timed
// against section markers so they survive tempo and length changes. Only the
// video.* commands write this; the music model never reads it.

/** A number, or an expression string evaluated every frame (see video-expr.ts). */
export type VideoExpr = number | string
/** A scalar or a vector (colors, positions) whose parts may be expressions. */
export type VideoValue = VideoExpr | VideoExpr[]

/** A moment in the song: a section's start or end plus an offset in bars. */
export interface TimeRef {
  /** Section ID, or null for the song start. */
  sectionId: string | null
  at: 'start' | 'end'
  /** Offset in bars; fractions are beats, and negative values count back. */
  bars: number
}

export const POST_KEYS = ['ca', 'bloom', 'fb', 'fbZoom', 'fbRot', 'fbHue', 'grain', 'vig', 'strobe', 'white', 'shake'] as const
export type PostKey = (typeof POST_KEYS)[number]

export const POST_DEFAULTS: Readonly<Record<PostKey, number>> = { ca: 0.002, bloom: 0.5, fb: 0, fbZoom: 1, fbRot: 0, fbHue: 0, grain: 0.03, vig: 1, strobe: 1, white: 0, shake: 0 }

export const POST_LABELS: Readonly<Record<PostKey, string>> = {
  ca: 'Chromatic aberration',
  bloom: 'Bloom',
  fb: 'Trails',
  fbZoom: 'Trail zoom',
  fbRot: 'Trail rotation',
  fbHue: 'Trail hue shift',
  grain: 'Grain',
  vig: 'Vignette',
  strobe: 'Strobe (brightness multiplier)',
  white: 'Whiteout',
  shake: 'Shake',
}

/** Events that advance cuts in a scene and words in a text item. */
export const CUT_EVENTS = ['kick', 'snare', 'hat', 'beat', 'half', 'bar', '2bar', '8th', 'impact'] as const
export type CutEvent = (typeof CUT_EVENTS)[number]

export interface VideoTravel {
  /** Camera speed through tunnel looks. */
  base: number
  /** Extra speed on each kick, snare, and with the bass envelope. */
  kick: number
  snare: number
  bass: number
}

export interface VideoLayer {
  look: string
  /** How much of the layer is added on top, 0 to about 1. */
  amount: VideoExpr
  params: Record<string, VideoValue>
}

export interface VideoScene {
  id: string
  name: string
  /** The scene plays from here until the next scene starts. */
  start: TimeRef
  look: string
  params: Record<string, VideoValue>
  layers: VideoLayer[]
  post: Partial<Record<PostKey, VideoExpr>>
  travel: VideoTravel
  cutOn: CutEvent[]
  /** Seconds of crossfade from the previous scene; 0 is a hard cut. */
  xfade: number
  /** Footage clip IDs the footage looks play; each cut moves to the next. */
  clips: string[]
  clipOrder: 'cycle' | 'shuffle'
  /** Where each clip starts playing: a seeded random point, or seconds into the clip. */
  clipStart: 'random' | number
  clipSpeed: number
  /** The library preset this scene came from, pinned to the version it used. */
  preset: LibraryRef | null
}

/** A pinned reference to a library item; later library changes never alter a saved video. */
export interface LibraryRef {
  id: string
  version: number
  name: string
}

export const TEXT_STYLES = ['hold', 'slam', 'words', 'type', 'flicker', 'scroll'] as const
export type TextStyle = (typeof TEXT_STYLES)[number]

export const VIDEO_FONTS = ['Big Shoulders Display', 'Chakra Petch', 'Barlow Condensed', 'Share Tech Mono', 'IBM Plex Sans'] as const
export type VideoFont = (typeof VIDEO_FONTS)[number]

export interface VideoText {
  id: string
  start: TimeRef
  end: TimeRef
  /** Line breaks split lines; with the words style, "|" separates the words. */
  text: string
  style: TextStyle
  font: VideoFont
  weight: number
  /** Size in pixels at 1080p; other sizes scale. */
  size: number
  /** Center of the text, 0 to 1 across and down the frame. */
  pos: [number, number]
  color: [number, number, number]
  /** Events that advance the words style. */
  on: CutEvent[]
  /** Difference inverts whatever is under the text. */
  blend: 'normal' | 'difference'
  /** Slices the text sideways on snares, 0 to about 0.1. */
  glitch: number
  fadeIn: number
  fadeOut: number
  /** Grows the text on kicks, 0 to about 0.2. */
  pulse: number
  /** Extra letter spacing as a fraction of the size. */
  tracking: number
}

export const VIDEO_STAGES = ['brief', 'treatment', 'lookdev', 'draft', 'final'] as const
export type VideoStage = (typeof VIDEO_STAGES)[number]

export const FOOTAGE_PROVIDERS = ['pexels', 'pixabay', 'wikimedia', 'archive'] as const
export type FootageProvider = (typeof FOOTAGE_PROVIDERS)[number]

/**
 * Which licences footage may use. safe: CC0, public domain, and the Pexels and
 * Pixabay licences. attribution adds CC BY (credits required). sharealike
 * adds CC BY-SA, which may require releasing the video under the same licence.
 */
export const LICENCE_POLICIES = ['safe', 'attribution', 'sharealike'] as const
export type LicencePolicy = (typeof LICENCE_POLICIES)[number]

export const LICENCE_KINDS = ['cc0', 'pd', 'pexels', 'pixabay', 'cc-by', 'cc-by-sa', 'other'] as const
export type LicenceKind = (typeof LICENCE_KINDS)[number]

/** The policy a licence needs, or null when no policy allows it (NC, ND, or unknown terms). */
export function licenceNeeds(licence: LicenceKind): LicencePolicy | null {
  if (licence === 'cc-by') return 'attribution'
  if (licence === 'cc-by-sa') return 'sharealike'
  if (licence === 'other') return null
  return 'safe'
}

export function licenceAllowed(licence: LicenceKind, policy: LicencePolicy): boolean {
  const needs = licenceNeeds(licence)
  return needs !== null && LICENCE_POLICIES.indexOf(needs) <= LICENCE_POLICIES.indexOf(policy)
}

export interface FootagePolicy {
  enabled: boolean
  licences: LicencePolicy
  providers: FootageProvider[]
  /** Download budget for the storyboard. */
  maxClips: number
  maxMegabytes: number
}

export interface VideoBrief {
  goal: string
  mood: string
  notes: string
  /** Words and titles to show; empty for none. */
  words: string
  /** Footage is off by default; when on, only safe licences unless the user widens it. */
  footage: FootagePolicy
}

export const COMMENT_STATUSES = ['open', 'addressed', 'wontfix'] as const
export type CommentStatus = (typeof COMMENT_STATUSES)[number]
export const COMMENT_AUTHORS = ['user', 'director'] as const
export type CommentAuthor = (typeof COMMENT_AUTHORS)[number]

/** What a comment is about. */
export type CommentTarget = { kind: 'storyboard' } | { kind: 'scene'; sceneId: string } | { kind: 'text'; textId: string } | { kind: 'time'; at: TimeRef } | { kind: 'still'; fileId: string }

export interface VideoComment {
  id: string
  author: CommentAuthor
  target: CommentTarget
  text: string
  status: CommentStatus
  replies: { author: CommentAuthor; text: string; at: string }[]
  createdAt: string
}

export interface StageApproval {
  stage: VideoStage
  at: string
  /** True when the user approved with comments still open. */
  override: boolean
}

/** The Director asking the user to approve the current stage. */
export interface StageRequest {
  stage: VideoStage
  summary: string
  /** Stills or contact sheets to review. */
  fileIds: string[]
  at: string
}

export interface FootageClip {
  id: string
  provider: FootageProvider
  /** The provider's own ID for the clip. */
  sourceId: string
  title: string
  /** Page that shows the clip and its licence. */
  page: string
  author: string
  licence: LicenceKind
  licenceName: string
  licenceUrl: string
  /** Search words that found it. */
  query: string
  /** candidate: found and waiting for the user. approved: picked, not downloaded yet. fetched: downloaded. */
  status: 'candidate' | 'approved' | 'fetched' | 'rejected'
  proposedBy: CommentAuthor
  /** Small JPEG data URL for review. */
  thumbnail: string
  /** The file to download, chosen by the provider adapter. */
  url: string
  width: number
  height: number
  duration: number
  /** The video file holding the download, once fetched. */
  fileId: string | null
  /** Seconds of title cards or lead-in to skip. */
  skip: number
  tags: string[]
}

export const VIDEO_FILE_KINDS = ['still', 'sheet', 'footage'] as const
export type VideoFileKind = (typeof VIDEO_FILE_KINDS)[number]

/** A binary file on the video side: a still, a contact sheet, or downloaded footage. Saved in the project's video folder. */
export interface VideoFile {
  id: string
  kind: VideoFileKind
  name: string
  mimeType: string
  bytes: number
  width: number
  height: number
  /** Seconds, for footage. */
  duration: number
  /** Song time a still shows, in seconds. */
  seconds: number | null
  createdAt: string
}

export interface Storyboard {
  id: string
  name: string
  width: number
  height: number
  fps: number
  stage: VideoStage
  brief: VideoBrief
  scenes: VideoScene[]
  text: VideoText[]
  /** Master brightness, usually an expression that fades in and out. */
  fade: VideoExpr
  /** Flash, chromatic aberration, and shake fired by each impact. */
  impact: { flash: number; ca: number; shake: number }
  /** Extra impacts on top of clips named "impact". */
  impacts: TimeRef[]
  comments: VideoComment[]
  approvals: StageApproval[]
  request: StageRequest | null
  /** Stages the Director may approve itself. Empty by default, so every gate waits for the user. */
  autoAdvance: VideoStage[]
  footage: FootageClip[]
  /** Still and contact sheet file IDs, oldest first. */
  stills: string[]
  /** The library template the storyboard started from. */
  template: LibraryRef | null
}

export interface VideoState {
  storyboards: Storyboard[]
  activeId: string | null
  /** Stills, contact sheets, and footage, shared by every storyboard in the project. */
  files: Record<string, VideoFile>
}

export const VIDEO_SIZES: readonly { label: string; width: number; height: number }[] = [
  { label: '1080p landscape', width: 1920, height: 1080 },
  { label: '720p landscape', width: 1280, height: 720 },
  { label: '4K landscape', width: 3840, height: 2160 },
  { label: '1080p vertical', width: 1080, height: 1920 },
  { label: '1080p square', width: 1080, height: 1080 },
]

export const DEFAULT_FADE = 'min(1, t/2) * clamp((songLen - t)/3)'

// ---------------------------------------------------------------------------
// Factories

export const songStart = (bars = 0): TimeRef => ({ sectionId: null, at: 'start', bars })

export function defaultTravel(): VideoTravel {
  return { base: 0.3, kick: 0, snare: 0, bass: 0 }
}

export function createScene(look: string, start: TimeRef, patch: Partial<Omit<VideoScene, 'id'>> = {}): VideoScene {
  return { id: newId('vsc'), name: patch.name ?? '', start, look, params: {}, layers: [], post: {}, travel: defaultTravel(), cutOn: [], xfade: 0, clips: [], clipOrder: 'cycle', clipStart: 'random', clipSpeed: 1, preset: null, ...patch }
}

export function defaultBrief(): VideoBrief {
  return { goal: '', mood: '', notes: '', words: '', footage: { enabled: false, licences: 'safe', providers: [...FOOTAGE_PROVIDERS], maxClips: 12, maxMegabytes: 600 } }
}

export function createText(text: string, start: TimeRef, end: TimeRef, patch: Partial<Omit<VideoText, 'id'>> = {}): VideoText {
  return {
    id: newId('vtx'),
    start,
    end,
    text,
    style: 'hold',
    font: 'Big Shoulders Display',
    weight: 800,
    size: 160,
    pos: [0.5, 0.5],
    color: [1, 1, 1],
    on: ['beat'],
    blend: 'normal',
    glitch: 0,
    fadeIn: 0,
    fadeOut: 0,
    pulse: 0,
    tracking: 0,
    ...patch,
  }
}

export function createStoryboard(name: string, size: { width: number; height: number; fps: number } = { width: 1920, height: 1080, fps: 30 }): Storyboard {
  return {
    id: newId('vsb'),
    name,
    ...size,
    stage: 'brief',
    brief: defaultBrief(),
    scenes: [],
    text: [],
    fade: DEFAULT_FADE,
    impact: { flash: 1.2, ca: 0.02, shake: 0.02 },
    impacts: [],
    comments: [],
    approvals: [],
    request: null,
    autoAdvance: [],
    footage: [],
    stills: [],
    template: null,
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const list = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : [])

/** Fills fields added since the video data was written, so older and hand-written storyboards load. */
export function normalizeVideo(value: unknown): VideoState | undefined {
  if (!isRecord(value) || !Array.isArray(value.storyboards)) return undefined
  const storyboards = value.storyboards.filter(isRecord).map((raw): Storyboard => {
    const base = createStoryboard(String(raw.name ?? 'Storyboard'))
    const rawBrief = isRecord(raw.brief) ? raw.brief : {}
    const brief: VideoBrief = { ...base.brief, ...rawBrief, footage: { ...base.brief.footage, ...(isRecord(rawBrief.footage) ? rawBrief.footage : {}) } }
    return {
      ...base,
      ...(raw as Partial<Storyboard>),
      brief,
      scenes: list<VideoScene>(raw.scenes).map((scene) => ({ ...createScene(scene.look, scene.start), ...scene })),
      text: list<VideoText>(raw.text).map((item) => ({ ...createText(item.text, item.start, item.end), ...item })),
      impacts: list(raw.impacts),
      comments: list(raw.comments),
      approvals: list(raw.approvals),
      footage: list(raw.footage),
      stills: list(raw.stills),
      autoAdvance: list(raw.autoAdvance),
      request: isRecord(raw.request) ? (raw.request as unknown as StageRequest) : null,
      template: isRecord(raw.template) ? (raw.template as unknown as LibraryRef) : null,
    }
  })
  const activeId = typeof value.activeId === 'string' && storyboards.some((b) => b.id === value.activeId) ? value.activeId : (storyboards[0]?.id ?? null)
  return { storyboards, activeId, files: isRecord(value.files) ? (value.files as Record<string, VideoFile>) : {} }
}

/** Comments still waiting for an answer. */
export const openComments = (board: Storyboard): VideoComment[] => board.comments.filter((c) => c.status === 'open')

/** The stage after `stage`, or null after the final stage. */
export const nextStage = (stage: VideoStage): VideoStage | null => VIDEO_STAGES[VIDEO_STAGES.indexOf(stage) + 1] ?? null

// ---------------------------------------------------------------------------
// Scene presets: a starting look per kind of section, from the recipe that
// made the first videos. Builds dive and strobe into a whiteout, drops cut
// hard to dark heavy looks, and switch sections strobe on the drums.

export type SectionRole = 'intro' | 'build' | 'drop' | 'switch' | 'bridge' | 'outro' | 'other'

export function sectionRole(name: string): SectionRole {
  const n = name.toLowerCase()
  if (/intro|opening/.test(n)) return 'intro'
  if (/build|riser|rise|pre[- ]?(drop|chorus)|lift/.test(n)) return 'build'
  if (/switch|fill|stutter/.test(n)) return 'switch'
  if (/drop|chorus|hook|peak/.test(n)) return 'drop'
  if (/break|bridge|interlude|verse/.test(n)) return 'bridge'
  if (/outro|ending|end/.test(n)) return 'outro'
  return 'other'
}

const WHITEOUT = 'rise > 0 ? 0.85*max(0, 1-toImpact/0.8)**2 : 0'
const DROP_SHAKE = '0.006*kick+0.003*snare'

/** A scene for a section with the given role. `variant` cycles looks across repeated drops. */
export function presetScene(role: SectionRole, start: TimeRef, variant = 0): Omit<VideoScene, 'id' | 'name'> {
  const base = { start, layers: [] as VideoLayer[], cutOn: [] as CutEvent[], xfade: 0, clips: [] as string[], clipOrder: 'cycle' as const, clipStart: 'random' as const, clipSpeed: 1, preset: null }
  switch (role) {
    case 'intro':
      return {
        ...base,
        look: 'julia-drift',
        params: { cAngle: '2.25+t*.012', zoom: '1.6-L*.02', rot: 't*.03', hue: '.55+t*.01' },
        layers: [{ look: 'star-sparkle', amount: 'smooth(0, 4, L)', params: {} }],
        post: { bloom: 0.55, fb: 0.55, fbZoom: 1.004, fbRot: 0.002, vig: 0.9 },
        travel: { base: 0.3, kick: 0, snare: 0, bass: 0 },
      }
    case 'build':
      return {
        ...base,
        look: 'julia-drift',
        params: {
          cAngle: '2.4036-0.1036*smooth(0,.3,x)',
          center: ['0.55518*smooth(0,.4,x)', '0.20664*smooth(0,.4,x)'],
          zoom: '1.344*exp(-(6.2*x*x+1.2*x))*(1-.04*kick)',
          rot: '.384+L*.05+x*x*2.5',
          iters: '130+260*x',
          hue: '.55+L*.02+rise*rise*1.5',
          warp: '.25*(1-x)',
          pump: 1,
        },
        layers: [{ look: 'star-sparkle', amount: '1-x', params: {} }],
        post: { ca: '0.003+0.01*rise*rise', bloom: 0.6, fb: 0.5, fbZoom: 1.012, fbRot: 0.004, fbHue: 0.01, strobe: 'rstrobe', white: WHITEOUT },
        travel: { base: 0.4, kick: 0, snare: 0, bass: 0 },
      }
    case 'drop': {
      const looks = ['vein-tunnel', 'neon-kaleido', 'grid-tunnel', 'acid-vortex']
      const look = looks[variant % looks.length]
      return {
        ...base,
        look,
        params: look === 'neon-kaleido' ? { spin: 't*.15+.3*floor(beat/4)', zoom: '1.25-.12*sub', hue: 'floor(beat/4)*.17+L*.02' } : {},
        layers: [{ look: 'shock-ring', amount: 0.6, params: {} }],
        post: { ca: '0.004+0.006*kick', bloom: 0.5, fb: look === 'vein-tunnel' ? 0.2 : 0.45, fbZoom: 1.02, grain: 0.05, vig: 1.3, shake: DROP_SHAKE },
        travel: { base: 0.55 + 0.15 * variant, kick: 1.8, snare: 1.1, bass: 0.6 },
      }
    }
    case 'switch':
      return { ...base, look: 'strobe-deck', params: { seed: variant }, cutOn: ['kick', 'snare'], post: { ca: 0.006, bloom: 0.4, grain: 0.06 }, travel: { base: 0.4, kick: 0, snare: 0, bass: 0 } }
    case 'bridge':
      return {
        ...base,
        look: 'neon-kaleido',
        params: { folds: 8, spin: 't*.08', zoom: '1.3+.15*sin(t*.4)', cAngle: '2.15+.25*sin(t*.11)', wobble: 0, iters: 64, hue: 't*.06', palD: [0, 0.33, 0.67], kickGain: 0, snareGain: 0, punch: 0 },
        layers: [{ look: 'wave-ring', amount: 0.5, params: { radius: 0.45, amp: 0.22, cycle: 0.1 } }],
        post: { ca: 0.003, bloom: 0.7, fb: 0.82, fbZoom: 1.008, fbRot: 0.006, fbHue: 0.05 },
        travel: { base: 0.2, kick: 0, snare: 0, bass: 0 },
      }
    case 'outro':
      return {
        ...base,
        look: 'julia-drift',
        params: { cAngle: '2.9+L*.01', zoom: '1.5+L*.03', rot: '-t*.03', iters: 110, hue: '.1+L*.01', pump: '1-smooth(0, 6.4, L)' },
        post: { bloom: 0.5, fb: 0.6, fbZoom: 1.005, fbRot: 0.002, fbHue: 0.01, grain: 0.04 },
        travel: { base: 0.3, kick: 0, snare: 0, bass: 0 },
      }
    default:
      return {
        ...base,
        look: 'neon-kaleido',
        params: { spin: 't*.1', hue: 'L*.03' },
        post: { bloom: 0.6, fb: 0.4, fbZoom: 1.01 },
        travel: { base: 0.4, kick: 0.8, snare: 0.5, bass: 0 },
      }
  }
}

/** One scene per section, chosen by section name, or one scene when the song has no sections. */
export function scenesFromSections(project: StudioProject): VideoScene[] {
  const sections = [...project.sections].sort((a, z) => a.start - z.start)
  if (!sections.length) return [{ id: newId('vsc'), name: 'Song', ...presetScene('other', songStart()) }]
  const seen = new Map<SectionRole, number>()
  return sections.map((section) => {
    const role = sectionRole(section.name)
    const variant = seen.get(role) ?? 0
    seen.set(role, variant + 1)
    return { id: newId('vsc'), name: section.name, ...presetScene(role, { sectionId: section.id, at: 'start', bars: 0 }, variant) }
  })
}

// ---------------------------------------------------------------------------
// Time

/** Resolves a time reference to bars, or null when its section no longer exists. */
export function resolveTimeRef(project: Pick<StudioProject, 'sections'>, ref: TimeRef): number | null {
  if (ref.sectionId === null) return ref.bars
  const section = project.sections.find((s) => s.id === ref.sectionId)
  if (!section) return null
  return (ref.at === 'end' ? section.start + section.length : section.start) + ref.bars
}

export function timeRefSeconds(project: Pick<StudioProject, 'sections' | 'tempo' | 'meter'>, ref: TimeRef): number | null {
  const bars = resolveTimeRef(project, ref)
  return bars === null ? null : bars * barSeconds(project)
}

/** Describes a time reference the way the Video view and agents read it, for example "Drop 1 + 8 bars". */
export function formatTimeRef(project: Pick<StudioProject, 'sections'>, ref: TimeRef): string {
  const section = ref.sectionId === null ? null : project.sections.find((s) => s.id === ref.sectionId)
  const anchor = ref.sectionId === null ? 'Song start' : section ? `${section.name}${ref.at === 'end' ? ' end' : ''}` : 'Missing section'
  if (!ref.bars) return anchor
  const bars = Math.abs(ref.bars)
  return `${anchor} ${ref.bars < 0 ? '−' : '+'} ${bars} bar${bars === 1 ? '' : 's'}`
}

/** Reads a time reference from command input: an object, a section ID or name, or a bar number. */
export function parseTimeRef(project: Pick<StudioProject, 'sections'>, input: unknown): TimeRef {
  if (typeof input === 'number' && Number.isFinite(input)) return songStart(input)
  if (typeof input === 'string') {
    const section = project.sections.find((s) => s.id === input) ?? project.sections.find((s) => s.name.toLowerCase() === input.trim().toLowerCase())
    if (!section) throw new StudioError('not_found', `No section "${input}".`)
    return { sectionId: section.id, at: 'start', bars: 0 }
  }
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const raw = input as Record<string, unknown>
    const bars = raw.bars === undefined ? 0 : Number(raw.bars)
    if (!Number.isFinite(bars)) throw new StudioError('invalid', 'A time needs numeric bars.')
    const at = raw.at === 'end' ? 'end' : 'start'
    if (raw.sectionId === undefined || raw.sectionId === null) return songStart(bars)
    const ref = parseTimeRef(project, String(raw.sectionId))
    return { ...ref, at, bars }
  }
  throw new StudioError('invalid', 'A time is a bar number, a section ID or name, or {sectionId, at, bars}.')
}

// ---------------------------------------------------------------------------
// Validation

const LOOK_ID = /^[a-z0-9][a-z0-9-]{0,40}$/

export function checkLookId(look: unknown): string {
  if (typeof look !== 'string' || !LOOK_ID.test(look)) throw new StudioError('invalid', `"${String(look)}" is not a look ID. Look IDs are lowercase words joined by hyphens, like "vein-tunnel".`)
  return look
}

export function checkExprValue(value: unknown, where: string): VideoExpr {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new StudioError('invalid', `${where} must be a finite number.`)
    return value
  }
  if (typeof value === 'string') {
    compileExpr(value)
    return value
  }
  throw new StudioError('invalid', `${where} must be a number or an expression.`)
}

export function checkVideoValue(value: unknown, where: string): VideoValue {
  if (Array.isArray(value)) {
    if (!value.length || value.length > 4) throw new StudioError('invalid', `${where} must have 1 to 4 parts.`)
    return value.map((part, i) => checkExprValue(part, `${where}[${i}]`))
  }
  return checkExprValue(value, where)
}

/** Merges a parameter patch; null removes a parameter so it falls back to the look's default. */
export function mergeVideoParams(current: Record<string, VideoValue>, patch: unknown, where: string): Record<string, VideoValue> {
  if (patch === undefined) return current
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new StudioError('invalid', `${where} must be an object of parameter values.`)
  const next = { ...current }
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (!/^[A-Za-z]\w{0,30}$/.test(key)) throw new StudioError('invalid', `"${key}" is not a parameter name.`)
    if (value === null) delete next[key]
    else next[key] = checkVideoValue(value, `${where}.${key}`)
  }
  return next
}

/** Returns the storyboard, or the active one when no ID is given. */
export function requireStoryboard(project: StudioProject, id?: string): Storyboard {
  const video = project.video
  const target = id ?? video?.activeId ?? video?.storyboards[0]?.id
  const board = video?.storyboards.find((b) => b.id === target || b.name === target)
  if (!board) throw new StudioError('not_found', id ? `No storyboard "${id}".` : 'The project has no storyboard yet. Create one with video.storyboard.create.')
  return board
}

export function updateStoryboard(project: StudioProject, id: string, fn: (board: Storyboard) => Storyboard): StudioProject {
  const video = project.video ?? { storyboards: [], activeId: null, files: {} }
  return { ...project, video: { ...video, storyboards: video.storyboards.map((b) => (b.id === id ? fn(b) : b)) } }
}

/** Finds the storyboard that holds a scene or text item. */
export function storyboardWith(project: StudioProject, itemId: string, kind: 'scene' | 'text'): Storyboard {
  const board = project.video?.storyboards.find((b) => (kind === 'scene' ? b.scenes : b.text).some((item) => item.id === itemId))
  if (!board) throw new StudioError('not_found', `No ${kind === 'scene' ? 'video scene' : 'text item'} "${itemId}".`)
  return board
}

/** Orders scenes by where they start; scenes whose section is missing go last. */
export function sortScenes(project: Pick<StudioProject, 'sections'>, scenes: VideoScene[]): VideoScene[] {
  const at = (scene: VideoScene) => resolveTimeRef(project, scene.start) ?? Infinity
  return [...scenes].sort((a, z) => at(a) - at(z))
}
