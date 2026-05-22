// Drive Firefox at the deployed Pi to load /read/481 with an admin
// session cookie, capture every console message + page error + failed
// network request, and screenshot the rendered state. Run once with
// the token in /tmp/cb-tok-local, output goes to ./epub-481-*.

import { firefox } from 'playwright-core'
import { readFileSync, writeFileSync } from 'node:fs'

const BASE = 'http://192.168.0.7:8082'
const COMIC = 481
const token = readFileSync('C:/Users/roame/AppData/Local/Temp/cb-tok-local', 'utf8').trim()
if (!token) { console.log('no token'); process.exit(1) }

const browser = await firefox.launch({ headless: true })
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
// The server sets cb_token as an httpOnly cookie; we can set it via
// the browser context so subsequent navigations carry it.
await ctx.addCookies([{
  name: 'cb_token', value: token,
  url: BASE, httpOnly: true, sameSite: 'Lax',
}])

const page = await ctx.newPage()
const log = []
page.on('console', (msg) => log.push(`[${msg.type()}] ${msg.text()}`))
page.on('pageerror', (err) => log.push(`[pageerror] ${err.message}\n${err.stack ?? ''}`))
page.on('requestfailed', (req) => log.push(`[reqfail] ${req.method()} ${req.url()} :: ${req.failure()?.errorText}`))
page.on('response', (resp) => {
  if (resp.status() >= 400) log.push(`[http ${resp.status()}] ${resp.request().method()} ${resp.url()}`)
})

console.log('navigating…')
await page.goto(`${BASE}/read/${COMIC}`, { waitUntil: 'domcontentloaded', timeout: 30000 })
console.log('waiting for epub.js to settle (8s)…')
await page.waitForTimeout(8000)
await page.screenshot({ path: 'epub-481-start.png', fullPage: false })

// First valid spine item is nav.xhtml (empty body) — advance once to
// reach actual content (page_0.html) and screenshot that.
console.log('clicking next…')
await page.keyboard.press('ArrowRight')
await page.waitForTimeout(3000)
await page.screenshot({ path: 'epub-481-state.png', fullPage: false })

// Sniff the actual epub.js container — does it contain anything?
const containerInfo = await page.evaluate(() => {
  const container = document.querySelector('.flex-1 > div')   // the ref'd <div>
  const iframes = Array.from(document.querySelectorAll('iframe')).map((f) => ({
    src: f.src,
    width: f.width,
    height: f.height,
    contentDocReadyState: f.contentDocument?.readyState ?? null,
    bodyChildren: f.contentDocument?.body?.children.length ?? null,
    bodyText: f.contentDocument?.body?.innerText?.slice(0, 200) ?? null,
  }))
  return {
    containerExists: !!container,
    containerChildren: container?.children.length ?? 0,
    containerInnerHTMLPrefix: container?.innerHTML.slice(0, 300) ?? '',
    iframeCount: iframes.length,
    iframes,
    bodyText: document.body.innerText.slice(0, 500),
  }
})

writeFileSync('epub-481-log.txt', log.join('\n'))
writeFileSync('epub-481-state.json', JSON.stringify(containerInfo, null, 2))

await browser.close()
console.log(`\nconsole/error log lines: ${log.length}`)
console.log(`container exists: ${containerInfo.containerExists}, children: ${containerInfo.containerChildren}, iframes: ${containerInfo.iframeCount}`)
console.log('--- last 20 log lines ---')
console.log(log.slice(-20).join('\n'))
