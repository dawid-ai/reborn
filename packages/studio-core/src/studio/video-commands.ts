import type { CommandSpec, FieldSpec } from './commands'
import { type StudioProject, clamp, newId } from './model'
import { StudioError } from './ops'
import {
  type CutEvent,
  type PostKey,
  type Storyboard,
  type VideoExpr,
  type VideoLayer,
  type VideoScene,
  type VideoState,
  type VideoText,
  CUT_EVENTS,
  POST_DEFAULTS,
  POST_KEYS,
  POST_LABELS,
  TEXT_STYLES,
  VIDEO_FONTS,
  VIDEO_SIZES,
  VIDEO_STAGES,
  checkExprValue,
  checkLookId,
  createScene,
  createStoryboard,
  createText,
  formatTimeRef,
  mergeVideoParams,
  parseTimeRef,
  presetScene,
  requireStoryboard,
  resolveTimeRef,
  scenesFromSections,
  sectionRole,
  sortScenes,
  storyboardWith,
  updateStoryboard,
  timeRefSeconds,
  type SectionRole,
} from './video'
import { VIDEO_FUNCTIONS, VIDEO_VARIABLES } from './video-expr'

// video.* commands: storyboards, scenes, and text for the music video. They
// share the registry, undo history, and audit trail with the music commands
// but never touch music data.

type P = Record<string, unknown>

const s = (description: string, required = true, extra: Partial<FieldSpec> = {}): FieldSpec => ({ type: 'string', description, required, ...extra })
const n = (description: string, required = false, extra: Partial<FieldSpec> = {}): FieldSpec => ({ type: 'number', description, required, ...extra })
const i = (description: string, required = false, extra: Partial<FieldSpec> = {}): FieldSpec => ({ type: 'integer', description, required, ...extra })
const o = (description: string, required = false): FieldSpec => ({ type: 'object', description, required })
const list = (description: string, items: FieldSpec, required = false): FieldSpec => ({ type: 'array', description, required, items })

const TIME = 'A time {sectionId, at, bars}: sectionId is a section ID or name, or null for the song start; at is "start" (default) or "end" of that section; bars is an offset in bars (fractions are beats, negative counts back).'
const EXPR = 'A number or an expression such as "0.5+0.5*kick" (see video.reference).'
const ROLES: readonly SectionRole[] = ['intro', 'build', 'drop', 'switch', 'bridge', 'outro', 'other']

const opt = <T>(p: P, k: string) => p[k] as T | undefined

function videoOf(project: StudioProject): VideoState {
  return project.video ?? { storyboards: [], activeId: null }
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
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new StudioError('invalid', 'post must be an object.')
  const next = { ...current }
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
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
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new StudioError('invalid', 'travel must be an object.')
  const next = { ...current }
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
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
  for (const key of ['glitch', 'fadeIn', 'fadeOut', 'pulse', 'tracking'] as const) if (p[key] !== undefined) next[key] = Number(p[key])
  return next
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
  cutOn: list('Events that cut to the next graphic in strobe-deck, for example ["kick", "snare"].', { type: 'string', description: 'Event.', enum: CUT_EVENTS }),
  xfade: n('Seconds of crossfade from the previous scene; 0 is a hard cut.', false, { min: 0, max: 30 }),
}

function describeBoard(project: StudioProject, board: Storyboard) {
  const scenes = sortScenes(project, board.scenes)
  return {
    ...board,
    active: videoOf(project).activeId === board.id,
    scenes: scenes.map((scene) => ({ ...scene, when: formatTimeRef(project, scene.start), startSeconds: timeRefSeconds(project, scene.start), missingSection: resolveTimeRef(project, scene.start) === null })),
    text: board.text.map((item) => ({ ...item, when: `${formatTimeRef(project, item.start)} to ${formatTimeRef(project, item.end)}` })),
  }
}

export const VIDEO_SPECS: CommandSpec[] = [
  {
    type: 'video.reference',
    summary: 'Look up what storyboards can use: expression variables and functions, post settings with defaults, cut events, text styles, fonts, sizes, and the time format.',
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
        time: TIME,
      },
    }),
  },
  {
    type: 'video.get',
    summary: 'Read a storyboard (the active one by default) with each scene’s time, plus the list of storyboards.',
    mutates: false,
    params: { storyboardId: s('Storyboard ID or name.', false) },
    run: (project, p) => {
      const video = videoOf(project)
      return {
        project,
        result: {
          storyboards: video.storyboards.map((b) => ({ id: b.id, name: b.name, width: b.width, height: b.height, fps: b.fps, active: b.id === video.activeId })),
          storyboard: video.storyboards.length ? describeBoard(project, requireStoryboard(project, opt(p, 'storyboardId'))) : null,
        },
      }
    },
  },
  {
    type: 'video.storyboard.create',
    summary: 'Create a storyboard and make it active. By default it starts with one scene per section, chosen by section name (intro, build, drop, switch, bridge, outro).',
    mutates: true,
    params: {
      name: s('Storyboard name.', false),
      width: i('Frame width in pixels.', false, { min: 256, max: 3840 }),
      height: i('Frame height in pixels.', false, { min: 256, max: 3840 }),
      fps: i('Frames per second.', false, { min: 12, max: 60 }),
      empty: { type: 'boolean', description: 'Start with no scenes.', required: false },
    },
    run: (project, p) => {
      const video = videoOf(project)
      const board = createStoryboard(opt<string>(p, 'name')?.slice(0, 60) || (video.storyboards.length ? `Storyboard ${video.storyboards.length + 1}` : 'Main'), boardSize(p, { width: 1920, height: 1080, fps: 30 }))
      board.scenes = p.empty ? [] : scenesFromSections(project)
      return { project: { ...project, video: { storyboards: [...video.storyboards, board], activeId: board.id } }, result: { storyboardId: board.id } }
    },
  },
  {
    type: 'video.storyboard.update',
    summary: 'Rename a storyboard or change its size, frame rate, stage, brief, master fade, or impact settings.',
    mutates: true,
    params: {
      storyboardId: s('Storyboard ID or name; defaults to the active one.', false),
      name: s('Name.', false),
      width: i('Frame width.', false, { min: 256, max: 3840 }),
      height: i('Frame height.', false, { min: 256, max: 3840 }),
      fps: i('Frames per second.', false, { min: 12, max: 60 }),
      stage: s('Production stage.', false, { enum: VIDEO_STAGES }),
      brief: o('{goal, mood, notes}.'),
      fade: { type: 'string', description: `Master brightness. ${EXPR}`, required: false },
      impact: o('{flash, ca, shake} fired by each impact.'),
      impacts: list(`Extra impacts. Each is ${TIME}`, { type: 'object', description: 'Time.' }),
    },
    run: (project, p) => {
      const board = requireStoryboard(project, opt(p, 'storyboardId'))
      const brief = opt<Record<string, unknown>>(p, 'brief')
      const impact = opt<Record<string, unknown>>(p, 'impact')
      const fade = p.fade === undefined ? undefined : checkExprValue(typeof p.fade === 'string' && /^-?[\d.]+$/.test(p.fade.trim()) ? Number(p.fade) : p.fade, 'fade')
      return {
        project: updateStoryboard(project, board.id, (b) => ({
          ...b,
          ...(p.name !== undefined && { name: String(p.name).slice(0, 60) || b.name }),
          ...boardSize(p, b),
          ...(p.stage !== undefined && { stage: p.stage as Storyboard['stage'] }),
          ...(brief && { brief: { goal: String(brief.goal ?? b.brief.goal).slice(0, 2000), mood: String(brief.mood ?? b.brief.mood).slice(0, 2000), notes: String(brief.notes ?? b.brief.notes).slice(0, 4000) } }),
          ...(fade !== undefined && { fade }),
          ...(impact && { impact: { flash: clamp(Number(impact.flash ?? b.impact.flash), 0, 4), ca: clamp(Number(impact.ca ?? b.impact.ca), 0, 0.2), shake: clamp(Number(impact.shake ?? b.impact.shake), 0, 0.2) } }),
          ...(p.impacts !== undefined && { impacts: (p.impacts as unknown[]).map((ref) => parseTimeRef(project, ref)) }),
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
    summary: 'Copy a storyboard, optionally at a new size such as 1080x1920 for a vertical cut. The copy becomes active.',
    mutates: true,
    params: { storyboardId: s('Storyboard ID or name; defaults to the active one.', false), name: s('Name for the copy.', false), width: i('Frame width.', false, { min: 256, max: 3840 }), height: i('Frame height.', false, { min: 256, max: 3840 }) },
    run: (project, p) => {
      const source = requireStoryboard(project, opt(p, 'storyboardId'))
      const copy: Storyboard = {
        ...structuredClone(source),
        id: newId('vsb'),
        name: opt<string>(p, 'name')?.slice(0, 60) || `${source.name} copy`,
        ...boardSize(p, source),
      }
      copy.scenes = copy.scenes.map((scene) => ({ ...scene, id: newId('vsc') }))
      copy.text = copy.text.map((item) => ({ ...item, id: newId('vtx') }))
      const video = videoOf(project)
      return { project: { ...project, video: { storyboards: [...video.storyboards, copy], activeId: copy.id } }, result: { storyboardId: copy.id } }
    },
  },
  {
    type: 'video.storyboard.remove',
    summary: 'Remove a storyboard.',
    mutates: true,
    params: { storyboardId: s('Storyboard ID or name.') },
    run: (project, p) => {
      const board = requireStoryboard(project, String(p.storyboardId))
      const video = videoOf(project)
      const storyboards = video.storyboards.filter((b) => b.id !== board.id)
      return { project: { ...project, video: { storyboards, activeId: video.activeId === board.id ? (storyboards[0]?.id ?? null) : video.activeId } } }
    },
  },
  {
    type: 'video.scene.add',
    summary: 'Add a scene that plays from its start until the next scene. Without a look, a preset is chosen from the section’s name or the preset role.',
    mutates: true,
    params: {
      storyboardId: s('Storyboard ID or name; defaults to the active one.', false),
      start: { type: 'object', description: TIME, required: true },
      preset: s('Section role to take the starting look from.', false, { enum: ROLES }),
      ...SCENE_FIELDS,
    },
    run: (project, p) => {
      const board = requireStoryboard(project, opt(p, 'storyboardId'))
      const start = parseTimeRef(project, p.start)
      const section = start.sectionId ? project.sections.find((sec) => sec.id === start.sectionId) : null
      const role = opt<SectionRole>(p, 'preset') ?? (section ? sectionRole(section.name) : 'other')
      const variant = board.scenes.filter((sc) => sc.look === presetScene(role, start).look).length
      const scene = p.look === undefined ? createScene('', start, presetScene(role, start, variant)) : createScene(checkLookId(p.look), start)
      scene.name = opt<string>(p, 'name')?.slice(0, 60) ?? section?.name ?? ''
      const filled = applyScenePatch(project, scene, { ...p, look: undefined, start: undefined })
      return { project: updateStoryboard(project, board.id, (b) => ({ ...b, scenes: sortScenes(project, [...b.scenes, filled]) })), result: { sceneId: filled.id } }
    },
  },
  {
    type: 'video.scene.update',
    summary: 'Change a scene. params and post merge into the current values (null resets one); layers replace the current layers. Changing the look resets params unless params are given.',
    mutates: true,
    params: { sceneId: s('Scene ID.'), start: { type: 'object', description: TIME, required: false }, ...SCENE_FIELDS },
    run: (project, p) => {
      const id = String(p.sceneId)
      const board = storyboardWith(project, id, 'scene')
      return { project: updateStoryboard(project, board.id, (b) => ({ ...b, scenes: sortScenes(project, b.scenes.map((scene) => (scene.id === id ? applyScenePatch(project, scene, p) : scene))) })) }
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
      return { project: updateStoryboard(project, board.id, (b) => ({ ...b, scenes: b.scenes.filter((scene) => scene.id !== id) })) }
    },
  },
  {
    type: 'video.text.add',
    summary: 'Add a text item, for example a title slam on a drop or words on the snares.',
    mutates: true,
    params: { storyboardId: s('Storyboard ID or name; defaults to the active one.', false), start: { type: 'object', description: TIME, required: true }, ...TEXT_FIELDS, text: s('The words. Line breaks split lines; for the words style, "|" separates the words.') },
    run: (project, p) => {
      const board = requireStoryboard(project, opt(p, 'storyboardId'))
      const start = parseTimeRef(project, p.start)
      const end = p.end === undefined ? { ...start, bars: start.bars + 2 } : parseTimeRef(project, p.end)
      const item = patchText(project, createText('', start, end), { ...p, start: undefined, end: undefined })
      return { project: updateStoryboard(project, board.id, (b) => ({ ...b, text: [...b.text, item] })), result: { textId: item.id } }
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
      return { project: updateStoryboard(project, board.id, (b) => ({ ...b, text: b.text.map((item) => (item.id === id ? patchText(project, item, p) : item)) })) }
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
      return { project: updateStoryboard(project, board.id, (b) => ({ ...b, text: b.text.filter((item) => item.id !== id) })) }
    },
  },
]

function applyScenePatch(project: StudioProject, scene: VideoScene, p: P): VideoScene {
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
  return next
}
