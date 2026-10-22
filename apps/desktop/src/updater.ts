import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateEvent } from '@reborn/studio-core/platform'
import { notesToText } from './update-notes'

// Updates come from GitHub Releases (see electron-builder.yml). The app asks
// before it downloads: autoDownload is off, the studio shows a prompt, and a
// downloaded update installs on Restart now or the next quit. Only installed
// builds check; development runs and end-to-end tests never do. On Linux only
// the AppImage can update itself, so other Linux builds don't check.

export interface Updater {
  /** Looks for a newer release and reports every step, including errors. */
  check(): Promise<void>
  download(): Promise<void>
  install(): void
  /** The last event, for a page that loads after the startup check reported. */
  current(): UpdateEvent | null
  /** Sends a fake event, for development and tests. */
  simulate(event: UpdateEvent): void
}

interface UpdaterOptions {
  /** Delivers an event to the studio. */
  send: (event: UpdateEvent) => void
  log: (message: string) => void
}

export function createUpdater({ send, log }: UpdaterOptions): Updater {
  const enabled = app.isPackaged && process.env.REBORN_E2E !== '1' && process.env.REBORN_UPDATES !== 'off' && (process.platform !== 'linux' || Boolean(process.env.APPIMAGE))
  let last: UpdateEvent | null = null
  // The startup check stays quiet unless it finds an update; a check you ask
  // for reports checking, up to date, and errors too.
  let userInitiated = false

  const emit = (event: UpdateEvent) => {
    last = event
    send(event)
  }
  const fail = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error ?? 'Unknown update error')
    log(`[update] ${message}`)
    if (userInitiated) emit({ type: 'error', message })
  }

  if (enabled) {
    autoUpdater.logger = { info: (m: unknown) => log(`[update] ${String(m)}`), warn: (m: unknown) => log(`[update] ${String(m)}`), error: (m: unknown) => log(`[update] ${String(m)}`), debug: () => undefined }
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.on('checking-for-update', () => {
      if (userInitiated) emit({ type: 'checking' })
    })
    autoUpdater.on('update-available', (info) => emit({ type: 'available', version: info.version, releaseNotes: notesToText(info.releaseNotes) }))
    autoUpdater.on('update-not-available', () => {
      if (userInitiated) emit({ type: 'not-available' })
    })
    autoUpdater.on('download-progress', (progress) => emit({ type: 'downloading', percent: progress.percent }))
    autoUpdater.on('update-downloaded', (info) => emit({ type: 'downloaded', version: info.version }))
    autoUpdater.on('error', fail)
    void autoUpdater.checkForUpdates().catch(fail)
  }

  return {
    async check() {
      userInitiated = true
      if (!enabled) return emit({ type: 'error', message: 'Updates are checked in installed builds only.' })
      await autoUpdater.checkForUpdates().catch(fail)
    },
    async download() {
      userInitiated = true
      if (!enabled) return
      await autoUpdater.downloadUpdate().catch(fail)
    },
    install() {
      if (enabled) autoUpdater.quitAndInstall()
    },
    current: () => last,
    simulate: emit,
  }
}
