import { chromium } from 'playwright'
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
await page.addInitScript(() => {
    localStorage.setItem('demiurge_conversation_v1', JSON.stringify({ version: 1, voiceEnabled: false, voiceBackend: 'webgpu', messages: [
        { id: 'b', role: 'user', content: '今天有点累。', timestamp: Date.now() - 500000, status: 'complete' },
        { id: 'c', role: 'assistant', content: '<emote relaxed=0.3/> 辛苦了。先坐一会儿吧。', timestamp: Date.now() - 490000, status: 'complete' }] }))
    localStorage.setItem('demiurge_openrouter_config', JSON.stringify({ apiKey: 'sk-test', model: 'x' }))
})
const t0 = Date.now()
await page.goto('http://127.0.0.1:5177/')
const enter = page.getByRole('button').filter({ hasText: /陪伴|进入|开始|走进/ }).first()
try { await enter.click({ timeout: 120000 }); console.log('entered after', Date.now() - t0, 'ms') } catch (e) { console.log('enter fail', e.message.split('\n')[0]) }
await page.waitForTimeout(6000)
await page.getByRole('button', { name: /和昔涟说句话/ }).click().catch(e => console.log('no quiet-return button', e.message.split('\n')[0]))
await page.waitForTimeout(1500)
console.log('gl:', await page.evaluate(() => { const c = document.createElement('canvas'); const gl = c.getContext('webgl2'); const d = gl?.getExtension('WEBGL_debug_renderer_info'); return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'none' }))
await page.screenshot({ path: '/tmp/ui-dock.png' })
await browser.close()
