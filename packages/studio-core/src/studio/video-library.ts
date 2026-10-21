import { StudioError } from './ops'
import {
  type CutEvent,
  type FootageClip,
  type PostKey,
  type SectionRole,
  type VideoExpr,
  type VideoLayer,
  type VideoScene,
  type VideoText,
  type VideoTravel,
  type VideoValue,
  checkExprValue,
  checkLookId,
  mergeVideoParams,
} from './video'

// The Visual Library: reusable scene presets, storyboard templates, and
// footage, kept app-wide so a second song starts from what worked on the
// first. Items are versioned; storyboards copy the values they use and pin
// the version, so editing a library item never changes a saved video.

export const LIBRARY_KINDS = ['preset', 'template', 'footage'] as const
export type LibraryKind = (typeof LIBRARY_KINDS)[number]

/** The parts of a scene a preset carries: everything except where it plays and which clips it uses. */
export interface ScenePreset {
  look: string
  params: Record<string, VideoValue>
  layers: VideoLayer[]
  post: Partial<Record<PostKey, VideoExpr>>
  travel: VideoTravel
  cutOn: CutEvent[]
  xfade: number
}

/** A text item placed relative to the first section with a role. */
export interface TemplateText extends Omit<VideoText, 'id' | 'start' | 'end'> {
  role: SectionRole
  /** Bars after the section start. */
  offset: number
  /** Length in bars. */
  length: number
}

/** A storyboard skeleton by section role, so it fits any song's structure. */
export interface StoryboardTemplate {
  roles: Partial<Record<SectionRole, ScenePreset[]>>
  text: TemplateText[]
  fade: VideoExpr
  impact: { flash: number; ca: number; shake: number }
}

export interface LibraryFootage extends Omit<FootageClip, 'id' | 'status' | 'fileId' | 'proposedBy' | 'query'> {
  /** File name of the clip inside the library's footage folder. */
  file: string
  mimeType: string
  bytes: number
  sha256: string
}

export interface LibraryItem {
  id: string
  kind: LibraryKind
  name: string
  /** Increases on every update. */
  version: number
  /** Section roles it suits, for search and for picking presets. */
  fits: SectionRole[]
  tags: string[]
  description: string
  /** Shipped with the app and read-only. */
  builtin: boolean
  createdAt: string
  updatedAt: string
  /** Where it was promoted from. */
  source: { project: string; storyboard: string } | null
  /** PNG or JPEG data URL. */
  preview: string
  preset?: ScenePreset
  template?: StoryboardTemplate
  footage?: LibraryFootage
}

/** Library items waiting for the user to accept them, proposed by the Director or the user. */
export interface LibraryPromotion {
  id: string
  item: LibraryItem
  reason: string
  proposedBy: 'user' | 'director'
  at: string
}

export function presetFromScene(scene: VideoScene): ScenePreset {
  return { look: scene.look, params: scene.params, layers: scene.layers, post: scene.post, travel: scene.travel, cutOn: scene.cutOn, xfade: scene.xfade }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Validates a preset from outside the app (library files, agents). */
export function checkPreset(value: unknown, where = 'preset'): ScenePreset {
  if (!isRecord(value)) throw new StudioError('invalid', `${where} must be an object.`)
  const travel = isRecord(value.travel) ? value.travel : {}
  return {
    look: checkLookId(value.look),
    params: mergeVideoParams({}, value.params ?? {}, `${where}.params`),
    layers: (Array.isArray(value.layers) ? value.layers : []).slice(0, 3).map((layer, i) => {
      if (!isRecord(layer)) throw new StudioError('invalid', `${where}.layers[${i}] must be an object.`)
      return { look: checkLookId(layer.look), amount: layer.amount === undefined ? 1 : checkExprValue(layer.amount, `${where}.layers[${i}].amount`), params: mergeVideoParams({}, layer.params ?? {}, `${where}.layers[${i}].params`) }
    }),
    post: Object.fromEntries(Object.entries(isRecord(value.post) ? value.post : {}).map(([key, v]) => [key, checkExprValue(v, `${where}.post.${key}`)])) as ScenePreset['post'],
    travel: { base: Number(travel.base ?? 0.3), kick: Number(travel.kick ?? 0), snare: Number(travel.snare ?? 0), bass: Number(travel.bass ?? 0) },
    cutOn: (Array.isArray(value.cutOn) ? value.cutOn : []) as CutEvent[],
    xfade: Number(value.xfade ?? 0),
  }
}
