import { Trash2 } from 'lucide-react'
import { type CSSProperties, type ReactNode, useState } from 'react'
import { studio } from '@reborn/studio-core'
import { LOOKS, lookById } from '@reborn/video'
import { type DispatchOptions, dispatch, select, useStudio } from '../state/store'

// Inspector panels for the Video view: the selected scene, the selected text
// item, and the storyboard itself. Every field accepts a number or an
// expression; edits go through video.* commands, so they undo like any edit.

type VideoValue = studio.VideoValue

const keep = (event: { stopPropagation: () => void }) => event.stopPropagation()

/** Splits on commas that are not inside parentheses. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const ch of text) {
    if (ch === '(') depth += 1
    if (ch === ')') depth -= 1
    if (ch === ',' && depth === 0) {
      parts.push(current.trim())
      current = ''
    } else current += ch
  }
  parts.push(current.trim())
  return parts
}

const NUMBER = /^-?(\d+\.?\d*|\.\d+)(e-?\d+)?$/i
const parseScalar = (text: string): studio.VideoExpr => (NUMBER.test(text) ? Number(text) : text)

/** Reads a field: empty resets to the default, commas make a vector, numbers stay numbers. */
export function parseVideoValue(text: string): VideoValue | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  const parts = splitTopLevel(trimmed)
  return parts.length > 1 ? parts.map(parseScalar) : parseScalar(trimmed)
}

export const formatVideoValue = (value: VideoValue | undefined): string => (value === undefined ? '' : Array.isArray(value) ? value.join(', ') : String(value))

const toHex = (rgb: readonly number[]) => `#${rgb.slice(0, 3).map((c) => Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, '0')).join('')}`
const fromHex = (hex: string) => [1, 3, 5].map((i) => Math.round((parseInt(hex.slice(i, i + 2), 16) / 255) * 1000) / 1000)

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="insp-group">
      <h3>{title}</h3>
      {children}
    </section>
  )
}

/** A text field that commits on blur or Enter. */
function ExprField({ label, value, placeholder, hint, onCommit, color }: { label: string; value: VideoValue | undefined; placeholder?: string; hint?: string; onCommit: (value: VideoValue | null) => void; color?: boolean }) {
  const text = formatVideoValue(value)
  const numeric = Array.isArray(value) ? value.every((v) => typeof v === 'number') : false
  const swatch = color && (value === undefined || numeric)
  return (
    <label className="vfield" title={hint}>
      <span className="vfield-label">{label}</span>
      <span className="vfield-input">
        {swatch && (
          <input
            type="color"
            aria-label={`${label} color`}
            value={toHex((Array.isArray(value) ? value : (placeholder ?? '').split(',').map(Number)) as number[])}
            onChange={(event) => onCommit(fromHex(event.target.value))}
          />
        )}
        <input
          type="text"
          spellCheck={false}
          defaultValue={text}
          key={text}
          placeholder={placeholder}
          onKeyDown={(event) => {
            keep(event)
            if (event.key === 'Enter') event.currentTarget.blur()
          }}
          onBlur={(event) => {
            if (event.target.value.trim() === text) return
            onCommit(parseVideoValue(event.target.value))
          }}
        />
      </span>
    </label>
  )
}

function NumberField({ label, value, step = 0.1, min, max, onCommit }: { label: string; value: number; step?: number; min?: number; max?: number; onCommit: (value: number) => void }) {
  return (
    <label className="vfield">
      <span className="vfield-label">{label}</span>
      <input
        type="number"
        defaultValue={value}
        key={value}
        step={step}
        min={min}
        max={max}
        onKeyDown={(event) => {
          keep(event)
          if (event.key === 'Enter') event.currentTarget.blur()
        }}
        onBlur={(event) => {
          const next = Number(event.target.value)
          if (event.target.value !== '' && Number.isFinite(next) && next !== value) onCommit(next)
        }}
      />
    </label>
  )
}

/** Picks a section anchor and a bar offset. */
function TimeField({ label, value, onCommit }: { label: string; value: studio.TimeRef; onCommit: (value: studio.TimeRef) => void }) {
  const sections = useStudio((s) => s.project.sections)
  return (
    <div className="vfield">
      <span className="vfield-label">{label}</span>
      <span className="vtime">
        <select aria-label={`${label} section`} value={value.sectionId ?? ''} onChange={(event) => onCommit({ ...value, sectionId: event.target.value || null })}>
          <option value="">Song start</option>
          {sections.map((section) => (
            <option key={section.id} value={section.id}>
              {section.name}
            </option>
          ))}
          {value.sectionId && !sections.some((s) => s.id === value.sectionId) && <option value={value.sectionId}>Missing section</option>}
        </select>
        <select aria-label={`${label} anchor`} value={value.at} disabled={!value.sectionId} onChange={(event) => onCommit({ ...value, at: event.target.value as 'start' | 'end' })}>
          <option value="start">start</option>
          <option value="end">end</option>
        </select>
        <input
          type="number"
          aria-label={`${label} offset in bars`}
          title="Offset in bars; 0.25 is one beat in 4/4"
          step={0.25}
          defaultValue={value.bars}
          key={value.bars}
          onKeyDown={(event) => {
            keep(event)
            if (event.key === 'Enter') event.currentTarget.blur()
          }}
          onBlur={(event) => {
            const bars = Number(event.target.value)
            if (Number.isFinite(bars) && bars !== value.bars) onCommit({ ...value, bars })
          }}
        />
        <span className="muted small">bars</span>
      </span>
    </div>
  )
}

function Chips<T extends string>({ options, value, onChange, label }: { options: readonly T[]; value: readonly T[]; onChange: (next: T[]) => void; label: string }) {
  return (
    <div className="insp-row" role="group" aria-label={label}>
      {options.map((option) => {
        const on = value.includes(option)
        return (
          <button key={option} type="button" className={`chip-btn${on ? ' is-on' : ''}`} aria-pressed={on} onClick={() => onChange(on ? value.filter((v) => v !== option) : [...value, option])}>
            {option}
          </button>
        )
      })}
    </div>
  )
}

function LookPicker({ value, layer, onChange, label }: { value: string; layer: boolean; onChange: (look: string) => void; label: string }) {
  const known = lookById(value)
  return (
    <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
      {!known && <option value={value}>{value} (unknown)</option>}
      {LOOKS.filter((look) => look.layer === layer || look.id === value).map((look) => (
        <option key={look.id} value={look.id}>
          {look.title}
        </option>
      ))}
      <optgroup label={layer ? 'Full-frame looks' : 'Layer looks'}>
        {LOOKS.filter((look) => look.layer !== layer && look.id !== value).map((look) => (
          <option key={look.id} value={look.id}>
            {look.title}
          </option>
        ))}
      </optgroup>
    </select>
  )
}

const sceneEdit = (sceneId: string, params: Record<string, unknown>, options: DispatchOptions = {}) => dispatch({ type: 'video.scene.update', params: { sceneId, ...params } }, options)

export function VideoScenePanel({ sceneId }: { sceneId: string }) {
  const scene = useStudio((s) => s.project.video?.storyboards.flatMap((b) => b.scenes).find((x) => x.id === sceneId))
  const project = useStudio((s) => s.project)
  const [openLayer, setOpenLayer] = useState<number | null>(null)
  if (!scene) return null
  const look = lookById(scene.look)
  const edit = (params: Record<string, unknown>, label = 'Change video scene') => sceneEdit(scene.id, params, { label })
  return (
    <>
      <h2 className="insp-title" style={{ '--track': 'var(--acid)' } as CSSProperties}>
        {scene.name || look?.title || scene.look}
        <small>
          Video scene · {studio.formatTimeRef(project, scene.start)}
        </small>
      </h2>
      <label className="field">
        <span className="field-label">Name</span>
        <input type="text" defaultValue={scene.name} key={scene.id + scene.name} onKeyDown={keep} onBlur={(event) => event.target.value !== scene.name && edit({ name: event.target.value }, 'Rename video scene')} />
      </label>
      <TimeField label="Starts at" value={scene.start} onCommit={(start) => edit({ start }, 'Move video scene')} />
      <Group title="Look">
        <LookPicker label="Look" value={scene.look} layer={false} onChange={(id) => edit({ look: id }, 'Change look')} />
        {look && (
          <p className="muted small">
            {look.description}
            {look.mood.length > 0 && <> Mood: {look.mood.join(', ')}.</>}
          </p>
        )}
        <div className="vparams">
          {look?.params.map((param) => (
            <ExprField
              key={param.name}
              label={param.name}
              hint={param.description}
              value={scene.params[param.name]}
              placeholder={param.default.join(', ')}
              color={param.default.length === 3 && param.default.every((v) => v >= 0 && v <= 1) && /col|tint|line|panel|light|dark|pal|color/i.test(param.name)}
              onCommit={(value) => edit({ params: { [param.name]: value } }, `Set ${param.name}`)}
            />
          ))}
        </div>
      </Group>
      <Group title="Layers">
        {scene.layers.map((layer, index) => {
          const layerLook = lookById(layer.look)
          const setLayers = (layers: studio.VideoLayer[], label: string) => edit({ layers }, label)
          const replace = (patch: Partial<studio.VideoLayer>) => setLayers(scene.layers.map((l, i) => (i === index ? { ...l, ...patch } : l)), 'Change layer')
          return (
            <div key={index} className="vlayer">
              <div className="insp-row">
                <LookPicker label={`Layer ${index + 1} look`} value={layer.look} layer onChange={(id) => replace({ look: id, params: {} })} />
                <button type="button" className="chip-btn" aria-expanded={openLayer === index} onClick={() => setOpenLayer(openLayer === index ? null : index)}>
                  Params
                </button>
                <button type="button" className="icon-btn sm" aria-label={`Remove layer ${index + 1}`} onClick={() => setLayers(scene.layers.filter((_, i) => i !== index), 'Remove layer')}>
                  <Trash2 size={13} />
                </button>
              </div>
              <ExprField label="Amount" value={layer.amount} placeholder="1" onCommit={(value) => replace({ amount: (Array.isArray(value) ? value[0] : value) ?? 1 })} />
              {openLayer === index && layerLook && (
                <div className="vparams">
                  {layerLook.params.map((param) => (
                    <ExprField
                      key={param.name}
                      label={param.name}
                      hint={param.description}
                      value={layer.params[param.name]}
                      placeholder={param.default.join(', ')}
                      onCommit={(value) => {
                        const params = { ...layer.params }
                        if (value === null) delete params[param.name]
                        else params[param.name] = value
                        replace({ params })
                      }}
                    />
                  ))}
                </div>
              )}
            </div>
          )
        })}
        {scene.layers.length < 3 && (
          <button type="button" className="chip-btn" onClick={() => edit({ layers: [...scene.layers, { look: 'star-sparkle', amount: 1, params: {} }] }, 'Add layer')}>
            + Add layer
          </button>
        )}
      </Group>
      <Group title="Cuts">
        <Chips label="Cut on" options={studio.CUT_EVENTS} value={scene.cutOn} onChange={(cutOn) => edit({ cutOn }, 'Change cuts')} />
        <p className="muted small">Cut events switch the graphic in Strobe Deck and count up the cut and cutT values in expressions.</p>
        <NumberField label="Crossfade in (s)" value={scene.xfade} min={0} max={30} onCommit={(xfade) => edit({ xfade }, 'Change crossfade')} />
      </Group>
      <Group title="Camera travel">
        <div className="vparams">
          {(['base', 'kick', 'snare', 'bass'] as const).map((key) => (
            <NumberField key={key} label={key} value={scene.travel[key]} onCommit={(value) => edit({ travel: { [key]: value } }, 'Change travel')} />
          ))}
        </div>
      </Group>
      <Group title="Post">
        <div className="vparams">
          {studio.POST_KEYS.map((key) => (
            <ExprField key={key} label={studio.POST_LABELS[key]} value={scene.post[key]} placeholder={String(studio.POST_DEFAULTS[key])} onCommit={(value) => edit({ post: { [key]: Array.isArray(value) ? value[0] : value } }, `Set ${studio.POST_LABELS[key].toLowerCase()}`)} />
          ))}
        </div>
      </Group>
      <div className="insp-row">
        <button
          type="button"
          className="chip-btn danger"
          onClick={() => {
            dispatch({ type: 'video.scene.remove', params: { sceneId: scene.id } }, { label: 'Remove video scene' })
            select({ kind: 'none' })
          }}
        >
          Remove scene
        </button>
      </div>
      <ExpressionHelp />
    </>
  )
}

export function VideoTextPanel({ textId }: { textId: string }) {
  const item = useStudio((s) => s.project.video?.storyboards.flatMap((b) => b.text).find((x) => x.id === textId))
  if (!item) return null
  const edit = (params: Record<string, unknown>, label = 'Change video text') => dispatch({ type: 'video.text.update', params: { textId: item.id, ...params } }, { label })
  return (
    <>
      <h2 className="insp-title" style={{ '--track': 'var(--amber)' } as CSSProperties}>
        {item.text.split('\n')[0] || 'Text'}
        <small>Video text · {item.style}</small>
      </h2>
      <label className="field">
        <span className="field-label">Text</span>
        <textarea className="vtextarea" rows={3} defaultValue={item.text} key={item.id + item.text} onKeyDown={keep} onBlur={(event) => event.target.value !== item.text && edit({ text: event.target.value }, 'Edit video text')} />
        <span className="muted small">{item.style === 'words' ? 'Separate words with | to show one per event.' : 'Line breaks split lines.'}</span>
      </label>
      <TimeField label="From" value={item.start} onCommit={(start) => edit({ start }, 'Move video text')} />
      <TimeField label="Until" value={item.end} onCommit={(end) => edit({ end }, 'Move video text')} />
      <Group title="Style">
        <div className="vparams">
          <label className="vfield">
            <span className="vfield-label">Motion</span>
            <select value={item.style} onChange={(event) => edit({ style: event.target.value })}>
              {studio.TEXT_STYLES.map((style) => (
                <option key={style} value={style}>
                  {style}
                </option>
              ))}
            </select>
          </label>
          <label className="vfield">
            <span className="vfield-label">Font</span>
            <select value={item.font} onChange={(event) => edit({ font: event.target.value })}>
              {studio.VIDEO_FONTS.map((font) => (
                <option key={font} value={font}>
                  {font}
                </option>
              ))}
            </select>
          </label>
          <NumberField label="Weight" value={item.weight} step={100} min={100} max={900} onCommit={(weight) => edit({ weight })} />
          <NumberField label="Size (px at 1080p)" value={item.size} step={10} min={8} max={1200} onCommit={(size) => edit({ size })} />
          <NumberField label="Across (0–1)" value={item.pos[0]} step={0.05} onCommit={(x) => edit({ pos: [x, item.pos[1]] })} />
          <NumberField label="Down (0–1)" value={item.pos[1]} step={0.05} onCommit={(y) => edit({ pos: [item.pos[0], y] })} />
          <label className="vfield">
            <span className="vfield-label">Color</span>
            <input type="color" value={toHex(item.color)} onChange={(event) => edit({ color: fromHex(event.target.value) })} />
          </label>
          <label className="vfield">
            <span className="vfield-label">Blend</span>
            <select value={item.blend} onChange={(event) => edit({ blend: event.target.value })}>
              <option value="normal">normal</option>
              <option value="difference">difference (inverts)</option>
            </select>
          </label>
          <NumberField label="Glitch" value={item.glitch} step={0.01} min={0} max={1} onCommit={(glitch) => edit({ glitch })} />
          <NumberField label="Kick pulse" value={item.pulse} step={0.02} min={0} max={1} onCommit={(pulse) => edit({ pulse })} />
          <NumberField label="Tracking" value={item.tracking} step={0.02} min={-0.5} max={2} onCommit={(tracking) => edit({ tracking })} />
          <NumberField label="Fade in (s)" value={item.fadeIn} min={0} max={30} onCommit={(fadeIn) => edit({ fadeIn })} />
          <NumberField label="Fade out (s)" value={item.fadeOut} min={0} max={30} onCommit={(fadeOut) => edit({ fadeOut })} />
        </div>
      </Group>
      {item.style === 'words' && (
        <Group title="Next word on">
          <Chips label="Next word on" options={studio.CUT_EVENTS} value={item.on} onChange={(on) => edit({ on })} />
        </Group>
      )}
      <div className="insp-row">
        <button
          type="button"
          className="chip-btn danger"
          onClick={() => {
            dispatch({ type: 'video.text.remove', params: { textId: item.id } }, { label: 'Remove video text' })
            select({ kind: 'none' })
          }}
        >
          Remove text
        </button>
      </div>
    </>
  )
}

/** Storyboard settings, shown in the Video view when nothing is selected. */
export function VideoBoardPanel() {
  const board = useStudio((s) => {
    const video = s.project.video
    return video?.storyboards.find((b) => b.id === video.activeId) ?? video?.storyboards[0]
  })
  if (!board) return null
  const edit = (params: Record<string, unknown>, label = 'Change storyboard') => dispatch({ type: 'video.storyboard.update', params: { storyboardId: board.id, ...params } }, { label })
  return (
    <>
      <h2 className="insp-title" style={{ '--track': 'var(--acid)' } as CSSProperties}>
        {board.name}
        <small>
          Storyboard · {board.width}×{board.height} · {board.fps} fps
        </small>
      </h2>
      <label className="field">
        <span className="field-label">Name</span>
        <input type="text" defaultValue={board.name} key={board.id + board.name} onKeyDown={keep} onBlur={(event) => event.target.value !== board.name && edit({ name: event.target.value }, 'Rename storyboard')} />
      </label>
      <Group title="Brief">
        {(['goal', 'mood', 'notes'] as const).map((key) => (
          <label key={key} className="field">
            <span className="field-label">{key === 'goal' ? 'What the video is for' : key === 'mood' ? 'Mood, colors, references' : 'Notes and things to avoid'}</span>
            <textarea className="vtextarea" rows={2} defaultValue={board.brief[key]} key={board.id + board.brief[key]} onKeyDown={keep} onBlur={(event) => event.target.value !== board.brief[key] && edit({ brief: { [key]: event.target.value } }, 'Edit brief')} />
          </label>
        ))}
      </Group>
      <Group title="Master">
        <ExprField label="Fade" value={board.fade} placeholder="1" hint="Master brightness. The default fades in over 2 s and out over the last 3 s." onCommit={(value) => edit({ fade: String((Array.isArray(value) ? value[0] : value) ?? 1) }, 'Change fade')} />
        <div className="vparams">
          <NumberField label="Impact flash" value={board.impact.flash} min={0} max={4} onCommit={(flash) => edit({ impact: { flash } })} />
          <NumberField label="Impact aberration" value={board.impact.ca} step={0.005} min={0} max={0.2} onCommit={(ca) => edit({ impact: { ca } })} />
          <NumberField label="Impact shake" value={board.impact.shake} step={0.005} min={0} max={0.2} onCommit={(shake) => edit({ impact: { shake } })} />
        </div>
        <p className="muted small">Clips with “impact” in their name fire the impact flash. Clips with “riser” in their name drive rise and rstrobe.</p>
      </Group>
      <ExpressionHelp />
    </>
  )
}

function ExpressionHelp() {
  return (
    <details className="vhelp">
      <summary>Expressions</summary>
      <p className="muted small">
        Any field takes a number or an expression, evaluated every frame. For example <code>0.004+0.006*kick</code>, <code>t*.15</code>, or <code>0.85*max(0, 1-toImpact/0.8)**2 if rise &gt; 0 else 0</code>.
      </p>
      <dl className="vhelp-list">
        {Object.entries(studio.VIDEO_VARIABLES).map(([name, description]) => (
          <div key={name}>
            <dt>
              <code>{name}</code>
            </dt>
            <dd>{description}</dd>
          </div>
        ))}
      </dl>
      <p className="muted small">Functions: {Object.keys(studio.VIDEO_FUNCTIONS).join(', ')}.</p>
    </details>
  )
}
