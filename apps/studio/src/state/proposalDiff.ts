import { studio } from '@reborn/studio-core'

type StudioProject = studio.StudioProject
type Command = studio.Command

// Plain-language lines for what a proposed command changes, so a proposal
// card can say "Tempo 124 → 130 BPM" instead of naming commands. Each line
// comes from comparing the project before and after, so it covers every
// command type, including ones added later.

const bar = (start: number) => `bar ${Math.round(start * 100) / 100 + 1}`
const bars = (length: number) => `${Math.round(length * 100) / 100} bar${length === 1 ? '' : 's'}`
const pct = (value: number) => `${Math.round(value * 100)}%`
const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b)

function byId<T extends { id: string }>(list: readonly T[]): Map<string, T> {
  return new Map(list.map((item) => [item.id, item]))
}

/** What changes between two versions of a project, one short line each. */
export function describeEffect(before: StudioProject, after: StudioProject): string[] {
  const lines: string[] = []
  if (before.name !== after.name) lines.push(`Renames the project to “${after.name}”`)
  if (before.tempo !== after.tempo) lines.push(`Tempo ${before.tempo} → ${after.tempo} BPM`)
  if (before.swing !== after.swing) lines.push(`Swing ${pct(before.swing)} → ${pct(after.swing)}`)
  if (before.length !== after.length) lines.push(`Song length ${bars(before.length)} → ${bars(after.length)}`)
  if (!same(before.meter, after.meter)) lines.push(`Meter ${before.meter.numerator}/${before.meter.denominator} → ${after.meter.numerator}/${after.meter.denominator}`)

  const trackName = (id: string) => after.tracks.find((t) => t.id === id)?.name ?? before.tracks.find((t) => t.id === id)?.name ?? 'a track'
  const oldTracks = byId(before.tracks)
  const newTracks = byId(after.tracks)
  for (const track of after.tracks) {
    const old = oldTracks.get(track.id)
    if (!old) {
      lines.push(`Adds the track “${track.name}”`)
      continue
    }
    if (old === track) continue
    if (old.name !== track.name) lines.push(`Renames “${old.name}” to “${track.name}”`)
    if (old.mixer.mute !== track.mixer.mute) lines.push(`${track.mixer.mute ? 'Mutes' : 'Unmutes'} ${track.name}`)
    if (old.mixer.solo !== track.mixer.solo) lines.push(`${track.mixer.solo ? 'Solos' : 'Unsolos'} ${track.name}`)
    if (old.mixer.output !== track.mixer.output) lines.push(`Routes ${track.name} to ${track.mixer.output === 'master' ? 'the master' : trackName(track.mixer.output)}`)
    for (const spec of studio.paramSpecs(track, after.returns)) {
      const from = studio.getParam(old, spec.id)
      const to = studio.getParam(track, spec.id)
      if (from === undefined || to === undefined || Math.abs(from - to) < 1e-6) continue
      lines.push(`${track.name} ${spec.label.toLowerCase()} ${studio.formatParam(spec, from)} → ${studio.formatParam(spec, to)}`)
    }
    if (!same(old.macros, track.macros)) lines.push(`Changes ${track.name}’s macros`)
  }
  for (const track of before.tracks) if (!newTracks.has(track.id)) lines.push(`Removes the track “${track.name}”`)

  const patternUse = (id: string) => {
    const clip = after.clips.find((c) => c.patternId === id) ?? before.clips.find((c) => c.patternId === id)
    return clip ? ` on ${trackName(clip.trackId)}` : ''
  }
  for (const [id, pattern] of Object.entries(after.patterns)) {
    const old = before.patterns[id]
    if (!old) lines.push(`Adds the pattern “${pattern.name}”`)
    else if (old !== pattern && !same(old, pattern)) {
      if (old.length !== pattern.length) lines.push(`“${pattern.name}” length ${old.length} → ${pattern.length} steps`)
      const { length: _a, ...restOld } = old
      const { length: _b, ...restNew } = pattern
      if (!same(restOld, restNew)) lines.push(`Rewrites the pattern “${pattern.name}”${patternUse(id)}`)
    }
  }
  for (const [id, pattern] of Object.entries(before.patterns)) if (!after.patterns[id]) lines.push(`Removes the pattern “${pattern.name}”`)

  const oldClips = byId(before.clips)
  const newClips = byId(after.clips)
  for (const clip of after.clips) {
    const old = oldClips.get(clip.id)
    const where = `on ${trackName(clip.trackId)}`
    if (!old) {
      lines.push(`Adds a clip ${where} at ${bar(clip.start)} (${bars(clip.length)})`)
      continue
    }
    if (old === clip || same(old, clip)) continue
    const moved = old.start !== clip.start || old.trackId !== clip.trackId
    if (moved) lines.push(`Moves a clip ${where} from ${bar(old.start)} to ${bar(clip.start)}`)
    if (old.length !== clip.length) lines.push(`Resizes a clip ${where} at ${bar(clip.start)} to ${bars(clip.length)}`)
    if (old.mute !== clip.mute) lines.push(`${clip.mute ? 'Mutes' : 'Unmutes'} a clip ${where} at ${bar(clip.start)}`)
    const { start: _s1, length: _l1, trackId: _t1, mute: _m1, ...restOld } = old
    const { start: _s2, length: _l2, trackId: _t2, mute: _m2, ...restNew } = clip
    if (!same(restOld, restNew)) lines.push(`Changes a clip ${where} at ${bar(clip.start)}`)
  }
  for (const clip of before.clips) if (!newClips.has(clip.id)) lines.push(`Removes a clip on ${trackName(clip.trackId)} at ${bar(clip.start)}`)

  const oldSections = byId(before.sections)
  const newSections = byId(after.sections)
  for (const section of after.sections) {
    const old = oldSections.get(section.id)
    if (!old) lines.push(`Adds the section “${section.name}” at ${bar(section.start)} (${bars(section.length)})`)
    else if (!same(old, section)) {
      if (old.name !== section.name) lines.push(`Renames the section “${old.name}” to “${section.name}”`)
      if (old.start !== section.start || old.length !== section.length) lines.push(`Section “${section.name}” now ${bar(section.start)}, ${bars(section.length)}`)
    }
  }
  for (const section of before.sections) if (!newSections.has(section.id)) lines.push(`Removes the section “${section.name}”`)

  const oldReturns = byId(before.returns)
  for (const ret of after.returns) {
    const old = oldReturns.get(ret.id)
    if (!old) lines.push(`Adds the return “${ret.name}”`)
    else if (!same(old, ret)) lines.push(`Changes the return “${ret.name}”`)
  }
  for (const ret of before.returns) if (!after.returns.some((r) => r.id === ret.id)) lines.push(`Removes the return “${ret.name}”`)
  if (!same(before.master, after.master)) lines.push('Changes the master')
  if (!same(before.scenes, after.scenes)) lines.push('Changes the scenes')
  if (!same(before.automation, after.automation)) lines.push('Changes automation')
  if (!same(before.video, after.video)) lines.push('Changes the video storyboard')
  return lines
}

/** A fallback name for a command, for when it can't be run to see its effect. */
export function commandLabel(command: Command): string {
  const p = command.params ?? {}
  const target = p.trackId ?? p.clipId ?? p.patternId ?? p.returnId ?? p.sectionId ?? ''
  return `${command.type}${target ? ` · ${String(target)}` : ''}`
}

const REFERENCE = /^\$([A-Za-z][\w-]*)\.(\w+)$/

/** Swaps "$name.key" values for results named by earlier commands, as a batch would. */
function resolve(value: unknown, named: Map<string, unknown>): unknown {
  if (typeof value === 'string') {
    const match = REFERENCE.exec(value)
    const result = match ? named.get(match[1]) : undefined
    const found = result && typeof result === 'object' ? (result as Record<string, unknown>)[match![2]] : undefined
    return found ?? value
  }
  if (Array.isArray(value)) return value.map((item) => resolve(item, named))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v, named)]))
  return value
}

/**
 * Describes each command's effect in the context of those before it. Commands
 * run one at a time, so new IDs stay stable from one step to the next, with
 * references to earlier results ("$verse.patternId") filled in as a batch
 * would. A command that fails gets its label and the error instead, and the
 * rest carry on from the last good state.
 */
export function describeCommands(project: StudioProject, commands: readonly Command[]): { lines: string[]; error: string | null }[] {
  const named = new Map<string, unknown>()
  let current = project
  return commands.map((command) => {
    try {
      const { ref, ...rest } = command
      const outcome = studio.executeBatch(current, [{ ...rest, params: resolve(rest.params ?? {}, named) as Record<string, unknown> }], { origin: 'agent' })
      if (ref) named.set(ref, outcome.results[0])
      const next = outcome.project
      const lines = describeEffect(current, next)
      current = next
      return { lines: lines.length ? lines : ['No visible change'], error: null }
    } catch (error) {
      return { lines: [commandLabel(command)], error: error instanceof Error ? error.message : String(error) }
    }
  })
}
