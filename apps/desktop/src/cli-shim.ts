import { existsSync } from 'node:fs'
import { chmod, copyFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// `reborn` on PATH: a shim that runs the bundled CLI with the app's own
// Electron binary in Node mode, so no separate Node.js install is needed.
// Windows gets a .cmd file; Linux gets a POSIX shell script.

const quote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`

export function shimContents(executable: string, cliBundle: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return ['@echo off', 'setlocal', 'set ELECTRON_RUN_AS_NODE=1', `"${executable}" "${cliBundle}" %*`, ''].join('\r\n')
  // The AppImage launcher adds --no-sandbox ahead of the arguments when user
  // namespaces are unavailable, and Node mode rejects it there. Passing it
  // after the script stops that; the CLI drops it.
  return ['#!/bin/sh', `ELECTRON_RUN_AS_NODE=1 exec ${quote(executable)} ${quote(cliBundle)} --no-sandbox "$@"`, ''].join('\n')
}

/**
 * The user's WindowsApps folder is on PATH by default on Windows 10 and 11,
 * and ~/.local/bin is the usual user command folder on Linux. Falls back to a
 * folder the user adds to PATH themselves.
 */
export function shimDirectory(env: NodeJS.ProcessEnv, fallback: string, platform: NodeJS.Platform = process.platform): { dir: string; onPath: boolean } {
  if (platform === 'win32') {
    const windowsApps = env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps') : null
    if (windowsApps && existsSync(windowsApps)) return { dir: windowsApps, onPath: true }
    return { dir: fallback, onPath: false }
  }
  if (!env.HOME) return { dir: fallback, onPath: false }
  const dir = join(env.HOME, '.local', 'bin')
  return { dir, onPath: (env.PATH ?? '').split(':').includes(dir) }
}

export async function installCliShim(dir: string, executable: string, cliBundle: string, platform: NodeJS.Platform = process.platform): Promise<string> {
  await mkdir(dir, { recursive: true })
  const target = join(dir, platform === 'win32' ? 'reborn.cmd' : 'reborn')
  await writeFile(target, shimContents(executable, cliBundle, platform))
  if (platform !== 'win32') await chmod(target, 0o755)
  return target
}

/**
 * An AppImage mounts its files at a new temporary path on every launch, so a
 * shim can't point into it. The shim runs the AppImage itself and a copy of
 * the CLI bundle kept here, which the app refreshes at startup after updates.
 */
export async function copyCliBundle(cliBundle: string, dir: string): Promise<string> {
  await mkdir(dir, { recursive: true })
  const target = join(dir, 'reborn.mjs')
  await copyFile(cliBundle, target)
  return target
}
