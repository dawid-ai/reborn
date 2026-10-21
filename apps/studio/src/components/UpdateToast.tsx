import { CircleArrowUp, CircleCheck, CloudDownload, RefreshCw, TriangleAlert } from 'lucide-react'
import { type ReactNode, useEffect } from 'react'
import { desktop } from '../platform/desktop'
import { useUpdates } from '../state/updates'

function Head({ icon, label, children }: { icon: ReactNode; label: string; children?: ReactNode }) {
  return (
    <div className="update-head">
      <span className="update-icon" aria-hidden="true">
        {icon}
      </span>
      <div>
        <p className="update-label">{label}</p>
        {children}
      </div>
    </div>
  )
}

/**
 * The app update prompt, bottom right. It follows an update from available
 * through download to Restart now. A check you start from Help also shows
 * checking, up to date, and errors.
 */
export function UpdateToast() {
  const { state, dismiss } = useUpdates()

  // "Up to date" needs no action; it clears itself.
  useEffect(() => {
    if (state.kind !== 'not-available') return
    const timer = setTimeout(dismiss, 4000)
    return () => clearTimeout(timer)
  }, [state.kind, dismiss])

  if (!desktop || state.kind === 'idle') return null
  const tone = state.kind === 'downloaded' || state.kind === 'not-available' ? 'done' : state.kind === 'error' ? 'failed' : 'pending'

  return (
    <section className={`update-toast is-${tone}`} aria-label="App update" aria-live="polite" data-testid="update-toast">
      {state.kind === 'checking' && <Head icon={<RefreshCw size={16} />} label="Checking for updates…" />}
      {state.kind === 'not-available' && <Head icon={<CircleCheck size={16} />} label="RE:BORN is up to date" />}
      {state.kind === 'available' && (
        <>
          <Head icon={<CircleArrowUp size={16} />} label="Update available">
            <strong className="update-version">v{state.version}</strong>
          </Head>
          {state.releaseNotes && <p className="update-notes">{state.releaseNotes}</p>}
          <div className="update-actions">
            <button type="button" className="chip-btn primary" onClick={() => void desktop?.updateDownload()}>
              <CloudDownload size={13} />
              Update now
            </button>
            <button type="button" className="chip-btn" onClick={dismiss}>
              Later
            </button>
          </div>
        </>
      )}
      {state.kind === 'downloading' && (
        <>
          <Head icon={<CloudDownload size={16} />} label="Downloading update">
            <strong className="update-version">{Math.round(state.percent)}%</strong>
          </Head>
          <div className="update-progress" role="progressbar" aria-label="Update download" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(state.percent)}>
            <i style={{ width: `${Math.round(state.percent)}%` }} />
          </div>
        </>
      )}
      {state.kind === 'downloaded' && (
        <>
          <Head icon={<CircleCheck size={16} />} label="Ready to install">
            <strong className="update-version">v{state.version}</strong>
          </Head>
          <p className="update-text">The update installs when RE:BORN restarts. Save your work first.</p>
          <div className="update-actions">
            <button type="button" className="chip-btn primary" onClick={() => void desktop?.updateInstall()}>
              Restart now
            </button>
            <button type="button" className="chip-btn" onClick={dismiss}>
              Later
            </button>
          </div>
        </>
      )}
      {state.kind === 'error' && (
        <>
          <Head icon={<TriangleAlert size={16} />} label="Update failed">
            <p className="update-text">{state.message}</p>
          </Head>
          <div className="update-actions">
            <button type="button" className="chip-btn primary" onClick={() => void desktop?.updateCheck()}>
              <RefreshCw size={13} />
              Retry
            </button>
            <button type="button" className="chip-btn" onClick={dismiss}>
              Dismiss
            </button>
          </div>
        </>
      )}
      {(state.kind === 'checking' || state.kind === 'not-available') && (
        <div className="update-actions">
          <button type="button" className="chip-btn" onClick={dismiss}>
            Dismiss
          </button>
        </div>
      )}
    </section>
  )
}
