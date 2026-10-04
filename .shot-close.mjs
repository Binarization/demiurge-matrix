import { chromium } from 'playwright'
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
await page.addInitScript(() => {
    localStorage.setItem('demiurge_conversation_v1', JSON.stringify({ version: 1, voiceEnabled: false, voiceBackend: 'webgpu', messages: [
        { id: 'b', role: 'user', content: '今天有点累。', timestamp: Date.now() - 500000, status: 'complete' },
        { id: 'c', role: 'assistant', content: '<emote relaxed=0.3/> 辛苦了。', timestamp: Date.now() - 490000, status: 'complete' }] }))
    localStorage.setItem('demiurge_openrouter_config', JSON.stringify({ apiKey: 'sk-test', model: 'x' }))
})
await page.goto('http://127.0.0.1:5177/')
await page.getByRole('button').filter({ hasText: /陪伴|进入|开始|走进/ }).first().click({ timeout: 120000 })
await page.waitForTimeout(6000)
await page.getByRole('button', { name: '打开互动' }).click()
await page.waitForTimeout(500)
const close = page.getByRole('button').filter({ hasText: /近一点看/ }).first()
await close.click().catch(e => console.log('no close view', e.message.split('\n')[0]))
await page.keyboard.press('Escape')
await page.waitForTimeout(2500)
await page.screenshot({ path: process.argv[2] ?? '/tmp/ui-close.png' })
await browser.close()
