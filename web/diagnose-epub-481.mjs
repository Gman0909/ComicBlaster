// Verifies the ePub reader layout for comic 481 on the Pi:
// - the broken cover spine item is skipped (no page error)
// - the bottom-bar slider + "X / Y" page label render
// - back navigation works (prev() goes to a lower spine index)
// - the image actually fills (or close to fills) the viewport
// - zoom buttons enlarge the image
//
// Run with: node diagnose-epub-481.mjs

import { firefox } from 'playwright-core'
import { readFileSync, writeFileSync } from 'node:fs'

const BASE = 'http://192.168.0.7:8082'
const COMIC = 481
const token = readFileSync('C:/Users/roame/AppData/Local/Temp/cb-tok-local', 'utf8').trim()
if (!token) { console.log('no token'); process.exit(1) }

const browser = await firefox.launch({ headless: true })
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
await ctx.addCookies([{
  name: 'cb_token', value: token, url: BASE, httpOnly: true, sameSite: 'Lax',
}])
const page = await ctx.newPage()
const log = []
page.on('console', (m) => log.push(`[${m.type()}] ${m.text()}`))
page.on('pageerror', (e) => log.push(`[err] ${e.message}`))

// Capture all console output for inspection.
await page.exposeFunction('logToHost', (m) => log.push(`[host] ${m}`))
await page.goto(`${BASE}/read/${COMIC}`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(8000)

// Inspect the live rendition's settings (spread mode) + spine state.
// We poke React's fiber to grab the bookRef'd Book object.
const renditionInfo = await page.evaluate(() => {
  const iframe = document.querySelector('iframe')
  // Walk DOM looking for the React fiber container; from there we can
  // reach the Book/Rendition. Hacky but useful for diagnostics.
  function findBook() {
    // epubjs exposes its current rendition via the global ePub function?
    // No — but the rendition has a 'manager.views' that holds iframes.
    // Easier: read book.spine info from the iframe's parent's React state.
    const root = document.getElementById('root')
    if (!root) return null
    // React 19 fiber stash:
    const keys = Object.keys(root).filter((k) => k.startsWith('__reactContainer'))
    let cur = root[keys[0]]?.stateNode?.current
    while (cur) {
      const inst = cur.stateNode
      if (inst && inst.bookRef && inst.bookRef.current) return inst.bookRef.current
      const props = cur.memoizedProps
      if (props && props.book) return props.book
      cur = cur.child
    }
    return null
  }
  const book = findBook()
  const spine = book && book.spine
  const sample = spine && spine.spineItems && spine.spineItems.slice(0, 8).map((s) => ({
    index: s.index,
    idref: s.idref,
    href: s.href,
    linear: s.linear,
    hasNext: typeof s.next === 'function',
  }))
  return {
    iframeCount: document.querySelectorAll('iframe').length,
    iframeWidth: iframe?.getBoundingClientRect().width,
    iframeHeight: iframe?.getBoundingClientRect().height,
    spineLength: spine?.spineItems?.length,
    spineSample: sample,
    flow: (book && book.rendition && book.rendition.settings && book.rendition.settings.flow) || '(no rendition)',
    spread: (book && book.rendition && book.rendition.settings && book.rendition.settings.spread) || '(no rendition)',
  }
})
console.log('rendition info:', JSON.stringify(renditionInfo, null, 2))
// Bottom + top bars auto-hide after 6s of inactivity. Wiggle the
// pointer before every observation so the slider / settings button
// are actually in the DOM when we query.
const wakeUp = async () => {
  await page.mouse.move(600, 400)
  await page.mouse.move(640, 420)
  await page.waitForTimeout(300)
}
await wakeUp()

// Step 1 — establish the comic loaded
const initial = await readState(page)
console.log('initial:', initial)
await page.screenshot({ path: 'epub-481-step1-initial.png' })

// Step 2 — single chevron click forward, observe delta
await page.locator('button[aria-label="Next page"]').first().click()
await page.waitForTimeout(2000)
await wakeUp()
const oneForward = await readState(page)
console.log('after 1× chevron-next:', oneForward)
await page.locator('button[aria-label="Next page"]').first().click()
await page.waitForTimeout(2000)
await wakeUp()
const forward = await readState(page)
console.log('after 2× forward:', forward)
await page.screenshot({ path: 'epub-481-step2-forward.png' })

// Step 3 — back nav via the bottom-bar chevron (NOT keyboard — the
// iframe steals keyboard focus once it loads, and parent-window
// keydown listeners stop seeing arrow keys until the user clicks
// back out of the iframe. The chevron's onClick handler is
// unaffected by focus.)
await page.locator('button[aria-label="Previous page"]').first().click()
await page.waitForTimeout(2000)
await wakeUp()
const back = await readState(page)
console.log('after back:', back)
await page.screenshot({ path: 'epub-481-step3-back.png' })

// Step 4 — verify slider + page label
const ui = await page.evaluate(() => {
  const slider = document.querySelector('input[type="range"][aria-label="Page"]')
  const labelEl = Array.from(document.querySelectorAll('span'))
    .find((s) => /^\s*\d+\s*\/\s*\d+\s*$/.test(s.textContent || ''))
  return {
    sliderExists: !!slider,
    sliderMin: slider?.getAttribute('aria-valuemin'),
    sliderMax: slider?.getAttribute('aria-valuemax'),
    sliderNow: slider?.getAttribute('aria-valuenow'),
    pageLabel: labelEl?.textContent?.trim() ?? null,
  }
})
console.log('ui:', ui)

// Step 4b — drag the slider to a known image page (chapter_5 ≈ idx 7)
// and verify image renders + zoom affects it
await wakeUp()
await page.evaluate(() => {
  const slider = document.querySelector('input[type="range"][aria-label="Page"]')
  if (slider) {
    slider.value = '10'
    slider.dispatchEvent(new Event('input', { bubbles: true }))
    slider.dispatchEvent(new Event('change', { bubbles: true }))
  }
})
await page.waitForTimeout(3000)
await wakeUp()
const imagePage = await readState(page)
console.log('image page (slider→idx 10):', imagePage)
await page.screenshot({ path: 'epub-481-image-page.png' })

// Step 5 — zoom test. Open settings popover, click + twice.
await wakeUp()
await page.locator('button[aria-label="Reading settings"]').click()
await page.waitForTimeout(300)
const beforeZoom = await readIframeBodySize(page)
await page.locator('button[aria-label="Zoom in"]').click()
await page.waitForTimeout(500)
await page.locator('button[aria-label="Zoom in"]').click()
await page.waitForTimeout(800)
const afterZoom = await readIframeBodySize(page)
console.log('zoom: before', beforeZoom, '→ after 2× zoom-in', afterZoom)
await page.screenshot({ path: 'epub-481-step5-zoomed.png' })

writeFileSync('epub-481-log.txt', log.join('\n'))
await browser.close()

console.log('\n--- result ---')
console.log(`prev nav: forward idx=${forward.idx}, back idx=${back.idx}, delta=${back.idx - forward.idx}`)
console.log(`slider:   ${ui.sliderExists ? 'OK' : 'MISSING'}  label="${ui.pageLabel}"`)
console.log(`zoom:     rendered img w/h ${beforeZoom.imgRect?.w}/${beforeZoom.imgRect?.h} → ${afterZoom.imgRect?.w}/${afterZoom.imgRect?.h}`)
console.log(`page log: ${log.length} lines`)

async function readState(p) {
  return await p.evaluate(() => {
    const f = document.querySelector('iframe')
    const r = f?.contentDocument?.body?.querySelector('img')?.getBoundingClientRect()
    const labelEl = Array.from(document.querySelectorAll('span'))
      .find((s) => /^\s*\d+\s*\/\s*\d+\s*$/.test(s.textContent || ''))
    const m = labelEl?.textContent?.match(/(\d+)\s*\/\s*(\d+)/)
    return {
      hasIframe: !!f,
      iframeBodyChildren: f?.contentDocument?.body?.children.length ?? null,
      imgRect: r ? { w: Math.round(r.width), h: Math.round(r.height) } : null,
      idx: m ? parseInt(m[1], 10) : null,
      total: m ? parseInt(m[2], 10) : null,
    }
  })
}
async function readIframeBodySize(p) {
  return await p.evaluate(() => {
    const f = document.querySelector('iframe')
    const img = f?.contentDocument?.body?.querySelector('img')
    const cs = img ? getComputedStyle(img) : null
    return {
      imgMaxWidth: cs?.maxWidth ?? null,
      imgMaxHeight: cs?.maxHeight ?? null,
      imgRect: img ? { w: Math.round(img.getBoundingClientRect().width), h: Math.round(img.getBoundingClientRect().height) } : null,
    }
  })
}
