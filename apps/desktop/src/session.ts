import { appendFile, mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AutosaveEntry, LogLevel, ProjectState, RecentProject, RecoveryState, studio } from '@reborn/studio-core'
import { writeAtomic } from './project-dir'

// Per-user desktop state that never belongs inside a project: recent files,
// crash-recovery snapshots, and the log.

const RECENT_LIMIT = 10
/** Autosaves kept, newest first; older ones are deleted. */
export const AUTOSAVE_LIMIT = 20
const AUTOSAVE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
const LOG_LIMIT = 1024 * 1024

export class SessionStore {
  private readonly recentFile: string
  private readonly recoveryFile: string
  private readonly lockFile: string
  private readonly logFile: string
  private readonly autosaveDir: string
  private recoveryWrite: Promise<void> = Promise.resolve()
  private autosaveWrite: Promise<void> = Promise.resolve()
  /** True when the previous session ended without a clean shutdown. */
  crashed = false

  constructor(private readonly directory: string) {
    this.recentFile = join(directory, 'recent.json')
    this.recoveryFile = join(directory, 'recovery', 'current.json')
    this.lockFile = join(directory, 'session.lock')
    this.logFile = join(directory, 'logs', 'reborn.log')
    this.autosaveDir = join(directory, 'autosave')
  }

  private autosaveFile(id: string): string | null {
    // Project IDs are word characters and dashes; anything else is refused.
    return /^[\w-]+$/.test(String(id)) ? join(this.autosaveDir, `${id}.json`) : null
  }

  /** Keeps the latest unsaved state of one project, then prunes old autosaves. */
  writeAutosave(project: studio.StudioProject, path: string | null): Promise<void> {
    const file = this.autosaveFile(project.id)
    if (!file) return Promise.resolve()
    const entry = { studio: project, path, savedAt: new Date().toISOString() }
    this.autosaveWrite = this.autosaveWrite
      .then(async () => {
        await mkdir(this.autosaveDir, { recursive: true })
        await writeAtomic(file, JSON.stringify(entry))
        await this.pruneAutosaves()
      })
      .catch((error: unknown) => this.log('error', `Autosave failed: ${String(error)}`))
    return this.autosaveWrite
  }

  async deleteAutosave(id: string): Promise<void> {
    await this.autosaveWrite
    const file = this.autosaveFile(id)
    if (file) await rm(file, { force: true })
  }

  async listAutosaves(): Promise<AutosaveEntry[]> {
    await this.autosaveWrite
    let names: string[] = []
    try {
      names = (await readdir(this.autosaveDir)).filter((name) => name.endsWith('.json'))
    } catch {
      return []
    }
    const entries: AutosaveEntry[] = []
    for (const name of names) {
      try {
        const { studio: project, path, savedAt } = JSON.parse(await readFile(join(this.autosaveDir, name), 'utf8')) as { studio: studio.StudioProject; path: string | null; savedAt: string }
        entries.push({ id: project.id, name: project.name, path, savedAt, tracks: project.tracks.length, bars: project.length })
      } catch {
        // A damaged autosave is skipped; pruning removes it in time.
      }
    }
    return entries.sort((a, b) => b.savedAt.localeCompare(a.savedAt))
  }

  async readAutosave(id: string): Promise<{ studio: studio.StudioProject; path: string | null } | null> {
    const file = this.autosaveFile(id)
    if (!file || !existsSync(file)) return null
    const { studio: project, path } = JSON.parse(await readFile(file, 'utf8')) as { studio: studio.StudioProject; path: string | null }
    return { studio: project, path }
  }

  private async pruneAutosaves(): Promise<void> {
    const files = await Promise.all(
      (await readdir(this.autosaveDir)).filter((name) => name.endsWith('.json')).map(async (name) => ({ name, mtime: (await stat(join(this.autosaveDir, name))).mtimeMs })),
    )
    files.sort((a, b) => b.mtime - a.mtime)
    const now = Date.now()
    for (const [index, file] of files.entries()) {
      if (index >= AUTOSAVE_LIMIT || now - file.mtime > AUTOSAVE_MAX_AGE_MS) await rm(join(this.autosaveDir, file.name), { force: true })
    }
  }

  async start(): Promise<void> {
    await mkdir(join(this.directory, 'recovery'), { recursive: true })
    await mkdir(join(this.directory, 'logs'), { recursive: true })
    this.crashed = existsSync(this.lockFile) && existsSync(this.recoveryFile)
    await writeAtomic(this.lockFile, String(process.pid))
    await this.log('info', `Session started${this.crashed ? ' after an unclean shutdown' : ''}.`)
  }

  /** Marks a clean shutdown. Recovery data is discarded only here. */
  async finish(): Promise<void> {
    await this.recoveryWrite
    await rm(this.recoveryFile, { force: true })
    await rm(this.lockFile, { force: true })
    await this.log('info', 'Session ended cleanly.')
  }

  async listRecent(): Promise<RecentProject[]> {
    try {
      const items = JSON.parse(await readFile(this.recentFile, 'utf8')) as RecentProject[]
      return Array.isArray(items) ? items.filter((item) => typeof item.path === 'string' && existsSync(item.path)) : []
    } catch {
      return []
    }
  }

  async addRecent(path: string, name: string): Promise<RecentProject[]> {
    const items = [{ path, name, openedAt: new Date().toISOString() }, ...(await this.listRecent()).filter((item) => item.path !== path)].slice(0, RECENT_LIMIT)
    await writeAtomic(this.recentFile, JSON.stringify(items, null, 2))
    return items
  }

  writeRecovery(content: { project?: ProjectState; studio?: studio.StudioProject }, path: string | null): Promise<void> {
    const state: RecoveryState = { ...content, path, savedAt: new Date().toISOString() }
    this.recoveryWrite = this.recoveryWrite.then(() => writeAtomic(this.recoveryFile, JSON.stringify(state))).catch((error: unknown) => this.log('error', `Recovery write failed: ${String(error)}`))
    return this.recoveryWrite
  }

  /** Returns the snapshot from a crashed session once, then clears the flag. */
  async takeRecovery(): Promise<RecoveryState | null> {
    if (!this.crashed) return null
    this.crashed = false
    try {
      const state = JSON.parse(await readFile(this.recoveryFile, 'utf8')) as RecoveryState
      await this.log('info', `Offered recovery snapshot from ${state.savedAt}.`)
      return state
    } catch (error) {
      await this.log('warn', `Recovery snapshot unreadable: ${String(error)}`)
      return null
    }
  }

  async log(level: LogLevel, message: string): Promise<void> {
    const line = `${new Date().toISOString()} ${level.toUpperCase()} ${message.replace(/\s+/g, ' ').slice(0, 2000)}\n`
    try {
      if (existsSync(this.logFile) && (await stat(this.logFile)).size > LOG_LIMIT) await rename(this.logFile, `${this.logFile}.1`)
      await appendFile(this.logFile, line)
    } catch {
      // Logging must never take the app down.
    }
  }
}
