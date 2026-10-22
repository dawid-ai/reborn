import { Check, MessageSquare, X } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { studio } from '@reborn/studio-core'
import { engine } from '../audio/host'
import { dispatch, setState, useStudio } from '../state/store'
import { videoFileUrl } from '../video/media'

// Review tools for the Video view: the stage bar with its approval gate,
// comment threads, and stills. Comments block approval until the Director
// (or the user) answers them, so nothing asked for gets lost.

export const STAGE_LABELS: Record<studio.VideoStage, string> = { brief: 'Brief', treatment: 'Treatment', lookdev: 'Look-dev', draft: 'Draft', final: 'Final' }

const keep = (event: { stopPropagation: () => void }) => event.stopPropagation()

/** Shows a stored still or sheet; nothing until its bytes load. */
export function StoredImage({ fileId, alt, className }: { fileId: string; alt: string; className?: string }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    void videoFileUrl(fileId).then((next) => alive && setUrl(next))
    return () => {
      alive = false
    }
  }, [fileId])
  return url ? <img src={url} alt={alt} className={className} draggable={false} /> : <span className={`${className ?? ''} is-loading`} aria-label={alt} />
}

/** What each stage is for, shown in the stage bar while nothing waits for approval. */
const STAGE_HINTS: Record<studio.VideoStage, string> = {
  brief: 'Describe the video in the brief in the inspector, then open Agent, switch to Director, and ask it to plan the video.',
  treatment: 'The plan: a scene, look, and text for each section. Approve it when the plan fits the song.',
  lookdev: 'Stills check framing, brightness, and color. Approve when the stills look right.',
  draft: 'A draft export to watch in time with the music. Approve when the timing works.',
  final: 'Export the finished MP4.',
}

export function StageBar({ board }: { board: studio.Storyboard }) {
  const open = studio.openComments(board).length
  const current = studio.VIDEO_STAGES.indexOf(board.stage)
  const finished = board.stage === 'final' && board.approvals.some((a) => a.stage === 'final')
  const next = studio.nextStage(board.stage)
  const approve = (override: boolean) => dispatch({ type: 'video.stage.approve', params: { storyboardId: board.id, override } }, { label: `Approve ${STAGE_LABELS[board.stage]}` })
  const gate = finished ? null : (
    <>
      {open > 0 && (
        <span className="video-open-comments">
          <MessageSquare size={12} /> {open} open
        </span>
      )}
      <button type="button" className="chip-btn primary" disabled={open > 0} title={open ? 'Answer the open comments first' : next ? `Moves the storyboard on to ${STAGE_LABELS[next]}` : 'Marks the video finished'} onClick={() => approve(false)}>
        Approve {STAGE_LABELS[board.stage]}
      </button>
      {open > 0 && (
        <button type="button" className="chip-btn" onClick={() => approve(true)}>
          Approve anyway
        </button>
      )}
    </>
  )
  return (
    <div className="video-stages">
      <ol className="video-stage-steps" aria-label="Stages">
        {studio.VIDEO_STAGES.map((stage, i) => {
          const done = i < current || (finished && i === current)
          return (
            <li key={stage} className={`${i === current && !finished ? 'is-current' : ''}${done ? ' is-done' : ''}`} aria-current={i === current ? 'step' : undefined} title={STAGE_HINTS[stage]}>
              {done && <Check size={11} />}
              {STAGE_LABELS[stage]}
            </li>
          )
        })}
      </ol>
      <p className="video-stage-hint muted small">{finished ? 'Finished. Reopen a stage to keep working on it.' : board.request ? 'The Director is waiting for you.' : STAGE_HINTS[board.stage]}</p>
      {!board.request && gate}
      {current > 0 && (
        <select aria-label="Reopen an earlier stage" value="" onChange={(event) => event.target.value && dispatch({ type: 'video.stage.reopen', params: { storyboardId: board.id, stage: event.target.value } }, { label: 'Reopen stage' })}>
          <option value="">Go back…</option>
          {studio.VIDEO_STAGES.slice(0, current + (finished ? 1 : 0)).map((stage) => (
            <option key={stage} value={stage}>
              Reopen {STAGE_LABELS[stage]}
            </option>
          ))}
        </select>
      )}
      {board.request && <RequestCard request={board.request}>{gate}</RequestCard>}
    </div>
  )
}

/** The Director's approval request: its summary, the stills to look at, and the approve button. */
function RequestCard({ request, children }: { request: studio.StageRequest; children: ReactNode }) {
  const [full, setFull] = useState(false)
  const files = useStudio((s) => s.project.video?.files)
  const at = new Date(request.at)
  return (
    <section className="video-request" aria-label="The Director's request">
      <header>
        <b>The Director asks you to approve {STAGE_LABELS[request.stage]}</b>
        <span className="muted small">{at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
      </header>
      <p className={`video-request-text${full ? ' is-full' : ''}`}>{request.summary}</p>
      <div className="video-request-foot">
        <button type="button" className="chip-btn" aria-expanded={full} onClick={() => setFull(!full)}>
          {full ? 'Show less' : 'Read all'}
        </button>
        {request.fileIds.map((id) => {
          const file = files?.[id]
          return file ? (
            <button key={id} type="button" className="video-request-thumb" title={`Open ${file.name.replace(/\.png$/, '')}`} onClick={() => setState({ videoStill: id })}>
              <StoredImage fileId={id} alt={file.name} />
            </button>
          ) : null
        })}
        <span className="video-request-tip muted small">To ask for changes, add a comment in the inspector, then tell the Director to continue.</span>
        {children}
      </div>
    </section>
  )
}

function sameTarget(a: studio.CommentTarget, b: studio.CommentTarget): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'scene' && b.kind === 'scene') return a.sceneId === b.sceneId
  if (a.kind === 'text' && b.kind === 'text') return a.textId === b.textId
  if (a.kind === 'still' && b.kind === 'still') return a.fileId === b.fileId
  if (a.kind === 'time' && b.kind === 'time') return JSON.stringify(a.at) === JSON.stringify(b.at)
  return true
}

function Reply({ comment }: { comment: studio.VideoComment }) {
  const [text, setText] = useState('')
  const send = (status?: studio.CommentStatus) => {
    if (!text.trim() && !status) return
    if (text.trim()) dispatch({ type: 'video.comment.reply', params: { commentId: comment.id, text: text.trim(), ...(status && { status }) } }, { label: 'Reply to comment' })
    else dispatch({ type: 'video.comment.resolve', params: { commentId: comment.id, status } }, { label: 'Resolve comment' })
    setText('')
  }
  return (
    <div className="vcomment-actions">
      <input type="text" value={text} placeholder="Reply" aria-label="Reply" onChange={(event) => setText(event.target.value)} onKeyDown={(event) => {
        keep(event)
        if (event.key === 'Enter') send()
      }} />
      {comment.status === 'open' ? (
        <>
          <button type="button" className="chip-btn" onClick={() => send('addressed')}>
            Done
          </button>
          <button type="button" className="chip-btn" onClick={() => send('wontfix')}>
            Won’t fix
          </button>
        </>
      ) : (
        <button type="button" className="chip-btn" onClick={() => send('open')}>
          Reopen
        </button>
      )}
    </div>
  )
}

/** Comment threads, optionally only those about one target, with a box to add one. */
export function Comments({ board, target, title = 'Comments' }: { board: studio.Storyboard; target?: studio.CommentTarget; title?: string }) {
  const [text, setText] = useState('')
  const [showDone, setShowDone] = useState(false)
  const all = target ? board.comments.filter((c) => sameTarget(c.target, target)) : board.comments
  const shown = all.filter((c) => showDone || c.status === 'open')
  const project = useStudio((s) => s.project)
  const about = (c: studio.VideoComment) => {
    const t = c.target
    if (target) return null
    if (t.kind === 'scene') return board.scenes.find((sc) => sc.id === t.sceneId)?.name || 'a scene'
    if (t.kind === 'text') return `text “${board.text.find((x) => x.id === t.textId)?.text.slice(0, 20) ?? ''}”`
    if (t.kind === 'time') return studio.formatTimeRef(project, t.at)
    if (t.kind === 'still') return 'a still'
    return null
  }
  const add = () => {
    if (!text.trim()) return
    dispatch({ type: 'video.comment.add', params: { storyboardId: board.id, text: text.trim(), ...(target && { target }) } }, { label: 'Add comment' })
    setText('')
  }
  return (
    <section className="insp-group">
      <h3>{title}</h3>
      {shown.length === 0 && <p className="muted small">{all.length ? 'No open comments.' : 'No comments yet. Comments and requests you leave here go to the Director on its next turn.'}</p>}
      <ul className="vcomments">
        {shown.map((comment) => (
          <li key={comment.id} className={`vcomment is-${comment.status}`}>
            <header>
              <b className={comment.author}>{comment.author === 'director' ? 'Director' : 'You'}</b>
              {about(comment) && <span className="muted small">on {about(comment)}</span>}
              <span className={`vcomment-status ${comment.status}`}>{comment.status === 'wontfix' ? 'won’t fix' : comment.status}</span>
              <button type="button" className="icon-btn sm" aria-label="Delete comment" onClick={() => dispatch({ type: 'video.comment.remove', params: { commentId: comment.id } }, { label: 'Delete comment' })}>
                <X size={12} />
              </button>
            </header>
            <p>{comment.text}</p>
            {comment.replies.map((reply, i) => (
              <p key={i} className="vcomment-reply">
                <b className={reply.author}>{reply.author === 'director' ? 'Director' : 'You'}</b> {reply.text}
              </p>
            ))}
            <Reply comment={comment} />
          </li>
        ))}
      </ul>
      {all.some((c) => c.status !== 'open') && (
        <button type="button" className="chip-btn" onClick={() => setShowDone(!showDone)}>
          {showDone ? 'Hide answered' : `Show answered (${all.filter((c) => c.status !== 'open').length})`}
        </button>
      )}
      <textarea className="vtextarea" rows={2} value={text} placeholder={target ? 'Comment on this' : 'A comment or request, for example “make Drop 2 more purple”'} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => {
        keep(event)
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) add()
      }} />
      <div className="insp-row">
        <button type="button" className="chip-btn" disabled={!text.trim()} onClick={add}>
          Add comment
        </button>
      </div>
    </section>
  )
}

/** A still or overview, large, with its comments. */
export function StillViewer({ board, fileId, onClose }: { board: studio.Storyboard; fileId: string; onClose: () => void }) {
  const file = useStudio((s) => s.project.video?.files[fileId])
  const barSeconds = useStudio((s) => studio.barSeconds(s.project))
  if (!file) return null
  return (
    <div className="modal-backdrop" onPointerDown={onClose}>
      <div className="modal video-still-modal" role="dialog" aria-modal="true" aria-label={file.name} onPointerDown={(event) => event.stopPropagation()}>
        <header>
          <h2>{file.name.replace(/\.png$/, '').replace(/^Contact sheet/, 'Overview')}</h2>
          <button type="button" className="icon-btn" aria-label="Close the still" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <div className="modal-body video-still-body">
          <StoredImage fileId={fileId} alt={file.name} className="video-still-large" />
          <div className="video-still-side">
            <div className="insp-row">
              {file.seconds !== null && (
                <button type="button" className="chip-btn" onClick={() => engine.seek(file.seconds! / barSeconds)}>
                  Jump to {file.seconds.toFixed(1)} s
                </button>
              )}
              <button
                type="button"
                className="chip-btn danger"
                onClick={() => {
                  dispatch({ type: 'video.file.remove', params: { fileId } }, { label: 'Remove still' })
                  onClose()
                }}
              >
                Remove
              </button>
            </div>
            <Comments board={board} target={{ kind: 'still', fileId }} title="Comments on this" />
          </div>
        </div>
      </div>
    </div>
  )
}
