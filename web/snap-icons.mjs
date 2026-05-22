import { firefox } from 'playwright-core'
import { pathToFileURL } from 'node:url'

// Uses Playwright's bundled Firefox so we don't depend on whether the
// user has a remote-debug Chrome up. Firefox was installed in an
// earlier phase (verify-pagination-firefox.mjs) and is reused here.
const browser = await firefox.launch({ headless: true })
const ctx = await browser.newContext()
const page = await ctx.newPage()
const which = process.argv[2] || '_preview.html'
const url = pathToFileURL(`C:/Users/roame/Claude/Projects/ComicBlaster/docs/icons/${which}`).href
await page.goto(url, { waitUntil: 'networkidle' })
await page.setViewportSize({ width: 1100, height: 1700 })
await page.waitForTimeout(300)
const bb = await page.locator('table').boundingBox()
const outPng = which.replace(/\.html$/, '.png')
await page.screenshot({
  path: `C:/Users/roame/Claude/Projects/ComicBlaster/docs/icons/${outPng}`,
  clip: { x: 0, y: 0, width: Math.min(1100, bb.x + bb.width + 40), height: Math.min(1700, bb.y + bb.height + 40) },
})
await page.close()
await browser.close()
console.log('saved docs/icons/_preview.png')
