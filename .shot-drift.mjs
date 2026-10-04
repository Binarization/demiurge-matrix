import { chromium } from 'playwright'
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const errors = []
page.on('pageerror', e => errors.push(e.message))
await page.addInitScript(() => { localStorage.setItem('demiurge_openrouter_config', JSON.stringify({ apiKey: 'sk-test', model: 'x' })) })
await page.goto('http://127.0.0.1:5177/')
await page.getByRole('button').filter({ hasText: /陪伴|进入|开始|走进/ }).first().click({ timeout: 120000 })
await page.waitForTimeout(8000)
const a = await page.screenshot({ clip: { x: 100, y: 100, width: 300, height: 200 } })
await page.waitForTimeout(3000)
const b = await page.screenshot({ clip: { x: 100, y: 100, width: 300, height: 200 } })
console.log('errors:', errors, 'background changed between frames:', !a.equals(b))
await browser.close()
