// End-to-end check of the Ismail tools in the desktop app: install from the
// Generate tab, generate a sound that loops when stretched, copy and paste
// it, write notes from a description with the agent (a fake local model
// server stands in for the provider), the in-app agent's ismail_generate
// tool, deep analysis with Ismail reports, stem separation as one undo step,
// and the same through the CLI.
//
// Opt-in: it installs Ismail into artifacts/ismail-e2e/user-data, which
// downloads about 650 MB (1.3 GB with ISMAIL_SMOKE_SEPARATION=1) unless pip's
// cache already has the packages. Run `npm run desktop:build` first.
import { _electron as electron } from 'playwright'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const OUT = resolve('artifacts/ismail-e2e')
const USER_DATA = join(OUT, 'user-data')
const CLI = resolve('packages/cli/bin/reborn.mjs')
const SEPARATION = process.env.ISMAIL_SMOKE_SEPARATION === '1'
const INSTALL_TIMEOUT = 30 * 60_000
if (process.env.ISMAIL_SMOKE_KEEP !== '1') await rm(OUT, { recursive: true, force: true })
await mkdir(OUT, { recursive: true })

const failures = []
const check = (ok, message) => {
  if (!ok) failures.push(message)
}
const until = async (predicate, message, timeout = 30_000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    // Errors marked fatal end the test at once; others mean "not yet".
    if (await predicate().catch((error) => { if (error?.fatal) throw error; return false })) return true
    await new Promise((r) => setTimeout(r, 250))
  }
  failures.push(`timed out: ${message}`)
  return false
}
const cli = (...args) => execFileSync(process.execPath, [CLI, ...args], { env: { ...process.env, REBORN_API_FILE: join(USER_DATA, 'api.json') }, encoding: 'utf8', timeout: 20 * 60_000 })

// A fake OpenAI-compatible model server. For write_sound it first answers with
// a bad pitch, so the draft loop has to send the problem back and retry.
const modelRequests = []
const reply = (res, message) => res.end(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] }))
const toolCall = (name, args) => ({ role: 'assistant', content: null, tool_calls: [{ id: `call_${modelRequests.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] })
const modelServer = createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => (body += chunk))
  req.on('end', () => {
    const request = JSON.parse(body)
    modelRequests.push(request)
    const tools = (request.tools ?? []).map((t) => t.function.name)
    const answered = request.messages.some((m) => m.role === 'tool')
    res.setHeader('content-type', 'application/json')
    if (tools.includes('write_sound')) {
      return reply(res, answered
        ? toolCall('write_sound', { instrument: 'pluck', notes: '0 C3 0.5 100; 1 G3 0.5 90; 2 A#3 0.5 100; 3 G3 0.5 90', name: 'Agent pluck', tailSeconds: 0.5, summary: 'A four-note pluck riff in C minor.' })
        : toolCall('write_sound', { instrument: 'pluck', notes: '0 H3 1', name: 'Agent pluck', summary: 'First try.' }))
    }
    if (tools.includes('ismail_generate')) {
      return reply(res, answered ? { role: 'assistant', content: '## Done' + String.fromCharCode(10, 10) + 'I made **Agent kicks** on a new track.' + String.fromCharCode(10, 10) + '1. Four hits, one per beat' + String.fromCharCode(10) + '   - made with the `kick` preset' + String.fromCharCode(10) + '2. Loops every bar' } : toolCall('ismail_generate', { instrument: 'kick', notes: '0 C1 0.25 120; 1 C1 0.25 120; 2 C1 0.25 120; 3 C1 0.25 120', name: 'Agent kicks' }))
    }
    reply(res, { role: 'assistant', content: 'No tools.' })
  })
})
await new Promise((resolve) => modelServer.listen(0, '127.0.0.1', resolve))
await mkdir(USER_DATA, { recursive: true })
await writeFile(join(USER_DATA, 'agent.json'), JSON.stringify({ provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${modelServer.address().port}/v1`, model: 'fake', directEdits: false, shareMeasurements: false }))

const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, REBORN_E2E: '1', REBORN_USER_DATA: USER_DATA } })
const page = await app.firstWindow()
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
await page.waitForSelector('.transport')
const state = (fn, arg) => page.evaluate(fn, arg)
// A fresh profile may start with the browser collapsed to its icon rail.
const openGenerate = async () => {
  const tab = page.getByRole('tab', { name: 'Generate' })
  if (!(await tab.isVisible().catch(() => false))) await page.getByRole('button', { name: 'Generate', exact: true }).click()
  await tab.click()
}
const tracks = () => state(() => window.__studio.getState().project.tracks.map((t) => ({ id: t.id, name: t.name, kind: t.kind })))

try {
  // Install from the Generate tab, the way a person does.
  await openGenerate()
  const install = page.getByRole('button', { name: 'Install Ismail' })
  if (await install.isVisible().catch(() => false)) {
    await install.click()
    console.log('Installing Ismail…')
  }
  const installFailed = () => page.locator('.browser-note.is-error').isVisible()
  await until(async () => {
    if (await installFailed()) throw Object.assign(new Error(`Ismail install failed: ${await page.locator('.browser-note.is-error').innerText()}`), { fatal: true })
    return page.getByRole('combobox', { name: 'Ismail instrument' }).isVisible()
  }, 'Ismail install and presets', INSTALL_TIMEOUT)
  await page.screenshot({ path: join(OUT, 'generate-tab.png') })

  // Generate with nothing selected: a new audio track.
  await state(() => window.__studio.audit.store.select({ kind: 'none' }))
  const before = (await tracks()).length
  await page.getByRole('combobox', { name: 'Ismail instrument' }).selectOption('preset:acid_bass')
  await page.getByRole('button', { name: /^Generate / }).click()
  await until(async () => (await tracks()).length === before + 1, 'generated sound on a new track', 120_000)
  // The sidecar ends each request with a final status, so the pill clears.
  await until(() => state(() => !window.__studio.getState().jobs.some((j) => j.status === 'running')), 'the generate pill to clear', 10_000)
  const generated = await state(() => {
    const s = window.__studio.getState()
    const track = s.project.tracks.at(-1)
    const clip = s.project.clips.find((c) => c.trackId === track.id)
    const asset = clip && s.project.assets[clip.assetId]
    return { track: track.name, kind: track.kind, origin: asset?.origin, duration: asset?.duration, loaded: Boolean(clip && window.__studio.engine.buffer(clip.assetId)), clipId: clip?.id, trackId: track.id, start: clip?.start, length: clip?.length, loop: clip?.loop, past: s.past.length }
  })
  check(generated.kind === 'audio' && generated.origin?.kind === 'generated' && generated.origin?.source?.startsWith('ismail:acid_bass') && generated.duration > 0.1 && generated.loaded, `generated sound ${JSON.stringify(generated)}`)
  // It loops at a musical length that holds it, so stretching repeats it.
  check(generated.loop?.start === 0 && generated.loop?.length > 0 && generated.loop.length <= 1 && generated.length === generated.loop.length, `generated clip loops ${JSON.stringify(generated)}`)
  await until(() => page.locator('.ismail-report').isVisible(), 'timbre report')
  await state((clipId) => window.__studio.audit.store.dispatch({ type: 'clip.resize', params: { clipId, length: 2 } }, { label: 'Stretch' }), generated.clipId)
  const repeats = await state(async (clipId) => {
    const { audit, engine, getState } = window.__studio
    const project = getState().project
    const clip = project.clips.find((c) => c.id === clipId)
    const buffers = new Map(Object.keys(project.assets).map((id) => [id, engine.buffer(id)]).filter(([, b]) => b))
    const result = await audit.studioEngine.renderStudio(audit.studioEngine.isolateTrack(project, clip.trackId), buffers, { from: clip.start, to: clip.start + 2 })
    // Peak level at the start of each loop period across the two bars.
    const period = clip.loop.length * audit.core.studio.barSeconds(project) * result.sampleRate
    const peaks = []
    for (let start = 0; start + 64 < result.musicalSeconds * result.sampleRate - 1; start += period) {
      let peak = 0
      for (let i = Math.floor(start); i < Math.min(result.channels[0].length, start + period * 0.5); i += 1) peak = Math.max(peak, Math.abs(result.channels[0][i]))
      peaks.push(peak)
    }
    return { count: peaks.length, quiet: peaks.filter((p) => p < 0.01).length, expected: Math.round(2 / clip.loop.length) }
  }, generated.clipId)
  check(repeats.count === repeats.expected && repeats.quiet === 0, `looped clip repeats the sound in every period ${JSON.stringify(repeats)}`)
  await page.screenshot({ path: join(OUT, 'looped-clip.png') })

  // Copy and paste with the keyboard: the copy lands at the playhead and the
  // playhead moves to its end, so a second paste follows it.
  await state((clipId) => window.__studio.audit.store.select({ kind: 'clip', clipId }), generated.clipId)
  await page.locator('.clip.is-selected').focus()
  await page.keyboard.press('Control+C')
  await state(() => window.__studio.engine.seek(8))
  await page.keyboard.press('Control+V')
  await page.keyboard.press('Control+V')
  const pasted = await state((trackId) => window.__studio.getState().project.clips.filter((c) => c.trackId === trackId).map((c) => ({ start: c.start, length: c.length, loop: c.loop })), generated.trackId)
  check(JSON.stringify(pasted.map((c) => c.start)) === JSON.stringify([generated.start, 8, 10]) && pasted.every((c) => c.length === 2 && c.loop), `pasted clips ${JSON.stringify(pasted)}`)

  // The right-click menu pastes at the clicked bar (bar 7, between the
  // copies) and cuts.
  const lane = page.locator('.lane').filter({ has: page.locator('.clip.is-selected') })
  const laneBox = await lane.boundingBox()
  const ppb = await state(() => document.querySelector('.clip.is-selected').getBoundingClientRect().width / 2)
  await page.mouse.click(laneBox.x + 6 * ppb + 2, laneBox.y + laneBox.height / 2, { button: 'right' })
  await page.getByRole('menuitem', { name: 'Paste here' }).click()
  await page.locator('.clip.is-selected').click({ button: 'right' })
  await page.screenshot({ path: join(OUT, 'clip-menu.png') })
  await page.getByRole('menuitem', { name: 'Cut' }).click()
  const afterMenu = await state((trackId) => window.__studio.getState().project.clips.filter((c) => c.trackId === trackId).map((c) => c.start), generated.trackId)
  check(JSON.stringify(afterMenu) === JSON.stringify([generated.start, 8, 10]), `context menu paste then cut ${JSON.stringify(afterMenu)}`)

  // Describe a sound: the agent writes the instrument and notes, fixes its
  // first bad answer, fills the fields, and generates.
  await state(() => window.__studio.audit.store.select({ kind: 'none' }))
  await page.getByRole('tab', { name: 'Generate' }).click()
  await page.getByPlaceholder('Rubbery acid bassline').fill('A short pluck riff in C minor')
  const tracksBeforeDraft = (await tracks()).length
  await page.getByRole('button', { name: 'Write and generate' }).click()
  await until(async () => (await tracks()).length === tracksBeforeDraft + 1, 'agent-written sound on a new track', 120_000)
  const drafted = await state(() => {
    const s = window.__studio.getState()
    const track = s.project.tracks.at(-1)
    const clip = s.project.clips.find((c) => c.trackId === track.id)
    return { name: track.name, source: s.project.assets[clip?.assetId]?.origin?.source }
  })
  check(drafted.name === 'Agent pluck' && /^ismail:pluck 0 C3 0\.5 100; 1 G3/.test(drafted.source ?? ''), `agent-written sound ${JSON.stringify(drafted)}`)
  check((await page.getByRole('combobox', { name: 'Ismail instrument' }).inputValue()) === 'preset:pluck' && /G3 0\.5 90/.test(await page.locator('textarea[aria-labelledby="ismail-notes-label"]').inputValue()), 'agent filled the instrument and notes fields')
  check(await page.getByText('Agent: A four-note pluck riff in C minor.').isVisible(), 'agent summary shown')
  const draftRequests = modelRequests.filter((r) => r.tools?.some((t) => t.function.name === 'write_sound'))
  check(draftRequests.length === 2 && draftRequests[0].messages.some((m) => /short pluck riff in C minor/.test(m.content ?? '')) && draftRequests[1].messages.some((m) => m.role === 'tool' && /"H3" is not a pitch/.test(m.content)), `draft requests ${JSON.stringify(draftRequests.map((r) => r.messages.map((m) => m.role)))}`)
  await page.screenshot({ path: join(OUT, 'agent-draft.png') })

  // The in-app agent generates with its ismail_generate tool.
  await page.getByRole('button', { name: 'Agent', exact: true }).click()
  // The intro paragraph uses the panel's width instead of a narrow label column.
  const introWidth = await page.locator('.agent-empty p').first().evaluate((el) => el.getBoundingClientRect().width)
  check(introWidth > 250, `agent intro width ${introWidth}`)
  await page.getByRole('textbox', { name: 'Message the agent' }).fill('Add four kicks')
  await page.getByRole('textbox', { name: 'Message the agent' }).press('Enter')
  await until(() => state(() => window.__studio.getState().project.tracks.some((t) => t.name === 'Agent kicks')), 'agent ismail_generate track', 120_000)
  await until(() => page.locator('.agent-text strong', { hasText: 'Agent kicks' }).isVisible(), 'agent reply')
  // Steps show as plain-language lines, and the reply's Markdown renders.
  check(await page.getByText('Generating Agent kicks with Ismail (kick)').isVisible(), 'agent step line')
  const reply = await page.locator('.agent-text').last().evaluate((el) => ({ heading: el.querySelector('h4')?.textContent, markers: [...el.querySelectorAll('li > b')].map((b) => b.textContent), code: el.querySelector('code')?.textContent, transform: getComputedStyle(el.querySelector('p')).textTransform }))
  check(reply.heading === 'Done' && JSON.stringify(reply.markers) === JSON.stringify(['1.', '•', '2.']) && reply.code === 'kick' && reply.transform === 'none', `agent reply markdown ${JSON.stringify(reply)}`)
  const agentOrigin = await state(() => window.__studio.getState().past.at(-1)?.origin)
  check(agentOrigin === 'agent', `agent generation origin ${agentOrigin}`)
  await page.screenshot({ path: join(OUT, 'agent-generate.png') })
  await page.getByRole('button', { name: 'Close agent' }).click()

  // Generating into a selected Sampler loads it there instead.
  const sampler = (await tracks()).find((t) => t.kind === 'sampler')
  if (sampler) {
    await state((id) => window.__studio.audit.store.select({ kind: 'track', trackId: id }), sampler.id)
    await page.getByRole('combobox', { name: 'Ismail instrument' }).selectOption('preset:kick')
    await page.getByRole('button', { name: /^Generate / }).click()
    await until(() => state((id) => window.__studio.getState().project.tracks.find((t) => t.id === id).device.source?.assetId?.startsWith('ast_') && window.__studio.getState().project.assets[window.__studio.getState().project.tracks.find((t) => t.id === id).device.source.assetId].origin.kind === 'generated', sampler.id), 'generated kick in the sampler', 120_000)
  }

  // Deep analysis attaches Ismail's reports.
  await page.locator('body').press('3')
  await page.getByRole('button', { name: 'Deep analysis' }).click()
  await until(() => page.locator('.deep-report').count().then((n) => n >= 3), 'Ismail reports in deep analysis', 180_000)
  const reports = await page.locator('.deep-report summary').allInnerTexts()
  check(reports.some((r) => /Sections and key/.test(r)) && reports.some((r) => /Chords/.test(r)), `deep analysis reports ${JSON.stringify(reports)}`)
  await page.locator('.deep-report').first().locator('summary').click()
  await page.screenshot({ path: join(OUT, 'deep-analysis-ismail.png') })

  // The CLI and API reach the same tools.
  check(/acid_bass\s+synth/.test(cli('presets')), 'reborn presets lists acid_bass')
  const viaCli = cli('generate', 'pluck', '0 C3 0.5; 0.5 G3 0.5', '--name', 'CLI pluck', '--bar', '5', '--wait')
  check(/^Generated CLI pluck on track trk_/.test(viaCli), `reborn generate output ${viaCli}`)
  const cliTrack = await state(() => {
    const s = window.__studio.getState()
    const track = s.project.tracks.find((t) => t.name === 'CLI pluck')
    return { found: Boolean(track), start: s.project.clips.find((c) => c.trackId === track?.id)?.start, origin: s.past.at(-1)?.origin }
  })
  check(cliTrack.found && cliTrack.start === 4 && cliTrack.origin === 'script', `CLI generation ${JSON.stringify(cliTrack)}`)

  if (SEPARATION) {
    await page.locator('body').press('1')
    await openGenerate()
    const add = page.getByRole('button', { name: 'Add stem separation' })
    if (await add.isVisible().catch(() => false)) {
      await add.click()
      console.log('Installing stem separation…')
      await until(() => page.getByText(/Select an audio clip, a deck/).isVisible(), 'separation install', INSTALL_TIMEOUT)
    }
    // Separate the generated clip from the inspector: four tracks, one undo step.
    await state((clipId) => window.__studio.audit.store.select({ kind: 'clip', clipId }), generated.clipId)
    const count = (await tracks()).length
    const past = await state(() => window.__studio.getState().past.length)
    await page.getByRole('button', { name: 'Separate stems' }).click()
    await until(async () => (await tracks()).length === count + 4, 'four stem tracks', 20 * 60_000)
    await until(() => state(() => !window.__studio.getState().jobs.some((j) => j.status === 'running')), 'the separate pill to clear', 10_000)
    const stems = await state((clipId) => {
      const s = window.__studio.getState()
      const source = s.project.clips.find((c) => c.id === clipId)
      const added = s.project.tracks.slice(-4)
      return { names: added.map((t) => t.name), aligned: added.every((t) => s.project.clips.some((c) => c.trackId === t.id && c.start === source.start && c.length === source.length && JSON.stringify(c.loop ?? null) === JSON.stringify(source.loop ?? null))), steps: s.past.length }
    }, generated.clipId)
    check(stems.names.join(',').match(/drums.*bass.*other.*vocals/) && stems.aligned && stems.steps === past + 1, `separated stems ${JSON.stringify(stems)}`)
    await page.screenshot({ path: join(OUT, 'separated.png') })
    cli('undo')
    await until(async () => (await tracks()).length === count, 'one undo removes every stem')
    const viaSeparate = cli('separate', '--clip', generated.clipId, '--wait')
    check(/Separated into new audio tracks:\n\s+drums/.test(viaSeparate), `reborn separate output ${viaSeparate}`)
  } else console.log('Skipping stem separation. Set ISMAIL_SMOKE_SEPARATION=1 to install and test it.')

  check(errors.length === 0, `page errors: ${errors.join(' | ')}`)
} catch (error) {
  await page.screenshot({ path: join(OUT, 'failure.png') }).catch(() => {})
  throw error
} finally {
  await app.close()
  modelServer.close()
}

if (failures.length) {
  console.error(`Ismail smoke test failed:\n- ${failures.join('\n- ')}`)
  process.exit(1)
}
console.log(`Ismail smoke test passed${SEPARATION ? ' (with stem separation)' : ''}. Screenshots in ${OUT}.`)
