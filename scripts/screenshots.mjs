// Captures the README screenshots into docs/images/ from the studio dev server
// (port 5175): the four views with the ABYSSAL SIGNAL demo loaded.
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const URL = process.env.STUDIO_URL ?? 'http://127.0.0.1:5175/?e2e&fresh'
const OUT = 'docs/images'
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] })
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 960 } })
  await page.goto(URL, { waitUntil: 'networkidle' })
  const tab = page.getByRole('tab', { name: 'Projects' })
  if (await tab.count()) await tab.click()
  else await page.getByRole('button', { name: 'Projects', exact: true }).click()
  await page.getByRole('button', { name: /ABYSSAL SIGNAL/ }).click()
  // Let the import toast clear.
  await page.locator('.toast').first().waitFor({ state: 'detached', timeout: 15000 }).catch(() => {})
  await page.keyboard.press('Escape')

  // Arrange, with an Acid clip open in the dock.
  await page.keyboard.press('1')
  await page.locator('.clip').nth(2).click()
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${OUT}/arrange.png` })

  // Build, with a scene playing.
  await page.keyboard.press('2')
  await page.getByRole('button', { name: /^Launch / }).nth(1).click()
  await page.waitForTimeout(1500)
  await page.screenshot({ path: `${OUT}/build.png` })
  await page.getByRole('button', { name: 'Stop', exact: true }).click()

  // Mix, with the analyzer's section table. The dock shows the analyzer when
  // nothing is selected.
  await page.keyboard.press('Escape')
  await page.keyboard.press('3')
  await page.getByRole('button', { name: 'Analyze mix' }).click()
  await page.locator('.an-table tbody tr').first().waitFor({ timeout: 90000 })
  await page.screenshot({ path: `${OUT}/mix.png` })

  // Perform.
  await page.keyboard.press('4')
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${OUT}/perform.png` })
} finally {
  await browser.close()
}
console.log(`Screenshots in ${OUT}/`)
