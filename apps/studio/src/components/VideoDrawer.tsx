import { Search, Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { type FootageCandidate, studio } from '@reborn/studio-core'
import { LOOKS } from '@reborn/video'
import { desktop } from '../platform/desktop'
import { dispatch, toast, useStudio } from '../state/store'
import { addLibraryFootage, applyPreset, createFromTemplate, keepSuggestion, presetPreview, removeLibraryItem, saveFootage, savePreset, saveTemplate, useLibrary } from '../video/library'
import { addCandidates, approveAndDownload, downloadClip, footageAvailable, footageBudgetOf, searchFootage } from '../video/stock'

// The Video view's drawer: the look catalog, the Visual Library (presets,
// templates, footage, and suggestions to keep), and stock footage search
// with review. Footage downloads only after the user approves a clip.

export type DrawerTab = 'looks' | 'library' | 'footage'

const keep = (event: { stopPropagation: () => void }) => event.stopPropagation()

const LICENCE_LABELS: Record<studio.LicenceKind, string> = { cc0: 'CC0', pd: 'Public domain', pexels: 'Pexels', pixabay: 'Pixabay', 'cc-by': 'CC BY', 'cc-by-sa': 'CC BY-SA', other: 'Other' }

function Preview({ item }: { item: studio.LibraryItem }) {
  const [src, setSrc] = useState(item.preview)
  useEffect(() => {
    let alive = true
    if (!item.preview && item.preset) void presetPreview(item).then((url) => alive && setSrc(url))
    return () => {
      alive = false
    }
  }, [item])
  return src ? <img className="vlib-preview" src={src} alt="" /> : <span className="vlib-preview is-loading" />
}

function useSelectedScene(): string | null {
  return useStudio((s) => (s.selection.kind === 'videoScene' ? s.selection.sceneId : null))
}

function LooksTab() {
  const sceneId = useSelectedScene()
  const items = LOOKS.map((look): studio.LibraryItem => ({ id: `look-${look.id}`, kind: 'preset', name: look.title, version: 1, fits: [], tags: look.mood, description: look.description, builtin: true, createdAt: '', updatedAt: '', source: null, preview: '', pending: null, preset: { look: look.id, params: {}, layers: [], post: {}, travel: { base: 0.6, kick: 1.5, snare: 1, bass: 0.4 }, cutOn: look.id === 'strobe-deck' || look.id.startsWith('footage') ? ['kick', 'snare'] : [], xfade: 0 } }))
  return (
    <ul className="vlib-list">
      {items.map((item) => {
        const look = LOOKS.find((l) => `look-${l.id}` === item.id)!
        return (
          <li key={item.id} className="vlib-item">
            <Preview item={item} />
            <div>
              <b>{look.title}</b>
              <span className="muted small">{look.layer ? 'Layer · ' : ''}{look.fits.join(', ')}</span>
              <p className="small">{look.description}</p>
              {!look.layer && (
                <button type="button" className="chip-btn" disabled={!sceneId} title={sceneId ? undefined : 'Select a scene first'} onClick={() => sceneId && dispatch({ type: 'video.scene.update', params: { sceneId, look: look.id } }, { label: `Use ${look.title}` })}>
                  Use for scene
                </button>
              )}
            </div>
          </li>
        )
      })}
    </ul>
  )
}

function LibraryTab({ board }: { board: studio.Storyboard }) {
  const items = useLibrary()
  const sceneId = useSelectedScene()
  const [kind, setKind] = useState<studio.LibraryKind>('preset')
  const [text, setText] = useState('')
  const [name, setName] = useState('')
  const pending = items.filter((item) => item.pending)
  const words = text.toLowerCase().split(/\s+/).filter(Boolean)
  const shown = items.filter((item) => !item.pending && item.kind === kind && words.every((w) => [item.name, item.description, ...item.tags, ...item.fits].join(' ').toLowerCase().includes(w)))
  const scene = sceneId ? board.scenes.find((s) => s.id === sceneId) : null
  const run = (work: Promise<unknown>, done: string) => void work.then(() => toast(done, 'success')).catch((error: unknown) => toast(error instanceof Error ? error.message : String(error), 'error'))
  return (
    <>
      {pending.length > 0 && (
        <section className="vlib-suggest">
          <h3>Suggested for the library</h3>
          <ul className="vlib-list">
            {pending.map((item) => (
              <li key={item.id} className="vlib-item">
                <Preview item={item} />
                <div>
                  <b>{item.name}</b>
                  <span className="muted small">
                    {item.kind} · {item.pending!.proposedBy === 'director' ? 'from the Director' : 'from you'}
                  </span>
                  <p className="small">{item.pending!.reason}</p>
                  <div className="insp-row">
                    <button type="button" className="chip-btn primary" onClick={() => run(keepSuggestion(item.id), `Kept ${item.name}`)}>
                      Keep
                    </button>
                    <button type="button" className="chip-btn" onClick={() => run(removeLibraryItem(item.id), 'Dismissed')}>
                      Dismiss
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="vlib-filter">
        <div className="insp-row" role="tablist" aria-label="Library kind">
          {(['preset', 'template', 'footage'] as const).map((k) => (
            <button key={k} type="button" role="tab" aria-selected={kind === k} className={`chip-btn${kind === k ? ' is-on' : ''}`} onClick={() => setKind(k)}>
              {k === 'preset' ? 'Presets' : k === 'template' ? 'Templates' : 'Footage'}
            </button>
          ))}
        </div>
        <input type="search" value={text} placeholder="Search name, mood, tags" aria-label="Search the library" onChange={(event) => setText(event.target.value)} onKeyDown={keep} />
      </div>
      <ul className="vlib-list">
        {shown.length === 0 && <li className="muted small">Nothing here yet.</li>}
        {shown.map((item) => (
          <li key={item.id} className="vlib-item">
            <Preview item={item} />
            <div>
              <b>{item.name}</b>
              <span className="muted small">
                {item.builtin ? 'Built in' : `Version ${item.version}${item.source ? ` · from ${item.source.project}` : ''}`}
                {item.fits.length > 0 && ` · ${item.fits.join(', ')}`}
              </span>
              {item.description && <p className="small">{item.description}</p>}
              <div className="insp-row">
                {item.kind === 'preset' && (
                  <button type="button" className="chip-btn" disabled={!sceneId} title={sceneId ? undefined : 'Select a scene first'} onClick={() => sceneId && applyPreset(item, sceneId)}>
                    Apply to scene
                  </button>
                )}
                {item.kind === 'template' && (
                  <button type="button" className="chip-btn" onClick={() => createFromTemplate(item)}>
                    New storyboard
                  </button>
                )}
                {item.kind === 'footage' && (
                  <button type="button" className="chip-btn" disabled={!board.brief.footage.enabled} title={board.brief.footage.enabled ? undefined : 'Turn footage on in the brief'} onClick={() => void addLibraryFootage(item, board.id)}>
                    Add to storyboard
                  </button>
                )}
                {!item.builtin && (
                  <button type="button" className="icon-btn sm" aria-label={`Delete ${item.name}`} onClick={() => run(removeLibraryItem(item.id), `Deleted ${item.name}`)}>
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
      <section className="vlib-save">
        <h3>Save to the library</h3>
        <input type="text" value={name} placeholder={scene ? `${scene.name || 'Scene'} preset` : `${board.name} template`} aria-label="Name for the library item" onChange={(event) => setName(event.target.value)} onKeyDown={keep} />
        <div className="insp-row">
          <button type="button" className="chip-btn" disabled={!scene} title={scene ? undefined : 'Select a scene first'} onClick={() => scene && run(savePreset(scene.id, { name: name || `${scene.name || 'Scene'} preset` }).then(() => setName('')), 'Saved the preset')}>
            Scene as preset
          </button>
          <button type="button" className="chip-btn" onClick={() => run(saveTemplate(board.id, { name: name || `${board.name} template` }).then(() => setName('')), 'Saved the template')}>
            Storyboard as template
          </button>
        </div>
      </section>
    </>
  )
}

function FootageKeys() {
  const [status, setStatus] = useState<{ pexels: boolean; pixabay: boolean } | null>(null)
  const [keys, setKeys] = useState({ pexels: '', pixabay: '' })
  useEffect(() => {
    void desktop?.footageKeys().then(setStatus)
  }, [])
  if (!desktop || !status) return null
  const save = async (name: 'pexels' | 'pixabay', value: string | null) => {
    setStatus(await desktop!.footageSetKeys({ [name]: value }))
    setKeys((k) => ({ ...k, [name]: '' }))
  }
  return (
    <details className="vfoot-keys">
      <summary>API keys {status.pexels && status.pixabay ? '' : `(${[!status.pexels && 'Pexels', !status.pixabay && 'Pixabay'].filter(Boolean).join(' and ')} need one)`}</summary>
      <p className="muted small">Pexels and Pixabay need a free API key. Keys are kept in your system's credential store. Wikimedia Commons and the Internet Archive need none.</p>
      {(['pexels', 'pixabay'] as const).map((name) => (
        <div key={name} className="insp-row">
          <input type="password" value={keys[name]} placeholder={status[name] ? `${name} key saved` : `${name} API key`} aria-label={`${name} API key`} onChange={(event) => setKeys((k) => ({ ...k, [name]: event.target.value }))} onKeyDown={keep} />
          <button type="button" className="chip-btn" disabled={!keys[name].trim()} onClick={() => void save(name, keys[name])}>
            Save
          </button>
          {status[name] && (
            <button type="button" className="chip-btn" onClick={() => void save(name, null)}>
              Remove
            </button>
          )}
        </div>
      ))}
    </details>
  )
}

function FootageTab({ board }: { board: studio.Storyboard }) {
  const project = useStudio((s) => s.project)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<FootageCandidate[]>([])
  const [errors, setErrors] = useState<{ provider: string; message: string }[]>([])
  if (!footageAvailable()) return <p className="muted small vlib-pad">Footage search and downloads run in the desktop app.</p>
  if (!board.brief.footage.enabled) {
    return (
      <div className="vlib-pad">
        <p className="muted small">Footage is off for this storyboard. With it on, you can search Pexels, Pixabay, Wikimedia Commons, and the Internet Archive. Only free-to-use licences are allowed unless you widen them in the brief, and nothing downloads until you approve a clip.</p>
        <button type="button" className="chip-btn primary" onClick={() => dispatch({ type: 'video.storyboard.update', params: { storyboardId: board.id, brief: { footage: { enabled: true } } } }, { label: 'Allow footage' })}>
          Turn footage on
        </button>
      </div>
    )
  }
  const search = async () => {
    if (!query.trim()) return
    setBusy(true)
    try {
      const found = await searchFootage(board.id, query.trim())
      setResults(found.candidates)
      setErrors(found.errors)
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setBusy(false)
    }
  }
  const known = new Set(board.footage.map((c) => `${c.provider}:${c.sourceId}`))
  const budget = footageBudgetOf(project, board)
  const groups: [string, studio.FootageClip[]][] = [
    ['To review', board.footage.filter((c) => c.status === 'candidate')],
    ['Approved', board.footage.filter((c) => c.status === 'approved')],
    ['Downloaded', board.footage.filter((c) => c.status === 'fetched')],
  ]
  return (
    <>
      <form
        className="vlib-filter"
        onSubmit={(event) => {
          event.preventDefault()
          void search()
        }}
      >
        <input type="search" value={query} placeholder="What to show, for example “lightning storm”" aria-label="Search footage" onChange={(event) => setQuery(event.target.value)} onKeyDown={keep} />
        <button type="submit" className="chip-btn" disabled={busy || !query.trim()}>
          <Search size={13} /> {busy ? 'Searching…' : 'Search'}
        </button>
      </form>
      <FootageKeys />
      <p className="muted small vlib-pad">
        Downloaded {budget.clips} of {budget.maxClips} clips, {budget.megabytes.toFixed(0)} of {budget.maxMegabytes} MB. Keyword search is literal: check every clip before you approve it.
      </p>
      {errors.map((e) => (
        <p key={e.provider} className="small vfoot-error">
          {e.provider}: {e.message}
        </p>
      ))}
      {results.length > 0 && (
        <section>
          <h3 className="vlib-head">
            Results
            <button type="button" className="chip-btn" onClick={() => addCandidates(board.id, results.filter((c) => !known.has(`${c.provider}:${c.sourceId}`)), 'user')}>
              Add all to review
            </button>
          </h3>
          <ul className="vfoot-grid">
            {results.map((c) => {
              const added = known.has(`${c.provider}:${c.sourceId}`)
              return (
                <li key={`${c.provider}:${c.sourceId}`}>
                  {c.thumbnail ? <img src={c.thumbnail} alt="" /> : <span className="is-loading" />}
                  <span className="vfoot-title" title={c.title}>
                    {c.title}
                  </span>
                  <span className="muted small">
                    {c.provider} · {LICENCE_LABELS[c.licence]} · {c.duration ? `${Math.round(c.duration)} s` : '?'} · {c.height}p
                  </span>
                  <button type="button" className="chip-btn" disabled={added} onClick={() => addCandidates(board.id, [c], 'user')}>
                    {added ? 'Added' : 'Add to review'}
                  </button>
                </li>
              )
            })}
          </ul>
        </section>
      )}
      {groups.map(([title, clips]) =>
        clips.length ? (
          <section key={title}>
            <h3 className="vlib-head">{title}</h3>
            <ul className="vlib-list">
              {clips.map((clip) => (
                <li key={clip.id} className="vlib-item">
                  {clip.thumbnail ? <img className="vlib-preview" src={clip.thumbnail} alt="" /> : <span className="vlib-preview is-loading" />}
                  <div>
                    <b title={clip.title}>{clip.title}</b>
                    <span className="muted small">
                      {LICENCE_LABELS[clip.licence]} · {clip.author || 'unknown author'} · {clip.proposedBy === 'director' ? 'found by the Director' : clip.query}
                    </span>
                    <a className="small" href={clip.page} target="_blank" rel="noreferrer">
                      Source page
                    </a>
                    <div className="insp-row">
                      {clip.status === 'candidate' && (
                        <>
                          <button type="button" className="chip-btn primary" onClick={() => void approveAndDownload(clip.id)}>
                            Approve and download
                          </button>
                          <button type="button" className="chip-btn" onClick={() => dispatch({ type: 'video.footage.review', params: { clipId: clip.id, status: 'rejected' } }, { label: 'Reject clip' })}>
                            Reject
                          </button>
                        </>
                      )}
                      {clip.status === 'approved' && (
                        <button type="button" className="chip-btn" onClick={() => void downloadClip(clip.id).catch((error: unknown) => toast(error instanceof Error ? error.message : String(error), 'error'))}>
                          Download
                        </button>
                      )}
                      {clip.status === 'fetched' && (
                        <>
                          <label className="vfoot-skip">
                            Skip
                            <input type="number" min={0} step={0.5} defaultValue={clip.skip} key={clip.skip} aria-label="Seconds to skip at the start" onKeyDown={keep} onBlur={(event) => Number(event.target.value) !== clip.skip && dispatch({ type: 'video.footage.update', params: { clipId: clip.id, skip: Number(event.target.value) || 0 } }, { label: 'Change clip skip' })} />s
                          </label>
                          <button type="button" className="chip-btn" onClick={() => void saveFootage(clip.id).then(() => toast('Saved the clip to the library', 'success')).catch((error: unknown) => toast(String(error), 'error'))}>
                            Save to library
                          </button>
                        </>
                      )}
                      <button type="button" className="icon-btn sm" aria-label={`Remove ${clip.title}`} onClick={() => dispatch({ type: 'video.footage.remove', params: { clipId: clip.id } }, { label: 'Remove clip' })}>
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ) : null,
      )}
    </>
  )
}

export function VideoDrawer({ board, tab, onTab, onClose }: { board: studio.Storyboard; tab: DrawerTab; onTab: (tab: DrawerTab) => void; onClose: () => void }) {
  return (
    <aside className="video-drawer" aria-label="Looks, library, and footage">
      <header>
        <div className="insp-row" role="tablist" aria-label="Drawer">
          {(['looks', 'library', 'footage'] as const).map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} className={`chip-btn${tab === t ? ' is-on' : ''}`} onClick={() => onTab(t)}>
              {t === 'looks' ? 'Looks' : t === 'library' ? 'Library' : 'Footage'}
            </button>
          ))}
        </div>
        <button type="button" className="icon-btn" aria-label="Close the drawer" onClick={onClose}>
          <X size={15} />
        </button>
      </header>
      <div className="video-drawer-body">
        {tab === 'looks' && <LooksTab />}
        {tab === 'library' && <LibraryTab board={board} />}
        {tab === 'footage' && <FootageTab board={board} />}
      </div>
    </aside>
  )
}
