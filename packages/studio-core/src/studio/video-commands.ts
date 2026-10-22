import type { CommandSpec, FieldSpec } from './commands'
import { type StudioProject, clamp, newId } from './model'
import { StudioError } from './ops'
import {
  type CommentAuthor,
  type CommentStatus,
  type CommentTarget,
  type CutEvent,
  type FootageClip,
  type FootageProvider,
  type LibraryRef,
  type LicenceKind,
  type PostKey,
  type SectionRole,
  type Storyboard,
  type VideoExpr,
  type VideoFile,
  type VideoLayer,
  type VideoScene,
  type VideoStage,
  type VideoState,
  type VideoText,
  COMMENT_AUTHORS,
  COMMENT_STATUSES,
  CUT_EVENTS,
  FOOTAGE_PROVIDERS,
  LICENCE_KINDS,
  LICENCE_POLICIES,
  POST_DEFAULTS,
  POST_KEYS,
  POST_LABELS,
  TEXT_STYLES,
  VIDEO_FILE_KINDS,
  VIDEO_FONTS,
  VIDEO_SIZES,
  VIDEO_STAGES,
  checkExprValue,
  checkLookId,
  createScene,
  createStoryboard,
  createText,
  formatTimeRef,
  licenceAllowed,
  mergeVideoParams,
  nextStage,
  openComments,
  parseTimeRef,
  presetScene,
  requireStoryboard,
  resolveTimeRef,
  scenesFromSections,
  sectionRole,
  sortScenes,
  storyboardWith,
  timeRefSeconds,
  updateStoryboard,
} from './video'
import { type StoryboardTemplate, checkPreset } from './video-library'
import { VIDEO_FUNCTIONS, VIDEO_VARIABLES } from './video-expr'

// video.* commands: storyboards, scenes, text, comments, stage gates,
// footage, and video files. They share the registry, undo history, and audit
// trail with the music commands but never touch music data.

type P = Record<string, unknown>

const s = (description: string, required = true, extra: Partial<FieldSpec> = {}): FieldSpec => ({ type: 'string', description, required, ...extra })
const n = (description: string, required = false, extra: Partial<FieldSpec> = {}): FieldSpec => ({ type: 'number', description, required, ...extra })
const i = (description: string, required = false, extra: Partial<FieldSpec> = {}): FieldSpec => ({ type: 'integer', description, required, ...extra })
const b = (description: string): FieldSpec => ({ type: 'boolean', description, required: false })
const o = (description: string, required = false): FieldSpec => ({ type: 'object', description, required })
const list = (description: string, items: FieldSpec, required = false): FieldSpec => ({ type: 'array', description, required, items })

const TIME = 'A time {sectionId, at, bars}: sectionId is a section ID or name, or null for the song start; at is "start" (default) or "end" of that section; bars is an offset in bars (fractions are beats, negative counts back).'
const EXPR = 'A number or an expression such as "0.5+0.5*kick" (see video.reference).'
const ROLES: readonly SectionRole[] = ['intro', 'build', 'drop', 'switch', 'bridge', 'outro', 'other']
const BOARD = s('Storyboard ID or name; defaults to the active one.', false)
const AUTHOR = s('Who writes it. Defaults to user.', false, { enum: COMMENT_AUTHORS })

const opt = <T>(p: P, k: string) => p[k] as T | undefined
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const now = () => new Date().toISOString()

function videoOf(project: StudioProject): VideoState {
  return project.video ?? { storyboards: [], activeId: null, files: {} }
}

function boardSize(p: P, fallback: { width: number; height: number; fps: number }) {
  const width = opt<number>(p, 'width') ?? fallback.width
  const height = opt<number>(p, 'height') ?? fallback.height
  // Encoders need even dimensions.
  return { width: Math.round(width / 2) * 2, height: Math.round(height / 2) * 2, fps: opt<number>(p, 'fps') ?? fallback.fps }
}

function checkCutOn(value: unknown, where: string): CutEvent[] {
  if (!Array.isArray(value)) throw new StudioError('invalid', `${where} must be a list of events.`)
  const bad = value.filter((v) => !CUT_EVENTS.includes(v as CutEvent))
  if (bad.length) throw new StudioError('invalid', `${where}: ${bad.join(', ')} ${bad.length === 1 ? 'is not an event' : 'are not events'}. Use ${CUT_EVENTS.join(', ')}.`)
  return [...new Set(value as CutEvent[])]
}

function checkPost(current: Partial<Record<PostKey, VideoExpr>>, patch: unknown): Partial<Record<PostKey, VideoExpr>> {
  if (patch === undefined) return current
  if (!isRecord(patch)) throw new StudioError('invalid', 'post must be an object.')
  const next = { ...current }
  for (const [key, value] of Object.entries(patch)) {
    if (!POST_KEYS.includes(key as PostKey)) throw new StudioError('invalid', `"${key}" is not a post setting. Use ${POST_KEYS.join(', ')}.`)
    if (value === null) delete next[key as PostKey]
    else next[key as PostKey] = checkExprValue(value, `post.${key}`)
  }
  return next
}

function checkLayers(value: unknown): VideoLayer[] {
  if (!Array.isArray(value)) throw new StudioError('invalid', 'layers must be a list.')
  if (value.length > 3) throw new StudioError('invalid', 'A scene has at most 3 layers.')
  return value.map((raw, idx) => {
    const layer = raw as Partial<VideoLayer> | null
    if (!layer || typeof layer !== 'object') throw new StudioError('invalid', `layers[${idx}] must be an object.`)
    return { look: checkLookId(layer.look), amount: layer.amount === undefined ? 1 : checkExprValue(layer.amount, `layers[${idx}].amount`), params: mergeVideoParams({}, layer.params ?? {}, `layers[${idx}].params`) }
  })
}

function checkTravel(current: VideoScene['travel'], patch: unknown): VideoScene['travel'] {
  if (patch === undefined) return current
  if (!isRecord(patch)) throw new StudioError('invalid', 'travel must be an object.')
  const next = { ...current }
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in current)) throw new StudioError('invalid', `"${key}" is not a travel setting. Use base, kick, snare, bass.`)
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new StudioError('invalid', `travel.${key} must be a number.`)
    next[key as keyof typeof next] = clamp(value, -10, 10)
  }
  return next
}

function checkColor(value: unknown, where: string): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3 || value.some((v) => typeof v !== 'number' || !Number.isFinite(v))) throw new StudioError('invalid', `${where} must be [r, g, b] with values 0 to 1.`)
  return value.map((v) => clamp(v as number, 0, 4)) as [number, number, number]
}

function checkPos(value: unknown): [number, number] {
  if (!Array.isArray(value) || value.length !== 2 || value.some((v) => typeof v !== 'number' || !Number.isFinite(v))) throw new StudioError('invalid', 'pos must be [x, y] with values 0 to 1.')
  return value.map((v) => clamp(v as number, -1, 2)) as [number, number]
}

function checkRef(value: unknown): LibraryRef | null {
  if (value === null) return null
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.version !== 'number') throw new StudioError('invalid', 'A library reference is {id, version, name}.')
  return { id: value.id.slice(0, 80), version: Math.max(1, Math.round(value.version)), name: String(value.name ?? '').slice(0, 80) }
}

function checkTarget(project: StudioProject, board: Storyboard, value: unknown): CommentTarget {
  if (value === undefined || value === null) return { kind: 'storyboard' }
  if (!isRecord(value)) throw new StudioError('invalid', 'target must be an object such as {kind: "scene", sceneId}.')
  switch (value.kind) {
    case 'storyboard':
      return { kind: 'storyboard' }
    case 'scene':
      if (!board.scenes.some((sc) => sc.id === value.sceneId)) throw new StudioError('not_found', `No scene "${String(value.sceneId)}" in ${board.name}.`)
      return { kind: 'scene', sceneId: String(value.sceneId) }
    case 'text':
      if (!board.text.some((t) => t.id === value.textId)) throw new StudioError('not_found', `No text item "${String(value.textId)}" in ${board.name}.`)
      return { kind: 'text', textId: String(value.textId) }
    case 'time':
      return { kind: 'time', at: parseTimeRef(project, value.at) }
    case 'still':
      if (!board.stills.includes(String(value.fileId))) throw new StudioError('not_found', `No still "${String(value.fileId)}" in ${board.name}.`)
      return { kind: 'still', fileId: String(value.fileId) }
    default:
      throw new StudioError('invalid', 'target.kind is storyboard, scene, text, time, or still.')
  }
}

function checkFile(value: unknown): VideoFile {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id) throw new StudioError('invalid', 'A video file needs an id.')
  if (!VIDEO_FILE_KINDS.includes(value.kind as VideoFile['kind'])) throw new StudioError('invalid', `A video file kind is ${VIDEO_FILE_KINDS.join(', ')}.`)
  const mimeType = String(value.mimeType ?? '')
  if (!/^(image\/(png|jpeg|webp)|video\/(mp4|webm|quicktime))$/.test(mimeType)) throw new StudioError('invalid', `"${mimeType}" is not a supported still or footage type.`)
  const num = (key: string) => (Number.isFinite(Number(value[key])) ? Number(value[key]) : 0)
  return {
    id: value.id.slice(0, 80),
    kind: value.kind as VideoFile['kind'],
    name: String(value.name ?? value.id).slice(0, 120),
    mimeType,
    bytes: num('bytes'),
    width: num('width'),
    height: num('height'),
    duration: num('duration'),
    seconds: value.seconds === null || value.seconds === undefined ? null : num('seconds'),
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : now(),
  }
}

function checkFootage(board: Storyboard, raw: unknown, author: CommentAuthor): FootageClip {
  if (!isRecord(raw)) throw new StudioError('invalid', 'Each footage clip is an object.')
  const policy = board.brief.footage
  const provider = raw.provider as FootageProvider
  if (!FOOTAGE_PROVIDERS.includes(provider)) throw new StudioError('invalid', `provider is ${FOOTAGE_PROVIDERS.join(', ')}.`)
  if (!policy.providers.includes(provider)) throw new StudioError('invalid', `The brief does not allow footage from ${provider}.`)
  const licence = raw.licence as LicenceKind
  if (!LICENCE_KINDS.includes(licence)) throw new StudioError('invalid', `licence is ${LICENCE_KINDS.join(', ')}.`)
  if (!licenceAllowed(licence, policy.licences)) throw new StudioError('invalid', `"${String(raw.title ?? raw.sourceId)}" is ${String(raw.licenceName ?? licence)}, which the brief's licence policy (${policy.licences}) does not allow.`)
  const url = String(raw.url ?? '')
  if (!/^https:\/\//.test(url)) throw new StudioError('invalid', 'A footage clip needs an https download url.')
  const thumbnail = String(raw.thumbnail ?? '')
  if (thumbnail && (!thumbnail.startsWith('data:image/') || thumbnail.length > 200_000)) throw new StudioError('invalid', 'A thumbnail is a small image data URL.')
  const num = (key: string) => (Number.isFinite(Number(raw[key])) ? Number(raw[key]) : 0)
  return {
    id: newId('vft'),
    provider,
    sourceId: String(raw.sourceId ?? '').slice(0, 200),
    title: String(raw.title ?? '').slice(0, 200),
    page: String(raw.page ?? '').slice(0, 500),
    author: String(raw.author ?? '').slice(0, 200),
    licence,
    licenceName: String(raw.licenceName ?? licence).slice(0, 80),
    licenceUrl: String(raw.licenceUrl ?? '').slice(0, 300),
    query: String(raw.query ?? '').slice(0, 120),
    status: 'candidate',
    proposedBy: author,
    thumbnail,
    url,
    width: num('width'),
    height: num('height'),
    duration: num('duration'),
    fileId: null,
    skip: clamp(num('skip'), 0, 600),
    tags: Array.isArray(raw.tags) ? raw.tags.map(String).slice(0, 12) : [],
  }
}

/** Downloaded clips and megabytes against the brief's limits. */
export function footageBudget(project: StudioProject, board: Storyboard): { clips: number; megabytes: number; maxClips: number; maxMegabytes: number } {
  const files = videoOf(project).files
  const fetched = board.footage.filter((clip) => clip.status === 'fetched' && clip.fileId)
  const megabytes = fetched.reduce((sum, clip) => sum + (files[clip.fileId!]?.bytes ?? 0), 0) / 1e6
  return { clips: fetched.length, megabytes, maxClips: board.brief.footage.maxClips, maxMegabytes: board.brief.footage.maxMegabytes }
}

/** Applies a text patch from command input, validating each field. */
function patchText(project: StudioProject, item: VideoText, p: P): VideoText {
  const next = { ...item }
  if (p.text !== undefined) next.text = String(p.text).slice(0, 400)
  if (p.start !== undefined) next.start = parseTimeRef(project, p.start)
  if (p.end !== undefined) next.end = parseTimeRef(project, p.end)
  if (p.style !== undefined) next.style = p.style as VideoText['style']
  if (p.font !== undefined) next.font = p.font as VideoText['font']
  if (p.weight !== undefined) next.weight = clamp(Math.round(Number(p.weight) / 100) * 100, 100, 900)
  if (p.size !== undefined) next.size = Number(p.size)
  if (p.pos !== undefined) next.pos = checkPos(p.pos)
  if (p.color !== undefined) next.color = checkColor(p.color, 'color')
  if (p.on !== undefined) next.on = checkCutOn(p.on, 'on')
  if (p.blend !== undefined) next.blend = p.blend as VideoText['blend']
  for (const key of ['glitch', 'split', 'fadeIn', 'fadeOut', 'pulse', 'tracking'] as const) if (p[key] !== undefined) next[key] = Number(p[key])
  return next
}

function applyScenePatch(project: StudioProject, board: Storyboard, scene: VideoScene, p: P): VideoScene {
  const next = { ...scene }
  if (p.start !== undefined) next.start = parseTimeRef(project, p.start)
  if (p.name !== undefined) next.name = String(p.name).slice(0, 60)
  if (p.look !== undefined && p.look !== scene.look) {
    next.look = checkLookId(p.look)
    if (p.params === undefined) next.params = {}
  }
  next.params = mergeVideoParams(next.params, p.params, 'params')
  if (p.layers !== undefined) next.layers = checkLayers(p.layers)
  next.post = checkPost(next.post, p.post)
  next.travel = checkTravel(next.travel, p.travel)
  if (p.cutOn !== undefined) next.cutOn = checkCutOn(p.cutOn, 'cutOn')
  if (p.xfade !== undefined) next.xfade = clamp(Number(p.xfade), 0, 30)
  if (p.clips !== undefined) {
    const ids = (p.clips as unknown[]).map(String)
    const unknown = ids.filter((id) => !board.footage.some((clip) => clip.id === id && clip.status !== 'rejected'))
    if (unknown.length) throw new StudioError('not_found', `${unknown.join(', ')} ${unknown.length === 1 ? 'is not a footage clip' : 'are not footage clips'} of ${board.name}.`)
    next.clips = [...new Set(ids)]
  }
  if (p.clipOrder !== undefined) next.clipOrder = p.clipOrder as VideoScene['clipOrder']
  if (p.clipStart !== undefined) next.clipStart = p.clipStart === 'random' || Number(p.clipStart) < 0 ? 'random' : clamp(Number(p.clipStart) || 0, 0, 3600)
  if (p.clipSpeed !== undefined) next.clipSpeed = clamp(Number(p.clipSpeed), 0.1, 4)
  if (p.preset !== undefined) next.preset = checkRef(p.preset)
  return next
}

/** One scene per section from a library template, falling back to the built-in preset for roles it leaves out. */
function scenesFromTemplate(project: StudioProject, board: Storyboard, template: StoryboardTemplate): VideoScene[] {
  const sections = [...project.sections].sort((a, z) => a.start - z.start)
  const seen = new Map<SectionRole, number>()
  const anchors = sections.length ? sections.map((section) => ({ name: section.name, role: sectionRole(section.name), start: { sectionId: section.id, at: 'start' as const, bars: 0 } })) : [{ name: 'Song', role: 'other' as SectionRole, start: { sectionId: null, at: 'start' as const, bars: 0 } }]
  return anchors.map(({ name, role, start }) => {
    const variant = seen.get(role) ?? 0
    seen.set(role, variant + 1)
    const options = template.roles[role]
    const preset = options?.length ? checkPreset(options[variant % options.length], `template.roles.${role}`) : null
    const scene = createScene('', start, preset ?? presetScene(role, start, variant))
    scene.name = name
    return preset ? applyScenePatch(project, board, scene, { ...preset, look: preset.look }) : scene
  })
}

const TEXT_FIELDS: Record<string, FieldSpec> = {
  text: s('The words. Line breaks split lines; for the words style, "|" separates the words shown one at a time.', false),
  end: { type: 'object', description: `${TIME} Defaults to 2 bars after start.`, required: false },
  style: s('hold: static. slam: punches in on the start. words: next word on each event in on. type: typewriter. flicker: flickers with the hats. scroll: ticker.', false, { enum: TEXT_STYLES }),
  font: s('Font family.', false, { enum: VIDEO_FONTS }),
  weight: i('Font weight 100 to 900.', false, { min: 100, max: 900 }),
  size: n('Size in pixels at 1080p.', false, { min: 8, max: 1200 }),
  pos: list('Center [x, y], 0 to 1 across and down.', { type: 'number', description: 'Coordinate.' }),
  color: list('[r, g, b], 0 to 1.', { type: 'number', description: 'Channel.' }),
  on: list('Events that advance the words style.', { type: 'string', description: 'Event.', enum: CUT_EVENTS }),
  blend: s('difference inverts whatever is under the text.', false, { enum: ['normal', 'difference'] }),
  glitch: n('Sideways slicing on snares, 0 to about 0.1.', false, { min: 0, max: 1 }),
  split: n('Strength of the RGB split that follows the kick and the slam: 1 is the default, 0 turns it off.', false, { min: 0, max: 3 }),
  fadeIn: n('Seconds.', false, { min: 0, max: 30 }),
  fadeOut: n('Seconds.', false, { min: 0, max: 30 }),
  pulse: n('Growth on kicks, 0 to about 0.2.', false, { min: 0, max: 1 }),
  tracking: n('Extra letter spacing as a fraction of the size.', false, { min: -0.5, max: 2 }),
}

const SCENE_FIELDS: Record<string, FieldSpec> = {
  look: s('Look ID, for example "vein-tunnel". The Video view lists the looks.', false),
  name: s('Scene name.', false),
  params: o(`Look parameters {name: value}; each value is ${EXPR} or a list for colors and positions. null resets a parameter to the look default.`),
  layers: list('Up to 3 additive layers {look, amount, params}. Replaces the current layers.', { type: 'object', description: 'Layer.' }),
  post: o(`Post settings {${POST_KEYS.join(', ')}}; each is ${EXPR} null resets one.`),
  travel: o('Camera speed through tunnel looks {base, kick, snare, bass}.'),
  cutOn: list('Events that cut to the next graphic in strobe-deck or the next footage clip, for example ["kick", "snare"].', { type: 'string', description: 'Event.', enum: CUT_EVENTS }),
  xfade: n('Seconds of crossfade from the previous scene; 0 is a hard cut.', false, { min: 0, max: 30 }),
  clips: list('Footage clip IDs the footage looks play, in order. Each cut moves to the next clip.', { type: 'string', description: 'Clip ID.' }),
  clipOrder: s('Play clips in order or shuffled.', false, { enum: ['cycle', 'shuffle'] }),
  clipStart: n('Seconds into each clip where it starts; -1 starts each clip at a seeded random point.', false, { min: -1, max: 3600 }),
  clipSpeed: n('Clip playback speed.', false, { min: 0.1, max: 4 }),
  preset: o('The library preset {id, version, name} this scene uses, or null.'),
}

function describeBoard(project: StudioProject, board: Storyboard) {
  const scenes = sortScenes(project, board.scenes)
  const files = videoOf(project).files
  return {
    ...board,
    active: videoOf(project).activeId === board.id,
    scenes: scenes.map((scene) => ({ ...scene, when: formatTimeRef(project, scene.start), startSeconds: timeRefSeconds(project, scene.start), missingSection: resolveTimeRef(project, scene.start) === null })),
    text: board.text.map((item) => ({ ...item, when: `${formatTimeRef(project, item.start)} to ${formatTimeRef(project, item.end)}` })),
    // Thumbnails are large; the footage list carries everything else.
    footage: board.footage.map(({ thumbnail: _thumbnail, ...clip }) => clip),
    stills: board.stills.map((id) => files[id]).filter(Boolean),
    openComments: openComments(board).length,
    footageBudget: footageBudget(project, board),
  }
}

function findComment(project: StudioProject, id: string): Storyboard {
  const board = videoOf(project).storyboards.find((bd) => bd.comments.some((c) => c.id === id))
  if (!board) throw new StudioError('not_found', `No comment "${id}".`)
  return board
}

function findClip(project: StudioProject, id: string): Storyboard {
  const board = videoOf(project).storyboards.find((bd) => bd.footage.some((c) => c.id === id))
  if (!board) throw new StudioError('not_found', `No footage clip "${id}".`)
  return board
}

const withFiles = (project: StudioProject, files: Record<string, VideoFile>): StudioProject => ({ ...project, video: { ...videoOf(project), files } })

function approve(board: Storyboard, override: boolean): Storyboard {
  const next = nextStage(board.stage)
  return { ...board, approvals: [...board.approvals, { stage: board.stage, at: now(), override }], stage: next ?? board.stage, request: null }
}

const VIDEO_COMMANDS: CommandSpec[] = [
  {
    type: 'video.reference',
    summary: 'Look up what storyboards can use: expression variables and functions, post settings with defaults, cut events, text styles, fonts, sizes, stages, licence policies, and the time format.',
    mutates: false,
    params: {},
    run: (project) => ({
      project,
      result: {
        variables: VIDEO_VARIABLES,
        functions: Object.keys(VIDEO_FUNCTIONS),
        expressions: 'Arithmetic with + - * / % **, comparisons, and/or/not, "c ? a : b" or "a if c else b". Example: "0.004+0.006*kick", "0.85*max(0, 1-toImpact/0.8)**2 if rise > 0 else 0".',
        post: POST_KEYS.map((key) => ({ key, label: POST_LABELS[key], default: POST_DEFAULTS[key] })),
        cutEvents: CUT_EVENTS,
        textStyles: TEXT_STYLES,
        fonts: VIDEO_FONTS,
        sizes: VIDEO_SIZES,
        sectionRoles: ROLES,
        stages: VIDEO_STAGES,
        licencePolicies: LICENCE_POLICIES,
        footageProviders: FOOTAGE_PROVIDERS,
        time: TIME,
      },
    }),
  },
  {
    type: 'video.get',
    summary: 'Read a storyboard (the active one by default) with each scene’s time, its comments, stage, footage, and stills, plus the list of storyboards.',
    mutates: false,
    params: { storyboardId: BOARD },
    run: (project, p) => {
      const video = videoOf(project)
      return {
        project,
        result: {
          storyboards: video.storyboards.map((bd) => ({ id: bd.id, name: bd.name, width: bd.width, height: bd.height, fps: bd.fps, stage: bd.stage, active: bd.id === video.activeId })),
          storyboard: video.storyboards.length ? describeBoard(project, requireStoryboard(project, opt(p, 'storyboardId'))) : null,
        },
      }
    },
  },
  {
    type: 'video.storyboard.create',
    summary: 'Create a storyboard and make it active. It starts with one scene per section, chosen by section name (intro, build, drop, switch, bridge, outro), or from a library template.',
    mutates: true,
    params: {
      name: s('Storyboard name.', false),
      width: i('Frame width in pixels.', false, { min: 256, max: 3840 }),
      height: i('Frame height in pixels.', false, { min: 256, max: 3840 }),
      fps: i('Frames per second.', false, { min: 12, max: 60 }),
      empty: b('Start with no scenes.'),
      template: o('A library template {id, version, name, template} to start from.'),
    },
    run: (project, p) => {
      const video = videoOf(project)
      let board = createStoryboard(opt<string>(p, 'name')?.slice(0, 60) || (video.storyboards.length ? `Storyboard ${video.storyboards.length + 1}` : 'Main'), boardSize(p, { width: 1920, height: 1080, fps: 30 }))
      const template = opt<Record<string, unknown>>(p, 'template')
      if (template) {
        if (!isRecord(template.template) || !isRecord(template.template.roles)) throw new StudioError('invalid', 'template needs {id, version, name, template: {roles, text, fade, impact}}.')
        const body = template.template as unknown as StoryboardTemplate
        board = { ...board, template: checkRef(template), scenes: scenesFromTemplate(project, board, body) }
        if (body.fade !== undefined) board.fade = checkExprValue(body.fade, 'template.fade')
        if (isRecord(body.impact)) board.impact = { flash: clamp(Number(body.impact.flash ?? 1.2), 0, 4), ca: clamp(Number(body.impact.ca ?? 0.02), 0, 0.2), shake: clamp(Number(body.impact.shake ?? 0.02), 0, 0.2) }
        const firstOf = (role: SectionRole) => [...project.sections].sort((a, z) => a.start - z.start).find((sec) => sectionRole(sec.name) === role)
        board.text = (Array.isArray(body.text) ? body.text : []).flatMap((item) => {
          const section = firstOf(item.role)
          if (!section) return []
          const { role: _role, offset, length, ...style } = item
          const start = { sectionId: section.id, at: 'start' as const, bars: Number(offset) || 0 }
          return [patchText(project, createText('', start, { ...start, bars: start.bars + (Number(length) || 2) }), style as P)]
        })
      } else board.scenes = p.empty ? [] : scenesFromSections(project)
      return { project: { ...project, video: { ...video, storyboards: [...video.storyboards, board], activeId: board.id } }, result: { storyboardId: board.id } }
    },
  },
  {
    type: 'video.storyboard.update',
    summary: 'Rename a storyboard or change its size, frame rate, brief (goal, mood, notes, words, footage policy), master fade, impact settings, or the stages the Director may approve itself.',
    mutates: true,
    params: {
      storyboardId: BOARD,
      name: s('Name.', false),
      width: i('Frame width.', false, { min: 256, max: 3840 }),
      height: i('Frame height.', false, { min: 256, max: 3840 }),
      fps: i('Frames per second.', false, { min: 12, max: 60 }),
      brief: o('{goal, mood, notes, words, footage: {enabled, licences, providers, maxClips, maxMegabytes}}; given fields replace the current ones.'),
      fade: { type: 'string', description: `Master brightness. ${EXPR}`, required: false },
      impact: o('{flash, ca, shake} fired by each impact.'),
      impacts: list(`Extra impacts. Each is ${TIME}`, { type: 'object', description: 'Time.' }),
      autoAdvance: list('Stages the Director may approve without waiting for you, when no comments are open.', { type: 'string', description: 'Stage.', enum: VIDEO_STAGES }),
    },
    run: (project, p) => {
      const board = requireStoryboard(project, opt(p, 'storyboardId'))
      const brief = opt<Record<string, unknown>>(p, 'brief')
      const impact = opt<Record<string, unknown>>(p, 'impact')
      const fade = p.fade === undefined ? undefined : checkExprValue(typeof p.fade === 'string' && /^-?[\d.]+$/.test(p.fade.trim()) ? Number(p.fade) : p.fade, 'fade')
      let nextBrief = board.brief
      if (brief) {
        const text = (key: 'goal' | 'mood' | 'notes' | 'words', max: number) => String(brief[key] ?? board.brief[key]).slice(0, max)
        const footage = isRecord(brief.footage) ? brief.footage : {}
        const policy = { ...board.brief.footage }
        if (footage.enabled !== undefined) policy.enabled = Boolean(footage.enabled)
        if (footage.licences !== undefined) {
          if (!LICENCE_POLICIES.includes(footage.licences as never)) throw new StudioError('invalid', `brief.footage.licences is ${LICENCE_POLICIES.join(', ')}.`)
          policy.licences = footage.licences as typeof policy.licences
        }
        if (footage.providers !== undefined) {
          const providers = Array.isArray(footage.providers) ? footage.providers.map(String) : []
          if (providers.some((x) => !FOOTAGE_PROVIDERS.includes(x as FootageProvider))) throw new StudioError('invalid', `brief.footage.providers come from ${FOOTAGE_PROVIDERS.join(', ')}.`)
          policy.providers = providers as FootageProvider[]
        }
        if (footage.maxClips !== undefined) policy.maxClips = clamp(Math.round(Number(footage.maxClips) || 0), 0, 200)
        if (footage.maxMegabytes !== undefined) policy.maxMegabytes = clamp(Math.round(Number(footage.maxMegabytes) || 0), 0, 20000)
        nextBrief = { goal: text('goal', 2000), mood: text('mood', 2000), notes: text('notes', 4000), words: text('words', 2000), footage: policy }
      }
      return {
        project: updateStoryboard(project, board.id, (bd) => ({
          ...bd,
          ...(p.name !== undefined && { name: String(p.name).slice(0, 60) || bd.name }),
          ...boardSize(p, bd),
          brief: nextBrief,
          ...(fade !== undefined && { fade }),
          ...(impact && { impact: { flash: clamp(Number(impact.flash ?? bd.impact.flash), 0, 4), ca: clamp(Number(impact.ca ?? bd.impact.ca), 0, 0.2), shake: clamp(Number(impact.shake ?? bd.impact.shake), 0, 0.2) } }),
          ...(p.impacts !== undefined && { impacts: (p.impacts as unknown[]).map((ref) => parseTimeRef(project, ref)) }),
          ...(p.autoAdvance !== undefined && { autoAdvance: [...new Set(p.autoAdvance as VideoStage[])] }),
        })),
      }
    },
  },
  {
    type: 'video.storyboard.activate',
    summary: 'Make a storyboard the one the Video view shows and exports.',
    mutates: true,
    params: { storyboardId: s('Storyboard ID or name.') },
    run: (project, p) => {
      const board = requireStoryboard(project, String(p.storyboardId))
      return { project: { ...project, video: { ...videoOf(project), activeId: board.id } } }
    },
  },
  {
    type: 'video.storyboard.duplicate',
    summary: 'Copy a storyboard, optionally at a new size such as 1080x1920 for a vertical cut. The copy keeps scenes, text, footage, and stills, starts with no comments, and becomes active.',
    mutates: true,
    params: { storyboardId: BOARD, name: s('Name for the copy.', false), width: i('Frame width.', false, { min: 256, max: 3840 }), height: i('Frame height.', false, { min: 256, max: 3840 }) },
    run: (project, p) => {
      const source = requireStoryboard(project, opt(p, 'storyboardId'))
      const copy: Storyboard = {
        ...structuredClone(source),
        id: newId('vsb'),
        name: opt<string>(p, 'name')?.slice(0, 60) || `${source.name} copy`,
        ...boardSize(p, source),
        comments: [],
        request: null,
      }
      // Clip IDs stay the same so scenes keep pointing at their footage.
      copy.scenes = copy.scenes.map((scene) => ({ ...scene, id: newId('vsc') }))
      copy.text = copy.text.map((item) => ({ ...item, id: newId('vtx') }))
      const video = videoOf(project)
      return { project: { ...project, video: { ...video, storyboards: [...video.storyboards, copy], activeId: copy.id } }, result: { storyboardId: copy.id } }
    },
  },
  {
    type: 'video.storyboard.remove',
    summary: 'Remove a storyboard. Files it used stay in the project until removed.',
    mutates: true,
    params: { storyboardId: s('Storyboard ID or name.') },
    run: (project, p) => {
      const board = requireStoryboard(project, String(p.storyboardId))
      const video = videoOf(project)
      const storyboards = video.storyboards.filter((bd) => bd.id !== board.id)
      return { project: { ...project, video: { ...video, storyboards, activeId: video.activeId === board.id ? (storyboards[0]?.id ?? null) : video.activeId } } }
    },
  },
  {
    type: 'video.scene.add',
    summary: 'Add a scene that plays from its start until the next scene. Without a look, a preset is chosen from the section’s name or the preset role.',
    mutates: true,
    params: {
      storyboardId: BOARD,
      start: { type: 'object', description: TIME, required: true },
      role: s('Section role to take the starting look from.', false, { enum: ROLES }),
      ...SCENE_FIELDS,
    },
    run: (project, p) => {
      const board = requireStoryboard(project, opt(p, 'storyboardId'))
      const start = parseTimeRef(project, p.start)
      const section = start.sectionId ? project.sections.find((sec) => sec.id === start.sectionId) : null
      const role = opt<SectionRole>(p, 'role') ?? (section ? sectionRole(section.name) : 'other')
      const variant = board.scenes.filter((sc) => sc.look === presetScene(role, start).look).length
      const scene = p.look === undefined ? createScene('', start, presetScene(role, start, variant)) : createScene(checkLookId(p.look), start)
      scene.name = opt<string>(p, 'name')?.slice(0, 60) ?? section?.name ?? ''
      const filled = applyScenePatch(project, board, scene, { ...p, look: undefined, start: undefined })
      return { project: updateStoryboard(project, board.id, (bd) => ({ ...bd, scenes: sortScenes(project, [...bd.scenes, filled]) })), result: { sceneId: filled.id } }
    },
  },
  {
    type: 'video.scene.update',
    summary: 'Change a scene. params and post merge into the current values (null resets one); layers and clips replace the current ones. Changing the look resets params unless params are given.',
    mutates: true,
    params: { sceneId: s('Scene ID.'), start: { type: 'object', description: TIME, required: false }, ...SCENE_FIELDS },
    run: (project, p) => {
      const id = String(p.sceneId)
      const board = storyboardWith(project, id, 'scene')
      return { project: updateStoryboard(project, board.id, (bd) => ({ ...bd, scenes: sortScenes(project, bd.scenes.map((scene) => (scene.id === id ? applyScenePatch(project, bd, scene, p) : scene))) })) }
    },
  },
  {
    type: 'video.scene.remove',
    summary: 'Remove a scene; the previous scene plays on in its place.',
    mutates: true,
    params: { sceneId: s('Scene ID.') },
    run: (project, p) => {
      const id = String(p.sceneId)
      const board = storyboardWith(project, id, 'scene')
      return { project: updateStoryboard(project, board.id, (bd) => ({ ...bd, scenes: bd.scenes.filter((scene) => scene.id !== id) })) }
    },
  },
  {
    type: 'video.text.add',
    summary: 'Add a text item, for example a title slam on a drop or words on the snares.',
    mutates: true,
    params: { storyboardId: BOARD, start: { type: 'object', description: TIME, required: true }, ...TEXT_FIELDS, text: s('The words. Line breaks split lines; for the words style, "|" separates the words.') },
    run: (project, p) => {
      const board = requireStoryboard(project, opt(p, 'storyboardId'))
      const start = parseTimeRef(project, p.start)
      const end = p.end === undefined ? { ...start, bars: start.bars + 2 } : parseTimeRef(project, p.end)
      const item = patchText(project, createText('', start, end), { ...p, start: undefined, end: undefined })
      return { project: updateStoryboard(project, board.id, (bd) => ({ ...bd, text: [...bd.text, item] })), result: { textId: item.id } }
    },
  },
  {
    type: 'video.text.update',
    summary: 'Change a text item.',
    mutates: true,
    params: { textId: s('Text item ID.'), start: { type: 'object', description: TIME, required: false }, ...TEXT_FIELDS },
    run: (project, p) => {
      const id = String(p.textId)
      const board = storyboardWith(project, id, 'text')
      return { project: updateStoryboard(project, board.id, (bd) => ({ ...bd, text: bd.text.map((item) => (item.id === id ? patchText(project, item, p) : item)) })) }
    },
  },
  {
    type: 'video.text.remove',
    summary: 'Remove a text item.',
    mutates: true,
    params: { textId: s('Text item ID.') },
    run: (project, p) => {
      const id = String(p.textId)
      const board = storyboardWith(project, id, 'text')
      return { project: updateStoryboard(project, board.id, (bd) => ({ ...bd, text: bd.text.filter((item) => item.id !== id) })) }
    },
  },

  // Comments and requests -----------------------------------------------------
  {
    type: 'video.comment.add',
    summary: 'Leave a comment or request on a storyboard, a scene, a text item, a moment, or a still. Open comments block stage approval until they are answered.',
    mutates: true,
    params: {
      storyboardId: BOARD,
      text: s('The comment.'),
      target: o(`What it is about: {kind: "storyboard"}, {kind: "scene", sceneId}, {kind: "text", textId}, {kind: "time", at: ${TIME}}, or {kind: "still", fileId}. Defaults to the storyboard.`),
      author: AUTHOR,
    },
    run: (project, p) => {
      const board = requireStoryboard(project, opt(p, 'storyboardId'))
      const comment = { id: newId('vcm'), author: (opt<CommentAuthor>(p, 'author') ?? 'user'), target: checkTarget(project, board, p.target), text: String(p.text).slice(0, 4000), status: 'open' as CommentStatus, replies: [], createdAt: now() }
      if (!comment.text.trim()) throw new StudioError('invalid', 'A comment needs text.')
      return { project: updateStoryboard(project, board.id, (bd) => ({ ...bd, comments: [...bd.comments, comment] })), result: { commentId: comment.id } }
    },
  },
  {
    type: 'video.comment.reply',
    summary: 'Reply to a comment, and optionally mark it addressed or won’t fix.',
    mutates: true,
    params: { commentId: s('Comment ID.'), text: s('The reply: what changed, or a question.'), status: s('New status.', false, { enum: COMMENT_STATUSES }), author: AUTHOR },
    run: (project, p) => {
      const id = String(p.commentId)
      const board = findComment(project, id)
      const reply = { author: opt<CommentAuthor>(p, 'author') ?? 'user', text: String(p.text).slice(0, 4000), at: now() }
      return { project: updateStoryboard(project, board.id, (bd) => ({ ...bd, comments: bd.comments.map((c) => (c.id === id ? { ...c, replies: [...c.replies, reply], status: opt<CommentStatus>(p, 'status') ?? c.status } : c)) })) }
    },
  },
  {
    type: 'video.comment.resolve',
    summary: 'Set a comment’s status: open, addressed, or wontfix.',
    mutates: true,
    params: { commentId: s('Comment ID.'), status: s('New status.', true, { enum: COMMENT_STATUSES }) },
    run: (project, p) => {
      const id = String(p.commentId)
      const board = findComment(project, id)
      return { project: updateStoryboard(project, board.id, (bd) => ({ ...bd, comments: bd.comments.map((c) => (c.id === id ? { ...c, status: p.status as CommentStatus } : c)) })) }
    },
  },
  {
    type: 'video.comment.remove',
    summary: 'Delete a comment and its replies.',
    mutates: true,
    userOnly: true,
    params: { commentId: s('Comment ID.') },
    run: (project, p) => {
      const id = String(p.commentId)
      const board = findComment(project, id)
      return { project: updateStoryboard(project, board.id, (bd) => ({ ...bd, comments: bd.comments.filter((c) => c.id !== id) })) }
    },
  },

  // Stages ----------------------------------------------------------------------
  {
    type: 'video.stage.request',
    summary: 'Ask the user to approve the current stage, with a summary and the stills to look at. Stages listed in autoAdvance are approved at once when no comments are open.',
    mutates: true,
    params: { storyboardId: BOARD, summary: s('What was done in this stage and what to look at.'), fileIds: list('Stills or overview sheets to review.', { type: 'string', description: 'File ID.' }) },
    run: (project, p) => {
      const board = requireStoryboard(project, opt(p, 'storyboardId'))
      const fileIds = ((p.fileIds as unknown[]) ?? []).map(String).filter((id) => board.stills.includes(id))
      const auto = board.autoAdvance.includes(board.stage) && !openComments(board).length
      const request = { stage: board.stage, summary: String(p.summary).slice(0, 4000), fileIds, at: now() }
      return {
        project: updateStoryboard(project, board.id, (bd) => (auto ? approve({ ...bd, request }, false) : { ...bd, request })),
        result: { approved: auto, stage: auto ? (nextStage(board.stage) ?? board.stage) : board.stage },
      }
    },
  },
  {
    type: 'video.stage.approve',
    summary: 'Approve the current stage and move to the next. Fails while comments are open unless override is true.',
    mutates: true,
    userOnly: true,
    params: { storyboardId: BOARD, override: b('Approve even with open comments.') },
    run: (project, p) => {
      const board = requireStoryboard(project, opt(p, 'storyboardId'))
      const open = openComments(board).length
      if (open && !p.override) throw new StudioError('invalid', `${open} comment${open === 1 ? ' is' : 's are'} still open. Answer ${open === 1 ? 'it' : 'them'} first, or approve anyway.`)
      return { project: updateStoryboard(project, board.id, (bd) => approve(bd, open > 0)), result: { stage: nextStage(board.stage) ?? board.stage } }
    },
  },
  {
    type: 'video.stage.reopen',
    summary: 'Go back to an earlier stage, for example to Look-dev to rework stills after seeing the draft.',
    mutates: true,
    userOnly: true,
    params: { storyboardId: BOARD, stage: s('Stage to go back to.', true, { enum: VIDEO_STAGES }) },
    run: (project, p) => {
      const board = requireStoryboard(project, opt(p, 'storyboardId'))
      const stage = p.stage as VideoStage
      if (VIDEO_STAGES.indexOf(stage) > VIDEO_STAGES.indexOf(board.stage)) throw new StudioError('invalid', `${stage} comes after the current stage, ${board.stage}. Approve stages to move forward.`)
      return { project: updateStoryboard(project, board.id, (bd) => ({ ...bd, stage, request: null })) }
    },
  },

  // Footage -----------------------------------------------------------------------
  {
    type: 'video.footage.add',
    summary: 'Add footage candidates from a search for the user to review. The brief must allow footage, the provider, and each clip’s licence. Nothing downloads until the user approves a clip.',
    mutates: true,
    params: {
      storyboardId: BOARD,
      clips: list('Candidates {provider, sourceId, title, page, author, licence, licenceName, licenceUrl, query, thumbnail, url, width, height, duration, skip, tags}.', { type: 'object', description: 'Clip.' }, true),
      author: AUTHOR,
    },
    run: (project, p) => {
      const board = requireStoryboard(project, opt(p, 'storyboardId'))
      if (!board.brief.footage.enabled) throw new StudioError('invalid', 'The brief has footage turned off. Turn it on in the storyboard brief first.')
      const author = opt<CommentAuthor>(p, 'author') ?? 'user'
      const known = new Set(board.footage.map((clip) => `${clip.provider}:${clip.sourceId}`))
      const clips = (p.clips as unknown[])
        .map((raw) => checkFootage(board, raw, author))
        .filter((clip) => {
          const key = `${clip.provider}:${clip.sourceId}`
          if (known.has(key)) return false
          known.add(key)
          return true
        })
      return { project: updateStoryboard(project, board.id, (bd) => ({ ...bd, footage: [...bd.footage, ...clips] })), result: { clipIds: clips.map((clip) => clip.id) } }
    },
  },
  {
    type: 'video.footage.review',
    summary: 'Approve or reject a footage candidate. Approved clips can be downloaded; rejected ones are dropped from scenes.',
    mutates: true,
    userOnly: true,
    params: { clipId: s('Footage clip ID.'), status: s('Decision.', true, { enum: ['approved', 'rejected'] }) },
    run: (project, p) => {
      const id = String(p.clipId)
      const board = findClip(project, id)
      const status = p.status as 'approved' | 'rejected'
      return {
        project: updateStoryboard(project, board.id, (bd) => ({
          ...bd,
          footage: bd.footage.map((clip) => (clip.id === id ? { ...clip, status: status === 'approved' && clip.fileId ? 'fetched' : status } : clip)),
          scenes: status === 'rejected' ? bd.scenes.map((scene) => ({ ...scene, clips: scene.clips.filter((c) => c !== id) })) : bd.scenes,
        })),
      }
    },
  },
  {
    type: 'video.footage.update',
    summary: 'Change a footage clip’s lead-in to skip, its tags, or its title.',
    mutates: true,
    params: { clipId: s('Footage clip ID.'), skip: n('Seconds to skip at the start, for title cards.', false, { min: 0, max: 600 }), tags: list('Tags.', { type: 'string', description: 'Tag.' }), title: s('Title.', false) },
    run: (project, p) => {
      const id = String(p.clipId)
      const board = findClip(project, id)
      return {
        project: updateStoryboard(project, board.id, (bd) => ({
          ...bd,
          footage: bd.footage.map((clip) =>
            clip.id === id ? { ...clip, ...(p.skip !== undefined && { skip: Number(p.skip) }), ...(p.tags !== undefined && { tags: (p.tags as unknown[]).map(String).slice(0, 12) }), ...(p.title !== undefined && { title: String(p.title).slice(0, 200) }) } : clip,
          ),
        })),
      }
    },
  },
  {
    type: 'video.footage.fetched',
    summary: 'Register the downloaded file of an approved footage clip. Hosts call this after storing the file.',
    mutates: true,
    params: { clipId: s('Footage clip ID.'), file: o('The stored video file record.', true) },
    run: (project, p) => {
      const id = String(p.clipId)
      const board = findClip(project, id)
      const clip = board.footage.find((c) => c.id === id)!
      if (clip.status !== 'approved' && clip.status !== 'fetched') throw new StudioError('invalid', `"${clip.title}" has not been approved, so it cannot be downloaded.`)
      const file = { ...checkFile(p.file), kind: 'footage' as const }
      const next = withFiles(project, { ...videoOf(project).files, [file.id]: file })
      return { project: updateStoryboard(next, board.id, (bd) => ({ ...bd, footage: bd.footage.map((c) => (c.id === id ? { ...c, status: 'fetched', fileId: file.id, duration: file.duration || c.duration } : c)) })), result: { fileId: file.id } }
    },
  },
  {
    type: 'video.footage.remove',
    summary: 'Remove a footage clip from the storyboard and its scenes. A downloaded file stays in the project until removed with video.file.remove.',
    mutates: true,
    params: { clipId: s('Footage clip ID.') },
    run: (project, p) => {
      const id = String(p.clipId)
      const board = findClip(project, id)
      return { project: updateStoryboard(project, board.id, (bd) => ({ ...bd, footage: bd.footage.filter((c) => c.id !== id), scenes: bd.scenes.map((scene) => ({ ...scene, clips: scene.clips.filter((c) => c !== id) })) })) }
    },
  },

  // Files -------------------------------------------------------------------------
  {
    type: 'video.file.add',
    summary: 'Register a still or overview sheet the host has stored, and add it to the storyboard’s stills.',
    mutates: true,
    params: { storyboardId: BOARD, file: o('The stored file record {id, kind, name, mimeType, bytes, width, height, seconds}.', true) },
    run: (project, p) => {
      const board = requireStoryboard(project, opt(p, 'storyboardId'))
      const file = checkFile(p.file)
      if (file.kind === 'footage') throw new StudioError('invalid', 'Footage files are registered with video.footage.fetched.')
      const next = withFiles(project, { ...videoOf(project).files, [file.id]: file })
      return { project: updateStoryboard(next, board.id, (bd) => ({ ...bd, stills: [...bd.stills.filter((id) => id !== file.id), file.id].slice(-200) })), result: { fileId: file.id } }
    },
  },
  {
    type: 'video.file.remove',
    summary: 'Remove a still, overview sheet, or downloaded footage file from the project. Clips that used it go back to approved.',
    mutates: true,
    params: { fileId: s('File ID.') },
    run: (project, p) => {
      const id = String(p.fileId)
      const video = videoOf(project)
      if (!video.files[id]) throw new StudioError('not_found', `No video file "${id}".`)
      const files = { ...video.files }
      delete files[id]
      return {
        project: {
          ...project,
          video: {
            ...video,
            files,
            storyboards: video.storyboards.map((bd) => ({
              ...bd,
              stills: bd.stills.filter((x) => x !== id),
              footage: bd.footage.map((clip) => (clip.fileId === id ? { ...clip, fileId: null, status: 'approved' as const } : clip)),
              request: bd.request ? { ...bd.request, fileIds: bd.request.fileIds.filter((x) => x !== id) } : null,
            })),
          },
        },
      }
    },
  },
]

export const VIDEO_SPECS: CommandSpec[] = VIDEO_COMMANDS.map((spec) => ({ ...spec, domain: 'video' }))
