// Run against a production preview. No API credentials or model download required.
import { chromium } from 'playwright'
import assert from 'node:assert/strict'

const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
    const page = await browser.newPage({
        viewport: { width: 1440, height: 960 },
        reducedMotion: 'reduce',
    })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.addInitScript(() => {
        localStorage.setItem(
            'demiurge_conversation_v1',
            JSON.stringify({
                version: 1,
                voiceEnabled: false,
                voiceBackend: 'webgpu',
                messages: Array.from({ length: 40 }, (_, i) => ({
                    id: String(i),
                    role: i % 2 ? 'assistant' : 'user',
                    content: '第 ' + i + ' 次共同经历。',
                    timestamp: Date.now() + i,
                    status: 'complete',
                })),
            })
        )
        window.__musicStarts = 0
        HTMLMediaElement.prototype.play = async function () {
            window.__musicStarts++
        }
    })
    await page.goto(process.env.UI_TEST_URL ?? 'http://127.0.0.1:5175/')
    const quiet = page.getByRole('button', { name: '静静陪伴' })
    await quiet.click({ trial: true, timeout: 90000 })
    assert.equal(await page.getByRole('dialog').count(), 0, 'entry must not open settings')
    const composer = page.getByRole('textbox', { name: '和昔涟说句话' })
    await composer.fill('今天')
    const before = await page.evaluate(() => localStorage.getItem('demiurge_conversation_v1'))
    await composer.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true })
    assert.equal(await composer.inputValue(), '今天', 'IME confirmation must not send')
    assert.equal(
        await page.evaluate(() => localStorage.getItem('demiurge_conversation_v1')),
        before
    )

    await quiet.click()
    assert.equal(await composer.isVisible(), false)
    const returnButton = page.getByRole('button', { name: '和昔涟说句话' })
    assert.equal(await returnButton.evaluate(el => el === document.activeElement), true)
    await returnButton.click()
    assert.equal(await composer.evaluate(el => el === document.activeElement), true)
    assert.equal(
        await page.evaluate(() => window.__musicStarts),
        0,
        'ordinary interaction must remain silent'
    )
    await page.getByRole('button', { name: '开启背景音乐' }).click()
    assert.equal(await page.evaluate(() => window.__musicStarts), 1)
    await page.getByRole('button', { name: '关闭背景音乐' }).click()

    await page.getByRole('button', { name: '打开设置' }).click()
    const settings = page.getByRole('dialog', { name: '偏好' })
    assert.equal(await settings.getByRole('switch').isEnabled(), false)
    await page.keyboard.press('Escape')
    await settings.waitFor({ state: 'hidden' })
    assert.equal(
        await page
            .getByRole('button', { name: '打开设置' })
            .evaluate(el => el === document.activeElement),
        true
    )

    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('button', { name: '打开共同经历' }).click()
    await page.waitForFunction(() => {
        const history = document.querySelector('.conversation-pages')
        return history && history.scrollHeight - history.scrollTop - history.clientHeight < 5
    })
    await page.getByRole('button', { name: '记忆管理' }).click()
    const memory = page.getByRole('dialog', { name: '记住的小事' })
    await memory.waitFor()
    assert.equal(await memory.evaluate(el => el.scrollWidth <= el.clientWidth), true)
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: '打开设置' }).click()
    assert.equal(await settings.evaluate(el => el.scrollWidth <= el.clientWidth), true)
    await settings.getByRole('button', { name: '保存', exact: true }).scrollIntoViewIfNeeded()
    assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true
    )
    assert.deepEqual(errors, [])
    console.log(
        'PASS: quiet entry, explicit music, IME, keyboard focus, mobile sheets and memory access'
    )
} finally {
    await browser.close()
}
