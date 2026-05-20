import { chromium } from 'playwright'
import fs from 'node:fs'
const targets = [
  { url: 'https://www.kimi.com/', name: 'kimi-home' },
  { url: 'https://agent.minimax.io/features/zh.html', name: 'minimax-agent-features' },
  { url: 'http://127.0.0.1:5173/', name: 'xfusion-home' },
]
const browser = await chromium.launch({ headless: true })
for (const target of targets) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 })
  try {
    await page.goto(target.url, { waitUntil: 'networkidle', timeout: 120000 })
    await page.screenshot({ path: `tmp/bench/${target.name}.png`, fullPage: true })
    console.log('ok', target.name)
  } catch (err) {
    console.log('fail', target.name, String(err))
  } finally {
    await page.close()
  }
}
await browser.close()
