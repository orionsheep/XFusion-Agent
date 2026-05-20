import { chromium } from 'playwright'
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
for (const url of ['https://minimaxi.com/', 'https://www.minimaxi.com/', 'https://www.minimax.io/']) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.screenshot({ path: 'tmp/bench/minimax-home.png', fullPage: true })
    console.log('ok', url)
    break
  } catch (err) {
    console.log('fail', url, String(err))
  }
}
await browser.close()
