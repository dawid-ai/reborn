import '@fontsource/big-shoulders-display/900'
import '@fontsource/chakra-petch/700'
import '@fontsource/barlow-condensed/700'
import '@fontsource/share-tech-mono/400'
import { Camera, Clapperboard, Download, Film, Library, Plus, RefreshCw, Type } from 'lucide-react'
import { type CSSProperties, type MouseEvent, useEffect, useMemo, useRef, useState } from 'react'
import { studio } from '@reborn/studio-core'
import { type Timeline as TimelineType, Timeline, VideoRenderer, lookById } from '@reborn/video'
import { engine, usePlayhead } from '../audio/host'
import { type Selection, dispatch, select, useStudio } from '../state/store'
import { exportVideo, loadVideoFonts } from '../video/export'
import { renderLookDev } from '../video/lookdev'
import { footage } from '../video/media'
import { type DrawerTab, VideoDrawer } from './VideoDrawer'
import { StageBar, StillViewer, StoredImage } from './VideoReview'
import { analyzeSong, isAnalysisCurrent, useAnalysis } from '../video/session'

// Video view: a live preview that follows the transport, and lanes aligned
// to the arrangement showing sections, scenes, text, and the drum hits that
// drive cuts. Selecting a scene or text item opens it in the inspector.

/** Longest edge of the live preview, in pixels. Exports render at full size. */
const PREVIEW_EDGE = 960

function activeBoard(project: studio.StudioProject): studio.Storyboard | null {
  const video = project.video
  return video?.storyboards.find((b) => b.id === video.activeId) ?? video?.storyboards[0] ?? null
}

/** A time reference for a bar: the section it falls in plus an offset snapped to beats. */
function refAtBar(project: studio.StudioProject, bar: number): studio.TimeRef {
  const section = [...project.sections].sort((a, z) => a.start - z.start).filter((s) => s.start <= bar + 1e-6).pop()
  const beats = project.meter.numerator
  const snap = (value: number) => Math.round(value * beats) / beats
  return section ? { sectionId: section.id, at: 'start', bars: snap(bar - section.start) } : studio.songStart(snap(bar))
}

function EmptyVideo() {
  const sections = useStudio((s) => s.project.sections.length)
  return (
    <div className="video-empty">
      <Clapperboard size={40} strokeWidth={1.4} />
      <h2>Make a music video from this song</h2>
      <p className="muted">
        A storyboard cuts visuals to the song’s real drum hits, risers, and impacts. It starts with one scene per section{sections ? '' : ' (this song has no sections yet, so it starts with one scene)'}, picked by the section’s name: builds dive into a whiteout, drops hit hard and dark, switches strobe on the drums.
      </p>
      <button type="button" className="chip-btn primary" onClick={() => dispatch({ type: 'video.storyboard.create', params: {} }, { label: 'Create storyboard' })}>
        <Plus size={14} /> Create storyboard
      </button>
    </div>
  )
}

type ExportRange = 'song' | 'loop' | 'scene'

/** Seconds to export for a range choice, or undefined for the whole song. */
function rangeSeconds(range: ExportRange, timeline: TimelineType, selection: Selection): [number, number] | undefined {
  const bar = timeline.cues.barSeconds
  if (range === 'loop') {
    const loop = engine.snapshot().loop
    return loop ? [loop[0] * bar, loop[1] * bar] : undefined
  }
  if (range === 'scene') {
    const scene = selection.kind === 'videoScene' ? timeline.scenes.find((s) => s.scene.id === selection.sceneId) : undefined
    return scene ? [scene.t0, Math.min(scene.t1, timeline.duration)] : undefined
  }
  return undefined
}

function VideoBar({ board, timeline, drawer, onDrawer }: { board: studio.Storyboard; timeline: TimelineType; drawer: DrawerTab | null; onDrawer: (tab: DrawerTab | null) => void }) {
  const boards = useStudio((s) => s.project.video?.storyboards ?? [])
  const project = useStudio((s) => s.project)
  const selection = useStudio((s) => s.selection)
  const loop = useStudio((s) => s.transport.loop)
  const analysis = useAnalysis()
  const current = analysis.signature !== null && isAnalysisCurrent(project)
  const exporting = useStudio((s) => s.jobs.some((j) => j.id.startsWith('video-export') && j.status === 'running'))
  const stilling = useStudio((s) => s.jobs.some((j) => j.id.startsWith('video-stills') && j.status === 'running'))
  const [range, setRange] = useState<ExportRange>('song')
  const sceneSelected = selection.kind === 'videoScene'
  const exportRange = rangeSeconds(range, timeline, selection)
  const size = studio.VIDEO_SIZES.find((s) => s.width === board.width && s.height === board.height)
  const update = (params: Record<string, unknown>, label: string) => dispatch({ type: 'video.storyboard.update', params: { storyboardId: board.id, ...params } }, { label })
  return (
    <div className="video-bar">
      <select aria-label="Storyboard" value={board.id} onChange={(event) => dispatch({ type: 'video.storyboard.activate', params: { storyboardId: event.target.value } }, { label: 'Switch storyboard' })}>
        {boards.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
      </select>
      <select
        aria-label="Frame size"
        value={size ? `${size.width}x${size.height}` : 'custom'}
        onChange={(event) => {
          const [width, height] = event.target.value.split('x').map(Number)
          if (width && height) update({ width, height }, 'Change video size')
        }}
      >
        {!size && <option value="custom">{board.width}×{board.height}</option>}
        {studio.VIDEO_SIZES.map((s) => (
          <option key={s.label} value={`${s.width}x${s.height}`}>
            {s.label}
          </option>
        ))}
      </select>
      <select aria-label="Frame rate" value={board.fps} onChange={(event) => update({ fps: Number(event.target.value) }, 'Change frame rate')}>
        {[24, 25, 30, 50, 60].map((fps) => (
          <option key={fps} value={fps}>
            {fps} fps
          </option>
        ))}
      </select>
      <button type="button" className="chip-btn" title="Copy this storyboard as a 1080×1920 vertical cut" onClick={() => dispatch({ type: 'video.storyboard.duplicate', params: { storyboardId: board.id, name: `${board.name} vertical`, width: 1080, height: 1920 } }, { label: 'Duplicate as vertical' })}>
        Vertical copy
      </button>
      <button type="button" className={`chip-btn${drawer ? ' is-on' : ''}`} aria-pressed={Boolean(drawer)} onClick={() => onDrawer(drawer ? null : 'library')}>
        <Library size={13} /> Looks, library, footage
      </button>
      <span className="video-bar-spacer" />
      <span className={`video-analysis${current ? ' is-current' : ''}`} title="Band envelopes and the waveform come from a render of the mix. Drum pulses come straight from the patterns and never need this.">
        {analysis.running ? 'Analyzing the mix…' : current ? 'Mix analyzed' : analysis.signature ? 'Music changed since the analysis' : 'Bass and hat motion need a mix analysis'}
      </span>
      <button type="button" className="chip-btn" disabled={analysis.running || current} onClick={() => void analyzeSong()}>
        <RefreshCw size={13} /> Analyze mix
      </button>
      <button type="button" className="chip-btn" disabled={stilling} title="Render a still at each scene, impact, and text moment, plus a contact sheet" onClick={() => void renderLookDev({ storyboardId: board.id })}>
        <Camera size={13} /> Render stills
      </button>
      <select aria-label="Export range" value={range} onChange={(event) => setRange(event.target.value as ExportRange)}>
        <option value="song">Whole song</option>
        <option value="loop" disabled={!loop}>
          Loop range
        </option>
        <option value="scene" disabled={!sceneSelected}>
          Selected scene
        </option>
      </select>
      <button type="button" className="chip-btn" disabled={exporting} title="Half-size render to check timing quickly" onClick={() => void exportVideo({ scale: 0.5, storyboardId: board.id, range: exportRange })}>
        <Film size={13} /> Export draft
      </button>
      <button type="button" className="chip-btn primary" disabled={exporting} onClick={() => void exportVideo({ scale: 1, storyboardId: board.id, range: exportRange })}>
        <Download size={13} /> Export MP4
      </button>
    </div>
  )
}

function Preview({ board, timeline }: { board: studio.Storyboard; timeline: TimelineType }) {
  const stageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rendererRef = useRef<VideoRenderer | null>(null)
  const timelineRef = useRef(timeline)
  const [error, setError] = useState<string | null>(null)
  const [box, setBox] = useState({ width: 0, height: 0 })

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const observer = new ResizeObserver(([entry]) => setBox({ width: entry.contentRect.width, height: entry.contentRect.height }))
    observer.observe(stage)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    try {
      rendererRef.current = new VideoRenderer(canvasRef.current!)
      rendererRef.current.setFootage(footage)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
    let frame = 0
    const loop = () => {
      const renderer = rendererRef.current
      if (renderer) {
        try {
          renderer.render(engine.position() * timelineRef.current.cues.barSeconds)
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err))
          rendererRef.current = null
        }
      }
      frame = requestAnimationFrame(loop)
    }
    frame = requestAnimationFrame(loop)
    return () => {
      cancelAnimationFrame(frame)
      rendererRef.current?.dispose()
      rendererRef.current = null
    }
  }, [])

  const aspect = board.width / board.height
  const fit = box.width / box.height > aspect ? { width: box.height * aspect, height: box.height } : { width: box.width, height: box.width / aspect }
  const scale = Math.min(1, PREVIEW_EDGE / Math.max(board.width, board.height))
  const pixels = { width: Math.max(2, Math.round((board.width * scale) / 2) * 2), height: Math.max(2, Math.round((board.height * scale) / 2) * 2) }

  useEffect(() => {
    timelineRef.current = timeline
    const renderer = rendererRef.current
    if (!renderer) return
    try {
      renderer.setSize(pixels.width, pixels.height)
      renderer.setTimeline(timeline)
      setError(null)
      renderer.render(engine.position() * timeline.cues.barSeconds, true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
    let alive = true
    void loadVideoFonts(board).then(() => alive && rendererRef.current?.render(engine.position() * timeline.cues.barSeconds, true))
    return () => {
      alive = false
    }
  }, [timeline, board, pixels.width, pixels.height])

  return (
    <div className="video-stage" ref={stageRef}>
      <canvas ref={canvasRef} className="video-canvas" style={{ width: fit.width || undefined, height: fit.height || undefined }} aria-label="Video preview" />
      {error && <p className="video-error">Preview unavailable: {error}</p>}
      {timeline.warnings.length > 0 && (
        <ul className="video-warnings" aria-live="polite">
          {timeline.warnings.slice(0, 4).map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

function CueTicks({ timeline }: { timeline: TimelineType }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const draw = () => {
      const width = canvas.clientWidth
      const height = canvas.clientHeight
      canvas.width = width * devicePixelRatio
      canvas.height = height * devicePixelRatio
      const ctx = canvas.getContext('2d')!
      ctx.scale(devicePixelRatio, devicePixelRatio)
      ctx.clearRect(0, 0, width, height)
      const rows: [studio.CutEvent, string][] = [
        ['kick', '#c7ff39'],
        ['snare', '#3fd6e6'],
        ['hat', '#8b938d'],
      ]
      rows.forEach(([channel, color], row) => {
        ctx.fillStyle = color
        const y = (row * height) / rows.length
        for (const t of timeline.events(channel)) ctx.fillRect(Math.round((t / timeline.duration) * width), y + 1, 1, height / rows.length - 2)
      })
      ctx.fillStyle = '#ffad32'
      for (const t of timeline.events('impact')) ctx.fillRect(Math.round((t / timeline.duration) * width) - 1, 0, 3, height)
    }
    draw()
    const observer = new ResizeObserver(draw)
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [timeline])
  return <canvas ref={ref} className="video-cues" aria-hidden="true" />
}

/** Where a comment sits on the timeline, in seconds, or null for storyboard-wide comments. */
function commentSeconds(comment: studio.VideoComment, project: studio.StudioProject, board: studio.Storyboard, timeline: TimelineType): number | null {
  const t = comment.target
  if (t.kind === 'scene') return timeline.scenes.find((s) => s.scene.id === t.sceneId)?.t0 ?? null
  if (t.kind === 'text') return timeline.texts.find((x) => x.item.id === t.textId)?.t0 ?? null
  if (t.kind === 'time') return studio.timeRefSeconds(project, t.at)
  if (t.kind === 'still') return project.video?.files[t.fileId]?.seconds ?? null
  return null
}

function Lanes({ board, timeline }: { board: studio.Storyboard; timeline: TimelineType }) {
  const project = useStudio((s) => s.project)
  const selection = useStudio((s) => s.selection)
  const files = useStudio((s) => s.project.video?.files)
  const [viewing, setViewing] = useState<string | null>(null)
  const barSeconds = timeline.cues.barSeconds
  const duration = timeline.duration
  const playhead = usePlayhead((bar) => Math.min(1, (bar * barSeconds) / duration))
  const pct = (t: number) => `${(Math.max(0, Math.min(duration, t)) / duration) * 100}%`
  const span = (t0: number, t1: number): CSSProperties => ({ left: pct(t0), width: `calc(${pct(Math.min(t1, duration))} - ${pct(t0)})` })
  const seek = (event: MouseEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    engine.seek(Math.max(0, ((event.clientX - rect.left) / rect.width) * project.length))
  }
  const playheadBar = () => engine.position()
  const addScene = () => {
    const results = dispatch({ type: 'video.scene.add', params: { storyboardId: board.id, start: refAtBar(project, playheadBar()) } }, { label: 'Add video scene' })
    const sceneId = (results?.[0] as { sceneId?: string } | undefined)?.sceneId
    if (sceneId) select({ kind: 'videoScene', sceneId })
  }
  const addText = () => {
    const start = refAtBar(project, playheadBar())
    const results = dispatch({ type: 'video.text.add', params: { storyboardId: board.id, start, end: { ...start, bars: start.bars + 2 }, text: project.name.toUpperCase(), style: 'slam', size: 220 } }, { label: 'Add video text' })
    const textId = (results?.[0] as { textId?: string } | undefined)?.textId
    if (textId) select({ kind: 'videoText', textId })
  }
  return (
    <div className="video-lanes">
      <div className="video-lane-heads">
        <span>Sections</span>
        <span>
          Scenes
          <button type="button" className="icon-btn sm" aria-label="Add a scene at the playhead" title="Add a scene at the playhead" onClick={addScene}>
            <Plus size={13} />
          </button>
        </span>
        <span>
          Text
          <button type="button" className="icon-btn sm" aria-label="Add text at the playhead" title="Add text at the playhead" onClick={addText}>
            <Type size={13} />
          </button>
        </span>
        <span>Stills</span>
        <span>Notes</span>
        <span>Drums</span>
      </div>
      <div className="video-lane-body" onClick={seek}>
        <div className="video-lane">
          {project.sections.map((section) => (
            <span key={section.id} className="video-section" style={{ ...span(section.start * barSeconds, (section.start + section.length) * barSeconds), '--track': section.color } as CSSProperties}>
              {section.name}
            </span>
          ))}
        </div>
        <div className="video-lane">
          {timeline.scenes.map((resolved) => {
            const on = selection.kind === 'videoScene' && selection.sceneId === resolved.scene.id
            return (
              <button
                key={resolved.scene.id}
                type="button"
                className={`video-block scene${on ? ' is-on' : ''}${resolved.look ? '' : ' is-broken'}`}
                style={span(resolved.t0, resolved.t1)}
                title={`${resolved.scene.name || resolved.look?.title || resolved.scene.look} · ${studio.formatTimeRef(project, resolved.scene.start)}`}
                onClick={(event) => {
                  event.stopPropagation()
                  select({ kind: 'videoScene', sceneId: resolved.scene.id })
                }}
                onDoubleClick={(event) => {
                  event.stopPropagation()
                  engine.seek(resolved.t0 / barSeconds)
                }}
              >
                <b>{resolved.scene.name || resolved.look?.title || resolved.scene.look}</b>
                <small>{lookById(resolved.scene.look)?.title ?? `${resolved.scene.look}?`}</small>
              </button>
            )
          })}
        </div>
        <div className="video-lane">
          {timeline.texts.map(({ item, t0, t1 }) => {
            const on = selection.kind === 'videoText' && selection.textId === item.id
            return (
              <button
                key={item.id}
                type="button"
                className={`video-block text${on ? ' is-on' : ''}`}
                style={span(t0, t1)}
                title={item.text}
                onClick={(event) => {
                  event.stopPropagation()
                  select({ kind: 'videoText', textId: item.id })
                }}
              >
                <b>{item.text.replace(/\n/g, ' ')}</b>
              </button>
            )
          })}
        </div>
        <div className="video-lane video-stills-lane">
          {board.stills.map((id) => {
            const file = files?.[id]
            if (!file || file.seconds === null) return null
            return (
              <button
                key={id}
                type="button"
                className="video-still-thumb"
                style={{ left: pct(file.seconds) }}
                title={file.name}
                onClick={(event) => {
                  event.stopPropagation()
                  setViewing(id)
                }}
              >
                <StoredImage fileId={id} alt={file.name} />
              </button>
            )
          })}
        </div>
        <div className="video-lane">
          {board.comments.map((comment) => {
            const at = commentSeconds(comment, project, board, timeline)
            if (at === null) return null
            const target = comment.target
            return (
              <button
                key={comment.id}
                type="button"
                className={`video-note is-${comment.status}`}
                style={{ left: pct(at) }}
                title={comment.text}
                onClick={(event) => {
                  event.stopPropagation()
                  if (target.kind === 'scene') select({ kind: 'videoScene', sceneId: target.sceneId })
                  else if (target.kind === 'text') select({ kind: 'videoText', textId: target.textId })
                  else if (target.kind === 'still') setViewing(target.fileId)
                  else select({ kind: 'none' })
                }}
              >
                {comment.author === 'director' ? 'D' : '•'}
              </button>
            )
          })}
        </div>
        <div className="video-lane">
          <CueTicks timeline={timeline} />
        </div>
        <span className="video-playhead" style={{ left: `${playhead * 100}%` }} />
      </div>
      {viewing && <StillViewer board={board} fileId={viewing} onClose={() => setViewing(null)} />}
    </div>
  )
}

export function Video() {
  const project = useStudio((s) => s.project)
  const board = activeBoard(project)
  const analysis = useAnalysis()
  // Video edits leave the analysis valid; music edits make it stale, and the
  // preview keeps the old envelopes until the mix is analyzed again.
  const timeline = useMemo(() => (board ? new Timeline(project, board, analysis.features) : null), [project, board, analysis.features])
  const [drawer, setDrawer] = useState<DrawerTab | null>(null)
  if (!board || !timeline) return <EmptyVideo />
  return (
    <div className="video-view">
      <VideoBar board={board} timeline={timeline} drawer={drawer} onDrawer={setDrawer} />
      <StageBar board={board} />
      <div className={`video-middle${drawer ? ' with-drawer' : ''}`}>
        <Preview board={board} timeline={timeline} />
        {drawer && <VideoDrawer board={board} tab={drawer} onTab={setDrawer} onClose={() => setDrawer(null)} />}
      </div>
      <Lanes board={board} timeline={timeline} />
    </div>
  )
}
