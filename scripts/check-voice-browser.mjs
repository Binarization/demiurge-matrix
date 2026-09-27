// Run against `npm run preview -- --port 5175` after preparing models/building.
import { chromium } from 'playwright'
import assert from 'node:assert/strict'
const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--enable-unsafe-webgpu', '--autoplay-policy=no-user-gesture-required'],
})
try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } })
    const errors = []
    page.on('pageerror', e => errors.push(e.message))
    await page.goto(process.env.VOICE_TEST_URL ?? 'http://127.0.0.1:5175/')
    // First launch opens settings automatically when no API key is configured.
    const source = page.getByLabel('声音来源')
    await source.waitFor({ timeout: 60000 })
    await source.selectOption('webgpu')
    await page.getByRole('button', { name: '加载角色声音' }).click()
    await page
        .getByText('角色声音已就绪（WebGPU / WASM）', { exact: true })
        .waitFor({ timeout: 180000 })
    await page.getByRole('button', { name: '试听昔涟声音' }).click()
    await page.getByText('正在说话', { exact: true }).waitFor({ timeout: 120000 })
    await page.getByRole('button', { name: '×', exact: true }).click()
    await page.getByRole('button', { name: '打断', exact: true }).click()
    await page.getByRole('button', { name: '打断', exact: true }).waitFor({ state: 'hidden' })
    await page.reload()
    await source.waitFor({ timeout: 60000 })
    assert.equal(await source.inputValue(), 'webgpu')
    await page.getByRole('button', { name: '加载角色声音' }).click()
    await page.getByText('角色声音已就绪（WebGPU / WASM）', { exact: true }).waitFor({ timeout: 180000 })
    // Cancel during generation, then immediately create a replacement worker.
    await page.getByRole('button', { name: '试听昔涟声音' }).click()
    await page.getByRole('button', { name: '×', exact: true }).click()
    await page.getByRole('button', { name: '打断', exact: true }).click()
    await page.getByRole('button', { name: '打开设置' }).click()
    await page.getByRole('button', { name: '试听昔涟声音' }).click()
    await page.getByText('正在说话', { exact: true }).waitFor({ timeout: 180000 })
    assert.deepEqual(errors, [])
    console.log(
        'PASS: production WebGPU playback, interruption, settings restore and restart after cancellation'
    )
} finally {
    await browser.close()
}
