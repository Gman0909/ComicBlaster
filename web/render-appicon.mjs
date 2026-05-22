// Renders option-d2-two-tone.svg to a 1024×1024 PNG that becomes the
// Wails app-icon source. Wails reads client/build/appicon.png on every
// `wails build` and regenerates the platform-specific assets (.ico on
// Windows, .icns on macOS) from it, so this single PNG drives the
// branding everywhere outside the browser tab.

import { firefox } from 'playwright-core'
import { pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'

const svgPath = 'C:/Users/roame/Claude/Projects/ComicBlaster/docs/icons/option-d2-two-tone.svg'
const outPath = 'C:/Users/roame/Claude/Projects/ComicBlaster/client/build/appicon.png'
const size = 1024

// Inline the SVG into a tiny HTML doc so Firefox lays it out at exactly
// `size × size` with no scrollbar / margin / blank chrome around it.
const svg = readFileSync(svgPath, 'utf8')
const html = `<!doctype html><meta charset="utf-8"><style>
  html,body { margin:0; padding:0; background:transparent; }
  svg { display:block; width:${size}px; height:${size}px; }
</style>${svg}`

const browser = await firefox.launch({ headless: true })
const ctx = await browser.newContext({ viewport: { width: size, height: size } })
const page = await ctx.newPage()
await page.setContent(html, { waitUntil: 'networkidle' })
await page.screenshot({ path: outPath, omitBackground: false, clip: { x: 0, y: 0, width: size, height: size } })
await browser.close()
console.log(`saved ${outPath}`)
