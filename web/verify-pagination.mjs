// Verify the Reader pagination refactor against a live browser tab.
//
// Drives a Chrome tab the user has already opened + logged in (via CDP on
// :9222), picks the longest CBZ in the library, opens the reader, scrubs
// the slider rapidly across the full range, measures how long the rendered
// image lags behind the slider, exits, and asserts the library progress
// bar matches the final page.
//
// Pass condition (printed PASS / FAIL):
//   1. Image catches up to slider within 3000 ms after release
//   2. After exit, the comic's progress bar reflects the final slider page
//
// Run with:
//   node verify-pagination.mjs
//
// Prereqs: Chrome launched with --remote-debugging-port=9222, browser tab at
// http://localhost:5174 logged into ComicBlaster.

import { chromium } from 'playwright-core'

const CDP_URL = 'http://localhost:9222'
const APP_ORIGIN = process.env.CB_VERIFY_ORIGIN ?? 'http://localhost:5174'

function log(msg) { process.stdout.write(`[verify] ${msg}\n`) }
function fail(msg) { process.stdout.write(`[verify] FAIL: ${msg}\n`); process.exit(1) }

async function main() {
  const browser = await chromium.connectOverCDP(CDP_URL)
  const ctx = browser.contexts()[0]
  if (!ctx) fail('no browser context — is Chrome launched with --remote-debugging-port=9222?')
  let page = ctx.pages().find((p) => p.url().startsWith(APP_ORIGIN))
  if (!page) fail(`no tab at ${APP_ORIGIN} — open it in Chrome and log in first`)
  await page.bringToFront()
  log(`attached to tab: ${page.url()}`)

  // Pick the longest CBZ via the API (uses the page's cookie automatically).
  const cbz = await page.evaluate(async () => {
    const res = await fetch('/api/comics?per_page=500&sort=date_added&order=desc', { credentials: 'include' })
    if (!res.ok) throw new Error(`comics list returned ${res.status} — are you logged in?`)
    const data = await res.json()
    const candidates = data.comics
      .filter((c) => c.format !== 'pdf' && c.format !== 'epub' && c.page_count > 50)
      .sort((a, b) => b.page_count - a.page_count)
    return candidates[0] ?? null
  })
  if (!cbz) fail('no CBZ with >50 pages found in the library — need a long comic to test rapid scrub')
  log(`testing against "${cbz.title}" (id=${cbz.id}, ${cbz.page_count} pages)`)

  // Snapshot the existing progress so we can restore it at the end (don't
  // permanently rearrange the user's reading position).
  const originalProgress = cbz.progress?.last_page ?? null
  log(`original progress: ${originalProgress ?? '(none)'}`)

  // Reset to page 1 server-side so the scrub starts from a known position
  // (otherwise the prior position contaminates the test). seq=0 bypasses the
  // last-write-wins guard so this always takes effect.
  await page.evaluate(async (id) => {
    await fetch(`/api/comics/${id}/progress`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ last_page: 1, last_cfi: '', seq: 0 }),
    })
  }, cbz.id)
  log('reset progress to page 1 for clean test')

  // Pick a target page near the end so the scrub spans most of the bar.
  const targetPage = Math.min(cbz.page_count, Math.max(20, Math.floor(cbz.page_count * 0.85)))
  log(`target final page: ${targetPage} (scrub distance: ~${targetPage - 1} pages)`)

  // ---------- Reader: rapid scrub ----------
  // Visit the library first so the in-app Back's history(-1) lands there
  // deterministically (not on whatever page a previous test left us on).
  await page.goto(`${APP_ORIGIN}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(300)
  await page.goto(`${APP_ORIGIN}/read/${cbz.id}`, { waitUntil: 'domcontentloaded' })
  // Wait for the reader to load — img with /api/comics/{id}/pages/
  const img = page.locator(`img[src*="/api/comics/${cbz.id}/pages/"]`).first()
  await img.waitFor({ timeout: 15000 })
  log('reader loaded')

  // Move the mouse to wake the controls (auto-hide kicks in after 6s).
  await page.mouse.move(400, 400)
  await page.mouse.move(400, 401)

  const slider = page.locator('input[type=range]').first()
  await slider.waitFor({ timeout: 5000 })

  const sliderBox = await slider.boundingBox()
  if (!sliderBox) fail('slider not visible')
  // Geometry: x along the bar maps to page 1..N. Compute the x for targetPage.
  const sliderY = sliderBox.y + sliderBox.height / 2
  const leftX = sliderBox.x + 4
  const rightX = sliderBox.x + sliderBox.width - 4
  const xFor = (p) => leftX + ((p - 1) / (cbz.page_count - 1)) * (rightX - leftX)

  // Start with image showing the original page (or page 1). Record what it is.
  const startSrc = await img.getAttribute('src')
  log(`start src: ${startSrc}`)

  // Count page-image fetches during the scrub. The old bug fired one per
  // intermediate page (200-page drag → 200 fetches + 600 preloads). The new
  // scrub decoupling should produce just one or two (release + maybe one
  // debounce fire mid-drag).
  const pageRequests = []
  const reqHandler = (req) => {
    const url = req.url()
    if (url.includes(`/api/comics/${cbz.id}/pages/`)) {
      const m = url.match(/\/pages\/(\d+)/)
      if (m) pageRequests.push({ page: Number(m[1]), at: Date.now() })
    }
  }
  page.on('request', reqHandler)

  // Rapid scrub: press near the start of the bar, drag through many
  // intermediate positions, release at targetPage. Replicates the user's
  // "rapid slider" gesture. Sample 40 intermediate xs across the bar with
  // tight (5ms) gaps to actually simulate fast dragging.
  log('beginning rapid scrub …')
  pageRequests.length = 0 // reset the counter to ignore the initial page load
  const tScrubStart = Date.now()
  const startX = xFor(1)
  await page.mouse.move(startX, sliderY)
  await page.mouse.down()
  const steps = 40
  for (let i = 1; i <= steps; i++) {
    const x = startX + ((xFor(targetPage) - startX) * i) / steps
    await page.mouse.move(x, sliderY, { steps: 1 })
    await page.waitForTimeout(5)
  }
  const tRelease = Date.now()
  log(`scrub completed in ${tRelease - tScrubStart} ms (${steps} intermediate positions)`)
  await page.mouse.up()
  // The slider's released value is whatever the browser settled on — our
  // x-arithmetic above is approximate. Read the actual scrubPage and assert
  // the image catches up to THAT value.
  const releasedPage = Number(await slider.inputValue())
  log(`released slider at t=0 (slider settled on page ${releasedPage})`)

  // Wait for the rendered image's src to update to /pages/{releasedPage}.
  const expectedSrcFragment = `/pages/${releasedPage}`
  const POLL_INTERVAL_MS = 50
  const MAX_WAIT_MS = 5000
  let imageCaughtUpAt = null
  const deadline = Date.now() + MAX_WAIT_MS
  while (Date.now() < deadline) {
    const src = await img.getAttribute('src')
    if (src && src.includes(expectedSrcFragment)) {
      imageCaughtUpAt = Date.now() - tRelease
      break
    }
    await page.waitForTimeout(POLL_INTERVAL_MS)
  }
  if (imageCaughtUpAt == null) {
    const finalSrc = await img.getAttribute('src')
    log(`image did NOT catch up within ${MAX_WAIT_MS}ms — final src: ${finalSrc}`)
  } else {
    log(`image src updated to ${expectedSrcFragment} after ${imageCaughtUpAt} ms`)
  }
  // Also wait for the image to actually load (the src change isn't worth much
  // if the load takes another 20s).
  const imageLoadedAt = await page.evaluate(async (frag) => {
    const t0 = performance.now()
    const el = document.querySelector('img[src*="/api/comics/"][src*="/pages/"]')
    if (!el) return -1
    if (!el.src.includes(frag)) {
      // wait briefly for src to settle if test polled in between
      await new Promise((r) => setTimeout(r, 200))
    }
    if (el.complete && el.naturalWidth > 0) return Math.round(performance.now() - t0)
    return await new Promise((resolve) => {
      const done = () => resolve(Math.round(performance.now() - t0))
      el.addEventListener('load', done, { once: true })
      el.addEventListener('error', done, { once: true })
      setTimeout(() => resolve(-1), 15000)
    })
  }, expectedSrcFragment)
  log(`image fully loaded (decode complete) after additional ${imageLoadedAt} ms`)

  // Stop counting requests now that the scrub + load are done.
  page.off('request', reqHandler)
  log(`page-image fetches issued during/after scrub: ${pageRequests.length}`)
  pageRequests.slice(0, 10).forEach((r) => log(`  · page ${r.page} at +${r.at - tScrubStart}ms`))
  if (pageRequests.length > 10) log(`  · …and ${pageRequests.length - 10} more`)

  // ---------- Exit reader, verify library bar ----------
  log('exiting reader via in-app Back …')
  log(`url before click: ${page.url()}`)
  // Tap the page (small mouse down/up) to ensure chrome controls are visible.
  // Auto-hide is 6s from mount, so they should be, but a tap also wakes them.
  await page.mouse.move(400, 400)
  await page.mouse.down()
  await page.mouse.up()
  await page.waitForTimeout(200)
  const backBtn = page.locator('button:has-text("Back")').first()
  const visible = await backBtn.isVisible().catch(() => false)
  log(`Back button visible: ${visible}`)
  await backBtn.click({ timeout: 5000 })
  await page.waitForTimeout(300)
  log(`url after click: ${page.url()}`)
  // Library is at /
  // page.goBack() / Back button click returns once the new URL is loaded;
  // just poll the URL string ourselves (Playwright's waitForURL predicate
  // semantics vary across versions).
  {
    const t0 = Date.now()
    while (Date.now() - t0 < 5000 && /\/read\//.test(page.url())) {
      await page.waitForTimeout(50)
    }
    if (/\/read\//.test(page.url())) throw new Error(`navigation away from /read/ didn't happen — still at ${page.url()}`)
  }
  log('back at library')

  // Narrow the library to just this comic via the search box so the
  // virtualiser is guaranteed to render its card into the DOM. Clear first
  // so the key changes and the comics useQuery refetches under the new key.
  const searchTerm = (cbz.title || '').slice(0, 20).trim() || String(cbz.id)
  log(`searching library for "${searchTerm}" to surface the card`)
  const searchInputFirst = page.locator('input[placeholder*="Search"], input[type=search]').first()
  await searchInputFirst.fill('')
  await page.waitForTimeout(200)
  await searchInputFirst.fill(searchTerm)
  await page.waitForTimeout(800) // let the comics query refetch + render

  // Find the card for this comic and read the bar width.
  const barInfo = await page.evaluate(async (id) => {
    // Wait up to 3s for the card to appear (virtualizer)
    const t0 = performance.now()
    while (performance.now() - t0 < 3000) {
      const card = document.querySelector(`[data-comic-id="${id}"]`)
      if (card) {
        const bar = card.querySelector('.absolute.bottom-0.left-0.right-0.h-1 > div')
        if (bar) {
          const pct = parseFloat(bar.style.width)
          const readBadge = card.querySelector('.bg-emerald-500\\/85')
          return { found: true, pct, readBadge: !!readBadge }
        }
        // No bar — might be 100% read (full overlay) or 0%
        const readBadge = card.querySelector('.bg-emerald-500\\/85')
        return { found: true, pct: readBadge ? 100 : 0, readBadge: !!readBadge, noBar: true }
      }
      await new Promise((r) => setTimeout(r, 50))
    }
    return { found: false }
  }, cbz.id)
  if (!barInfo.found) fail(`could not find card for comic ${cbz.id} in library after exit`)

  const expectedPct = Math.round((releasedPage / cbz.page_count) * 100)
  log(`library bar reports ${barInfo.pct}% (expected ~${expectedPct}% for page ${releasedPage}/${cbz.page_count})`)

  // Also fetch the server-side progress to confirm the save actually committed.
  const serverProgress = await page.evaluate(async (id) => {
    const res = await fetch(`/api/comics/${id}`, { credentials: 'include' })
    return (await res.json()).progress?.last_page ?? null
  }, cbz.id)
  log(`server-side progress.last_page = ${serverProgress}`)

  // ---------- Second pass: exit via browser back (popstate, not in-app Back) ----------
  // The original bug report calls out both exit paths. The in-app Back goes
  // through goBack(); browser back fires only the unmount cleanup + beacon.
  // patchLibraryProgress on unmount must keep the library bar correct here too.
  log('---- second pass: exit via browser back ----')
  await page.evaluate(async (id) => {
    await fetch(`/api/comics/${id}/progress`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ last_page: 1, last_cfi: '', seq: 0 }),
    })
  }, cbz.id)
  const browserBackTarget = Math.min(cbz.page_count, Math.max(40, Math.floor(cbz.page_count * 0.5)))
  await page.goto(`${APP_ORIGIN}/read/${cbz.id}`, { waitUntil: 'domcontentloaded' })
  await img.waitFor({ timeout: 15000 })
  await page.mouse.move(400, 400); await page.mouse.move(400, 401)
  await slider.waitFor({ timeout: 5000 })
  const box2 = await slider.boundingBox()
  const y2 = box2.y + box2.height / 2
  const xFor2 = (p) => box2.x + 4 + ((p - 1) / (cbz.page_count - 1)) * (box2.width - 8)
  await page.mouse.move(xFor2(1), y2)
  await page.mouse.down()
  for (let i = 1; i <= 30; i++) {
    await page.mouse.move(xFor2(1) + ((xFor2(browserBackTarget) - xFor2(1)) * i) / 30, y2, { steps: 1 })
    await page.waitForTimeout(5)
  }
  await page.mouse.up()
  const browserBackReleased = Number(await slider.inputValue())
  log(`released slider on page ${browserBackReleased}`)
  // Give the commit + save queue a brief moment, then trigger browser back.
  // Drive via window.history rather than page.goBack() so we don't await
  // Playwright's navigation promise (it doesn't always resolve for SPA back).
  await page.waitForTimeout(50)
  await page.evaluate(() => window.history.back())
  // page.goBack() / Back button click returns once the new URL is loaded;
  // just poll the URL string ourselves (Playwright's waitForURL predicate
  // semantics vary across versions).
  {
    const t0 = Date.now()
    while (Date.now() - t0 < 5000 && /\/read\//.test(page.url())) {
      await page.waitForTimeout(50)
    }
    if (/\/read\//.test(page.url())) throw new Error(`navigation away from /read/ didn't happen — still at ${page.url()}`)
  }
  log('back at library via browser back')
  // Same search trick for the browser-back pass.
  // Clear the box first to force a state change so the comics useQuery
  // unsubscribes the old key and refetches under the new one — guarantees
  // we observe the post-save value, not whatever was cached before.
  const searchInput = page.locator('input[placeholder*="Search"], input[type=search]').first()
  await searchInput.fill('')
  await page.waitForTimeout(200)
  await searchInput.fill(searchTerm)
  await page.waitForTimeout(800) // let the refetch land
  const bar2 = await page.evaluate(async (id) => {
    const t0 = performance.now()
    while (performance.now() - t0 < 3000) {
      const card = document.querySelector(`[data-comic-id="${id}"]`)
      if (card) {
        const bar = card.querySelector('.absolute.bottom-0.left-0.right-0.h-1 > div')
        if (bar) return { found: true, pct: parseFloat(bar.style.width) }
        return { found: true, pct: card.querySelector('.bg-emerald-500\\/85') ? 100 : 0 }
      }
      await new Promise((r) => setTimeout(r, 50))
    }
    return { found: false }
  }, cbz.id)
  // Give the server a brief moment to commit the beacon write before reading
  // it back — the optimistic cache update closes the visible-bar gap, but the
  // server check needs to wait for the fire-and-forget beacon to land.
  await page.waitForTimeout(500)
  const serverProgress2 = await page.evaluate(async (id) => {
    const res = await fetch(`/api/comics/${id}`, { credentials: 'include' })
    return (await res.json()).progress?.last_page ?? null
  }, cbz.id)
  const expectedPct2 = Math.round((browserBackReleased / cbz.page_count) * 100)
  log(`library bar (after browser back) ${bar2.pct}% expected ~${expectedPct2}%, server progress=${serverProgress2}`)

  // ---------- Restore original progress so we don't leave the user's bookmark moved ----------
  if (originalProgress !== null) {
    log(`restoring original progress (page ${originalProgress}) …`)
    await page.evaluate(async ({ id, p }) => {
      await fetch(`/api/comics/${id}/progress`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ last_page: p, last_cfi: '', seq: 0 }),
      })
    }, { id: cbz.id, p: originalProgress })
  }

  // ---------- Verdict ----------
  const SRC_UPDATE_BUDGET_MS = 3000
  const passes = []
  const fails = []
  if (imageCaughtUpAt != null && imageCaughtUpAt <= SRC_UPDATE_BUDGET_MS) {
    passes.push(`image src updated within ${imageCaughtUpAt}ms (budget ${SRC_UPDATE_BUDGET_MS}ms)`)
  } else {
    fails.push(`image src lag ${imageCaughtUpAt ?? '>5000'}ms exceeds ${SRC_UPDATE_BUDGET_MS}ms budget`)
  }
  if (Math.abs(barInfo.pct - expectedPct) <= 1) {
    passes.push(`library bar matches final page (${barInfo.pct}% ~ ${expectedPct}%)`)
  } else {
    fails.push(`library bar ${barInfo.pct}% != expected ${expectedPct}% (final slider page ${releasedPage}/${cbz.page_count})`)
  }
  if (serverProgress === releasedPage) {
    passes.push(`server progress.last_page = ${releasedPage}`)
  } else {
    fails.push(`server progress.last_page = ${serverProgress}, expected ${releasedPage}`)
  }
  // Old bug: rapid scrub triggered one image fetch per intermediate page
  // (~40 here) plus preload neighbours. New behaviour: only the committed
  // page (release) fetches, possibly plus preloads of its neighbours (3).
  // Budget: ≤6 fetches in total (1 committed + up to 3 preloads + a margin).
  const FETCH_BUDGET = 6
  if (pageRequests.length <= FETCH_BUDGET) {
    passes.push(`only ${pageRequests.length} page fetches issued for a 40-step scrub (budget ${FETCH_BUDGET})`)
  } else {
    fails.push(`${pageRequests.length} page fetches issued for a 40-step scrub (budget ${FETCH_BUDGET}) — scrub-decoupling is leaking`)
  }
  // Browser-back path checks
  if (bar2.found && Math.abs(bar2.pct - expectedPct2) <= 1) {
    passes.push(`(browser back) library bar ${bar2.pct}% matches expected ${expectedPct2}%`)
  } else {
    fails.push(`(browser back) library bar ${bar2.pct}% != expected ${expectedPct2}%`)
  }
  if (serverProgress2 === browserBackReleased) {
    passes.push(`(browser back) server progress.last_page = ${browserBackReleased}`)
  } else {
    fails.push(`(browser back) server progress.last_page = ${serverProgress2}, expected ${browserBackReleased}`)
  }

  log('---- results ----')
  passes.forEach((m) => log(`PASS  ${m}`))
  fails.forEach((m) => log(`FAIL  ${m}`))
  if (fails.length === 0) {
    log('OVERALL: PASS')
    await browser.close()
    process.exit(0)
  } else {
    log('OVERALL: FAIL')
    await browser.close()
    process.exit(1)
  }
}

main().catch((err) => {
  log(`error: ${err.stack || err.message || err}`)
  process.exit(2)
})
