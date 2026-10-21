// End-to-end check of the desktop edition (v2 studio in Electron).
// Covers native save/open/pack/export/recovery, the local API with the CLI
// and MCP adapters, and the Python sidecar failing without affecting
// playback. Run `npm run desktop:build` first.
import { _electron as electron } from 'playwright'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const OUT = resolve('artifacts/desktop-e2e')
const USER_DATA = join(OUT, 'user-data')
const PROJECT_DIR = join(OUT, 'Desktop Smoke.reborn')
const WAV = join(OUT, 'desktop-smoke.wav')
const PACK = join(OUT, 'Desktop Smoke.rebornpack')
const SAMPLE = resolve('apps/studio/public/audio/starter/bd_808.ogg')
const CLI = resolve('packages/cli/bin/reborn.mjs')
await rm(OUT, { recursive: true, force: true })
await mkdir(OUT, { recursive: true })

const failures = []
const check = (ok, message) => {
  if (!ok) failures.push(message)
}
const env = { ...process.env, REBORN_E2E: '1', REBORN_USER_DATA: USER_DATA, REBORN_E2E_SAVE_PATH: PROJECT_DIR, REBORN_E2E_WAV_PATH: WAV, REBORN_E2E_PACK_PATH: PACK }
const until = async (predicate, message, timeout = 30_000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate().catch(() => false)) return true
    await new Promise((r) => setTimeout(r, 150))
  }
  failures.push(`timed out: ${message}`)
  return false
}

async function launch() {
  const app = await electron.launch({ args: ['apps/desktop'], env })
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.waitForSelector('.transport')
  // CI screens are about 1024 px wide, which clamps the window below the wide
  // layout and opens the panels as overlays. Zooming out keeps a 1440 px
  // layout on any screen. SMOKE_WINDOW=1000x740 reproduces a small screen.
  await app.evaluate(({ BrowserWindow }, size) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (size) win.setSize(...size)
    const [width] = win.getContentSize()
    if (width < 1440) win.webContents.setZoomFactor(width / 1440)
  }, process.env.SMOKE_WINDOW?.split('x').map(Number))
  await page.waitForFunction(() => window.innerWidth >= 1400)
  const menu = (command, path) => app.evaluate(({ BrowserWindow }, event) => BrowserWindow.getAllWindows()[0].webContents.send('menu:command', event), path ? { command, path } : { command })
  const title = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle())
  const state = (fn) => page.evaluate(fn)
  return { app, page, errors, menu, title, state }
}

const cli = (...args) => execFileSync(process.execPath, [CLI, ...args], { env: { ...process.env, REBORN_API_FILE: join(USER_DATA, 'api.json') }, encoding: 'utf8', timeout: 60_000 })

function mcpSession(args = []) {
  const child = spawn(process.execPath, [CLI, 'mcp', ...args], { env: { ...process.env, REBORN_API_FILE: join(USER_DATA, 'api.json') }, stdio: ['pipe', 'pipe', 'pipe'] })
  let buffer = ''
  const waiting = new Map()
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line) continue
      const message = JSON.parse(line)
      waiting.get(message.id)?.(message)
      waiting.delete(message.id)
    }
  })
  let id = 0
  const send = (method, params) =>
    new Promise((resolveMessage) => {
      id += 1
      waiting.set(id, resolveMessage)
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  return { send, notify: (method) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`), close: () => child.kill() }
}

let session = await launch()
{
  const { page, menu, title, state, app } = session
  const isolation = await page.evaluate(() => ({ bridge: typeof window.reborn?.saveProject === 'function', require: typeof window.require, process: typeof window.process, origin: location.origin }))
  check(isolation.bridge && isolation.require === 'undefined' && isolation.process === 'undefined' && isolation.origin === 'app://reborn', `renderer isolation ${JSON.stringify(isolation)}`)

  // Update prompt, driven by update:simulate: available → Update now → 42% → downloaded → Restart now.
  const toast = page.getByTestId('update-toast')
  await page.evaluate(() => window.reborn.updateSimulate({ type: 'available', version: '9.9.9', releaseNotes: '• Typed tempo works\n• Track menu' }))
  await until(() => toast.getByText('v9.9.9').isVisible(), 'update available prompt')
  check(await toast.getByText('• Typed tempo works').isVisible(), 'update prompt shows the release notes')
  await toast.getByRole('button', { name: 'Update now' }).click()
  await page.evaluate(() => window.reborn.updateSimulate({ type: 'downloading', percent: 42 }))
  await until(() => toast.getByRole('progressbar').getAttribute('aria-valuenow').then((v) => v === '42'), 'update download progress')
  await page.evaluate(() => window.reborn.updateSimulate({ type: 'downloaded', version: '9.9.9' }))
  await until(() => toast.getByRole('button', { name: 'Restart now' }).isVisible(), 'update ready prompt')
  await page.screenshot({ path: join(OUT, 'update-ready.png') })
  await toast.getByRole('button', { name: 'Later' }).click()
  check(!(await toast.count()), 'Later closes the update prompt')
  // Help › Check for Updates reports in the prompt; unpackaged builds never check.
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.find((item) => item.label === 'Help').submenu.items.find((item) => item.label === 'Check for Updates').click())
  await until(() => toast.getByText('Updates are checked in installed builds only.').isVisible(), 'manual update check result')
  await toast.getByRole('button', { name: 'Dismiss' }).click()
  check(!(await toast.count()), 'Dismiss closes the update prompt')

  // Play.
  await page.locator('body').press('Space')
  await until(() => state(() => window.__studio.engine.position() > 0.3), 'playhead to move')
  await page.locator('body').press('Space')

  // Import a user sample so the project has audio to save.
  await page.getByRole('button', { name: 'Samples', exact: true }).click()
  await page.locator('.browser input[type=file]').setInputFiles(SAMPLE)
  await until(() => state(() => Object.keys(window.__studio.getState().project.assets).some((id) => id.startsWith('ast_'))), 'imported asset')

  // The same edit from the UI, the CLI, and MCP, all in one undo history.
  const tempo = page.getByRole('spinbutton', { name: 'Tempo in BPM' })
  await tempo.fill('126')
  await until(() => state(() => window.__studio.getState().project.tempo === 126), 'UI tempo edit')
  await until(async () => existsSync(join(USER_DATA, 'api.json')), 'api.json')
  const status = JSON.parse(cli('status', '--json'))
  check(status.project?.tempo === 126, `CLI status sees the UI edit ${JSON.stringify(status.project)}`)
  cli('run', 'project.update', '--tempo', '127')
  await until(() => state(() => window.__studio.getState().project.tempo === 127), 'CLI tempo edit')
  cli('pattern', 'write', '808.kick', 'X...X...X...X...')
  const mcp = mcpSession()
  await mcp.send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } })
  mcp.notify('notifications/initialized')
  const tools = await mcp.send('tools/list', {})
  check(tools.result.tools.some((t) => t.name === 'project_update'), 'MCP lists project_update')
  check(!tools.result.tools.some((t) => t.name.startsWith('video_')), 'the Composer MCP lists no video tools')
  const proposed = await mcp.send('tools/call', { name: 'project_update', arguments: { tempo: 128, intent: 'Lift the tempo a little' } })
  check(/propos/i.test(proposed.result.content[0].text), `MCP edit should be proposed: ${proposed.result.content[0].text}`)
  mcp.close()
  await until(() => page.locator('.proposal').count().then((n) => n > 0), 'proposal card')
  await page.locator('.proposal').getByRole('button', { name: /Apply/ }).click()
  await until(() => state(() => window.__studio.getState().project.tempo === 128), 'agent proposal applied')
  const origins = await state(() => window.__studio.getState().past.slice(-4).map((e) => e.origin))
  check(JSON.stringify(origins) === JSON.stringify(['manual', 'script', 'script', 'agent']), `undo history origins ${JSON.stringify(origins)}`)
  cli('undo')
  await until(() => state(() => window.__studio.getState().project.tempo === 127), 'CLI undo')

  // The Director over MCP: it builds a storyboard, can't touch the music,
  // looks at stills, and waits for the user at the stage gate.
  const director = mcpSession(['--role', 'director'])
  await director.send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } })
  director.notify('notifications/initialized')
  const directorTools = (await director.send('tools/list', {})).result.tools.map((t) => t.name)
  check(directorTools.includes('video_stills') && !directorTools.includes('project_update'), `Director tools ${directorTools.join(', ')}`)
  const call = (name, args = {}) => director.send('tools/call', { name, arguments: args }).then((reply) => reply.result)
  const created = await call('video_storyboard_edit', { intent: 'Start the storyboard', commands: [{ type: 'video.storyboard.create', params: {} }] })
  check(!created.isError, `Director created a storyboard: ${created.content[0].text}`)
  const refused = await call('video_storyboard_edit', { intent: 'Speed up', commands: [{ type: 'project.update', params: { tempo: 170 } }] })
  check(refused.isError && /Director edits only storyboards/.test(refused.content[0].text), `Director music edit refused: ${refused.content[0].text}`)
  check((await state(() => window.__studio.getState().project.tempo)) === 127, 'the Director left the tempo alone')
  const cues = JSON.parse((await call('video_cues')).content[0].text)
  check(Array.isArray(cues.sections) && cues.tempo === 127, `Director reads cues ${JSON.stringify(cues).slice(0, 120)}`)
  const stills = await call('video_stills')
  check(stills.content.some((part) => part.type === 'image' && part.data.length > 1000), 'Director sees the contact sheet')
  const comment = await call('video_storyboard_edit', { intent: 'Leave a note', commands: [{ type: 'video.comment.add', params: { text: 'Intro stays calm.', author: 'user' } }] })
  check(!comment.isError, 'Director comment added')
  const approve = await call('video_storyboard_edit', { intent: 'Approve itself', commands: [{ type: 'video.stage.approve', params: {} }] })
  check(approve.isError, 'the Director cannot approve a stage')
  await call('video_stage_request', { summary: 'Brief understood; one scene per section.' })
  director.close()
  const board = await state(() => window.__studio.getState().project.video.storyboards[0])
  check(board.request?.summary === 'Brief understood; one scene per section.', 'stage request recorded')
  check(board.comments[0]?.author === 'director', `Director comments are marked as its own (${board.comments[0]?.author})`)
  check(board.stills.length >= 2, 'Director stills stored on the storyboard')
  await page.keyboard.press('5')
  await page.getByRole('button', { name: 'Done', exact: true }).first().click()
  await page.getByRole('button', { name: 'Start', exact: true }).click()
  await until(() => state(() => window.__studio.getState().project.video.storyboards[0].stage === 'treatment'), 'user approves the brief')
  await page.screenshot({ path: join(OUT, 'director.png') })
  await page.keyboard.press('1')

  // Save, edit, save again without rewriting audio, export, pack, reopen.
  await menu('save')
  await until(async () => existsSync(join(PROJECT_DIR, 'project.json')), 'project.json')
  const document = JSON.parse(await readFile(join(PROJECT_DIR, 'project.json'), 'utf8'))
  check(document.formatVersion === 2 && document.studio?.schema === 'reborn-studio', 'project.json is a v2 studio document')
  const assetFiles = existsSync(join(PROJECT_DIR, 'assets')) ? await readdir(join(PROJECT_DIR, 'assets')) : []
  check(assetFiles.length >= 1, 'imported audio was saved with the project')
  const videoFiles = existsSync(join(PROJECT_DIR, 'video')) ? await readdir(join(PROJECT_DIR, 'video')) : []
  check(videoFiles.filter((f) => f.endsWith('.png')).length >= 3, `stills were saved in the video folder (${videoFiles.join(', ')})`)
  check(document.studio?.video?.storyboards?.length === 1, 'the storyboard was saved with the project')
  await until(async () => !(await title()).startsWith('•'), 'saved title')
  const before = assetFiles[0] ? (await stat(join(PROJECT_DIR, 'assets', assetFiles[0]))).mtimeMs : 0
  await tempo.fill('130')
  await until(async () => (await title()).startsWith('•'), 'edited title')
  await menu('save')
  await until(async () => !(await title()).startsWith('•'), 'second save')
  if (assetFiles[0]) check((await stat(join(PROJECT_DIR, 'assets', assetFiles[0]))).mtimeMs === before, 'unchanged audio was rewritten')

  await menu('export-wav')
  await page.locator('.modal').getByRole('button', { name: 'Export' }).click()
  await until(async () => existsSync(WAV), 'WAV export', 180_000)
  if (existsSync(WAV)) {
    const wav = await readFile(WAV)
    check(wav.toString('ascii', 0, 4) === 'RIFF' && wav.readUInt16LE(22) === 2 && wav.readUInt32LE(24) === 44100, 'export is a stereo 44.1 kHz WAV')
  }

  await menu('pack')
  await until(async () => existsSync(PACK), 'pack')

  await menu('new')
  await until(async () => (await title()).includes('New Beat'), 'new project')
  await menu('open-path', PROJECT_DIR)
  await until(() => state(() => window.__studio.getState().project.tempo === 130), 'reopened project')

  // The sidecar can crash mid-analysis without touching playback or the project.
  let python = false
  try {
    execFileSync('python', ['-c', 'import numpy'], { stdio: 'ignore' })
    python = true
  } catch {
    python = false
  }
  if (python) {
    await page.keyboard.press('3')
    // Loop, so playback outlasts a slow sidecar start (CI runners take longer than the song).
    await state(() => window.__studio.engine.setLoop([0, window.__studio.getState().project.length]))
    await page.locator('body').press('Space')
    const revision = await state(() => window.__studio.getState().project.revision)
    await page.getByRole('button', { name: 'Deep analysis' }).click()
    await until(() => app.evaluate(() => Boolean(globalThis.__rebornDeep?.pid)), 'sidecar to start', 60_000)
    const pid = await app.evaluate(() => globalThis.__rebornDeep.pid)
    try {
      process.kill(pid)
    } catch {
      // The analysis may already have finished.
    }
    await page.waitForTimeout(1500)
    const afterCrash = await state(() => ({ playing: window.__studio.getState().transport.playing, revision: window.__studio.getState().project.revision }))
    check(afterCrash.playing && afterCrash.revision === revision, `sidecar crash affected the session ${JSON.stringify(afterCrash)}`)
    await until(() => page.getByRole('button', { name: 'Deep analysis' }).isEnabled(), 'deep analysis to settle', 60_000)
    await page.getByRole('button', { name: 'Deep analysis' }).click()
    await until(() => page.locator('.deep-result').count().then((n) => n > 0), 'deep analysis after restart', 120_000)
    // The sidecar sends a final status, so no progress pill stays behind.
    await until(() => page.locator('.job-pill').count().then((n) => n === 0), 'the deep analysis pill to clear', 10_000)
    await page.locator('body').press('Space')
    await state(() => window.__studio.engine.setLoop(null))
    await page.screenshot({ path: join(OUT, 'deep-analysis.png') })
  } else console.log('Skipping sidecar checks: Python with numpy was not found.')

  // Crash recovery.
  await page.keyboard.press('1')
  await tempo.fill('131')
  await page.waitForTimeout(2200)
  check(session.errors.length === 0, `page errors: ${session.errors.join(' | ')}`)
  const pid = app.process().pid
  if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  else app.process().kill('SIGKILL')
  await new Promise((r) => setTimeout(r, 1000))
}

session = await launch()
{
  const { state, title } = session
  await until(() => state(() => window.__studio.getState().project.tempo === 131), 'recovered project after crash')
  await until(async () => (await title()).startsWith('•'), 'recovered project marked as edited')
  await session.app.close()
  check(!existsSync(join(USER_DATA, 'session.lock')), 'clean quit left the session lock')
  check(!existsSync(join(USER_DATA, 'api.json')), 'clean quit left api.json')
}

if (failures.length) {
  console.error(failures.join('\n'))
  process.exit(1)
}
console.log(`Desktop smoke passed. Output in ${OUT}`)
