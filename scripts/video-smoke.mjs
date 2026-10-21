// End-to-end check of the Video view: create a storyboard, preview it live,
// edit a scene and text through the inspector, analyze the mix, and export
// an MP4 draft. Start the studio first: npm run studio
import { mkdirSync, readFileSync } from 'node:fs'
import { chromium } from 'playwright'

const URL = process.env.STUDIO_URL ?? 'http://127.0.0.1:5175/?e2e&fresh'
const OUT = 'artifacts/video-smoke'
mkdirSync(OUT, { recursive: true })
const failures = []
const errors = []
const check = (ok, message) => {
  if (!ok) failures.push(message)
}

const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const state = (page, fn, arg) => page.evaluate(fn, arg)

/**
 * Mean brightness and the share of non-black pixels in the preview. A WebGL
 * canvas clears after each frame is shown, so this reads a screenshot.
 */
async function canvasStats(page) {
  const png = (await page.locator('.video-canvas').screenshot()).toString('base64')
  return page.evaluate(async (data) => {
    const image = new Image()
    image.src = `data:image/png;base64,${data}`
    await image.decode()
    const copy = document.createElement('canvas')
    copy.width = 160
    copy.height = Math.round((160 * image.height) / image.width)
    const ctx = copy.getContext('2d')
    ctx.drawImage(image, 0, 0, copy.width, copy.height)
    const pixels = ctx.getImageData(0, 0, copy.width, copy.height).data
    let sum = 0
    let lit = 0
    for (let i = 0; i < pixels.length; i += 4) {
      const v = (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3
      sum += v
      if (v > 12) lit += 1
    }
    return { mean: sum / (pixels.length / 4), lit: lit / (pixels.length / 4) }
  }, png)
}

try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true })
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await page.goto(URL, { waitUntil: 'networkidle' })

  // A song with a build, an impact, and a drop.
  await state(page, () => {
    const { dispatch } = window.__studio.audit.store
    dispatch([
      { type: 'project.update', params: { tempo: 150 } },
      { type: 'section.update', params: { sectionId: window.__studio.getState().project.sections[0].id, name: 'Build', length: 4 } },
      { type: 'section.update', params: { sectionId: window.__studio.getState().project.sections[1].id, name: 'Drop', start: 4, length: 4 } },
    ])
  })

  await page.keyboard.press('5')
  await page.getByRole('button', { name: 'Create storyboard' }).click()
  const board = await state(page, () => window.__studio.getState().project.video?.storyboards[0])
  check(board?.scenes.length === 2, `expected one scene per section, got ${board?.scenes.length}`)
  check(board?.scenes[1].look === 'vein-tunnel', `the drop should start as Vein Tunnel, got ${board?.scenes[1].look}`)

  // The preview draws something at the drop.
  await state(page, () => window.__studio.engine.seek(4.25))
  await page.waitForTimeout(800)
  const drop = await canvasStats(page)
  check(drop.lit > 0.02, `the preview is black at the drop (${JSON.stringify(drop)})`)
  await page.screenshot({ path: `${OUT}/video-view.png` })

  // Select the drop scene and change its look through the inspector.
  await page.locator('.video-block.scene', { hasText: 'Drop' }).click()
  await page.getByRole('combobox', { name: 'Look', exact: true }).selectOption('neon-kaleido')
  const look = await state(page, () => window.__studio.getState().project.video.storyboards[0].scenes[1].look)
  check(look === 'neon-kaleido', `the look did not change (${look})`)
  const hue = page.locator('.vfield', { hasText: /^hue/ }).locator('input[type="text"]')
  await hue.fill('t*.2+kick')
  await hue.press('Enter')
  const hueValue = await state(page, () => window.__studio.getState().project.video.storyboards[0].scenes[1].params.hue)
  check(hueValue === 't*.2+kick', `the hue expression was not saved (${hueValue})`)
  // A bad expression is rejected and the old value stays.
  await hue.fill('alert(1)')
  await hue.press('Enter')
  const kept = await state(page, () => window.__studio.getState().project.video.storyboards[0].scenes[1].params.hue)
  check(kept === 't*.2+kick', `a bad expression replaced the value (${kept})`)
  await page.keyboard.press('Control+z')
  const undone = await state(page, () => window.__studio.getState().project.video.storyboards[0].scenes[1].params.hue)
  check(undone === undefined, `undo did not restore the default hue (${undone})`)

  // Text at the playhead.
  await page.getByRole('button', { name: 'Add text at the playhead' }).click()
  const text = await state(page, () => window.__studio.getState().project.video.storyboards[0].text[0])
  check(text?.style === 'slam', `text was not added (${JSON.stringify(text)})`)
  await page.waitForTimeout(500)
  await page.screenshot({ path: `${OUT}/video-text.png` })

  // An open comment blocks the stage gate until it is answered.
  await page.keyboard.press('Escape')
  const current = () => state(page, () => window.__studio.getState().project.video.storyboards[0])
  await page.getByPlaceholder(/A comment or request/).fill('Make the drop darker')
  await page.getByRole('button', { name: 'Add comment' }).click()
  check(await page.getByRole('button', { name: 'Start', exact: true }).isDisabled(), 'Start is enabled with an open comment')
  await page.getByRole('button', { name: 'Done', exact: true }).first().click()
  await page.getByRole('button', { name: 'Start', exact: true }).click()
  check((await current()).stage === 'treatment', `the brief was not approved (${(await current()).stage})`)

  // Look-dev stills and a contact sheet land on the storyboard.
  await page.getByRole('button', { name: 'Render stills' }).click()
  await page.waitForFunction(() => window.__studio.getState().project.video.storyboards[0].stills.length >= 3, null, { timeout: 60_000 })
  const files = await state(page, () => {
    const video = window.__studio.getState().project.video
    return video.storyboards[0].stills.map((id) => video.files[id].kind)
  })
  check(files.includes('sheet') && files.filter((k) => k === 'still').length >= 2, `stills were not stored (${files.join(', ')})`)
  await page.locator('.video-still-thumb').first().click()
  await page.locator('img.video-still-large').waitFor()
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${OUT}/video-still.png` })
  await page.getByRole('button', { name: 'Close the still' }).click()

  // The library: apply a built-in preset, then save the scene as a preset of our own.
  await page.locator('.video-block.scene', { hasText: 'Drop' }).click()
  await page.getByRole('button', { name: 'Looks, library, footage' }).click()
  await page.locator('.vlib-item', { hasText: 'Drop: Grid Tunnel' }).getByRole('button', { name: 'Apply to scene' }).click()
  const applied = (await current()).scenes[1]
  check(applied.look === 'grid-tunnel' && applied.preset?.id === 'builtin-drop-2', `the preset was not applied (${applied.look}, ${JSON.stringify(applied.preset)})`)
  await page.getByLabel('Name for the library item').fill('Smoke drop')
  await page.getByRole('button', { name: 'Scene as preset' }).click()
  await page.locator('.vlib-item', { hasText: 'Smoke drop' }).waitFor({ timeout: 20_000 })
  await page.getByRole('tab', { name: 'Looks' }).click()
  await page.locator('.vlib-item').first().waitFor()
  await page.getByRole('tab', { name: 'Footage' }).click()
  await page.getByText(/Footage search and downloads run in the desktop app/).waitFor()
  await page.screenshot({ path: `${OUT}/video-drawer.png` })
  await page.getByRole('button', { name: 'Close the drawer' }).click()

  // Mix analysis fills in the band envelopes.
  await page.getByRole('button', { name: 'Analyze mix' }).click()
  await page.getByText('Mix analyzed').waitFor({ timeout: 60_000 })

  // Draft export downloads an MP4 with video and audio.
  const download = page.waitForEvent('download', { timeout: 240_000 })
  await page.getByRole('button', { name: 'Export draft' }).click()
  const file = await download
  const path = `${OUT}/${file.suggestedFilename()}`
  await file.saveAs(path)
  const bytes = readFileSync(path)
  check(bytes.length > 20_000, `the MP4 is too small (${bytes.length} bytes)`)
  check(bytes.subarray(4, 8).toString() === 'ftyp', 'the export is not an MP4')
  const boxes = bytes.toString('latin1')
  check(/vide/.test(boxes) && /soun/.test(boxes), 'the MP4 is missing a video or audio track')
  check(boxes.includes('mp4a'), 'the MP4 audio is not AAC')
  console.log(`exported ${path} (${bytes.length} bytes)`)
  await page.screenshot({ path: `${OUT}/video-after-export.png` })
} catch (error) {
  failures.push(String(error?.stack ?? error))
} finally {
  await browser.close()
}

const relevant = errors.filter((e) => !/favicon|DevTools/.test(e))
if (relevant.length) failures.push(...relevant.map((e) => `page error: ${e}`))
if (failures.length) {
  console.error(`Video smoke failed:\n- ${failures.join('\n- ')}`)
  process.exit(1)
}
console.log('Video smoke passed.')
