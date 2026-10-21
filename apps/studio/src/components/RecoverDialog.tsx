import { RotateCcw, Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { AutosaveEntry } from '@reborn/studio-core'
import { desktop } from '../platform/desktop'
import { recoverAutosave } from '../state/persistence'
import { useStudio } from '../state/store'

const when = (iso: string) => {
  const date = new Date(iso)
  const today = new Date().toDateString() === date.toDateString()
  return today ? `today at ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
}

/** File > Recover Unsaved Work: the latest unsaved state of each recent project. */
export function RecoverDialog({ onClose }: { onClose: () => void }) {
  const [entries, setEntries] = useState<AutosaveEntry[] | null>(null)
  const openId = useStudio((s) => s.project.id)
  const load = () => void desktop?.listAutosaves().then(setEntries)
  useEffect(load, [])
  return (
    <div className="modal-backdrop" onPointerDown={onClose}>
      <div className="modal recover" role="dialog" aria-modal="true" aria-label="Recover unsaved work" onPointerDown={(event) => event.stopPropagation()} onKeyDown={(event) => event.key === 'Escape' && onClose()}>
        <header>
          <h2>Recover unsaved work</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>
        <div className="modal-body">
          <p className="muted small">RE:BORN keeps the latest unsaved changes of your last 20 projects, even after a crash, a closed window, or starting a new project. Saving a project clears its copy.</p>
          {entries === null && <p className="muted">Looking for unsaved work…</p>}
          {entries?.length === 0 && <p className="muted">No unsaved work. Everything you changed is saved.</p>}
          {entries && entries.length > 0 && (
            <ul className="recover-list">
              {entries.map((entry) => (
                <li key={entry.id}>
                  <div>
                    <strong>{entry.name || 'Untitled'}</strong>
                    {entry.id === openId && <span className="badge">Open now</span>}
                    <small>
                      Changed {when(entry.savedAt)} · {entry.tracks} tracks, {entry.bars} bars · {entry.path ?? 'never saved'}
                    </small>
                  </div>
                  <button type="button" className="chip-btn primary" onClick={() => void recoverAutosave(entry.id).then((ok) => ok && onClose())}>
                    <RotateCcw size={13} />
                    Restore
                  </button>
                  <button type="button" className="icon-btn" aria-label={`Delete the unsaved copy of ${entry.name || 'Untitled'}`} title="Delete this copy" onClick={() => void desktop?.deleteAutosave(entry.id).then(load)}>
                    <Trash2 size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
