// Fake recognizer exercises UI/lifecycle deterministically; this does not test a provider's ASR accuracy.
import { chromium } from 'playwright'
import assert from 'node:assert/strict'
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.addInitScript(() => {
        window.__recognitions = []
        class Recognition {
            constructor() {
                window.__recognitions.push(this)
            }
            start() {
                this.onstart?.()
            }
            stop() {
                this.stopped = true
            }
            abort() {
                this.aborted = true
            }
            result(...texts) {
                this.onresult?.({
                    results: texts.map(transcript =>
                        Object.assign([{ transcript }], { isFinal: false })
                    ),
                })
            }
        }
        Object.defineProperty(window, 'SpeechRecognition', {
            configurable: true,
            value: Recognition,
        })
    })
    await page.goto(process.env.UI_TEST_URL ?? 'http://127.0.0.1:5175/')
    const input = page.getByRole('textbox', { name: '和昔涟说句话' })
    const mic = page.getByRole('button', { name: '语音输入', exact: true })
    await mic.click({ timeout: 90000 })
    assert.equal(await page.evaluate(() => window.__recognitions.length), 0)
    await page.getByText(/可能联网处理/).waitFor()
    await input.fill('今天：')
    // Editing collapses the help, so reopen it before explicitly starting.
    await mic.click()
    await page.getByRole('button', { name: '开始说话' }).click()
    await page.evaluate(() => window.__recognitions.at(-1).result('想出去'))
    assert.equal(await input.inputValue(), '今天：想出去')
    await page.evaluate(() => window.__recognitions.at(-1).result('想出去。', '一起'))
    assert.equal(await input.inputValue(), '今天：想出去。一起')
    await page.getByRole('button', { name: '停止语音输入' }).click()
    await page.evaluate(() => {
        const recognition = window.__recognitions.at(-1)
        recognition.result('想出去。', '一起走走吧。')
        recognition.onend()
    })
    assert.equal(await input.inputValue(), '今天：想出去。一起走走吧。')
    assert.equal(
        await page.evaluate(() =>
            JSON.parse(localStorage.getItem('demiurge_conversation_v1')).messages.some(
                m => m.role === 'user'
            )
        ),
        false
    )

    await mic.click()
    await page.evaluate(() => {
        window.__lateResult = window.__recognitions.at(-1).onresult
    })
    await input.fill('我改一下')
    assert.equal(await page.evaluate(() => window.__recognitions.at(-1).aborted), true)
    await page.evaluate(() =>
        window.__lateResult({
            results: [Object.assign([{ transcript: '不能覆盖' }], { isFinal: true })],
        })
    )
    assert.equal(await input.inputValue(), '我改一下')

    await mic.click()
    await page.getByRole('button', { name: '发送', exact: true }).click()
    assert.equal(await page.evaluate(() => window.__recognitions.at(-1).aborted), true)
    await mic.click()
    await page.evaluate(() => window.__recognitions.at(-1).onerror({ error: 'not-allowed' }))
    await page.getByText(/没有获得麦克风权限/).waitFor()
    await page.getByRole('button', { name: '关闭语音输入提示' }).click()
    await mic.click()
    await page.getByRole('button', { name: '静静陪伴' }).click()
    assert.equal(await page.evaluate(() => window.__recognitions.at(-1).aborted), true)
    await page.getByRole('button', { name: '和昔涟说句话' }).click()
    await mic.click()
    await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, value: true })
        document.dispatchEvent(new Event('visibilitychange'))
    })
    assert.equal(await page.evaluate(() => window.__recognitions.at(-1).aborted), true)
    assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true
    )
    await page.screenshot({ path: '/tmp/companion-speech-input.png' })
    assert.deepEqual(errors, [])

    const unsupported = await browser.newPage()
    await unsupported.addInitScript(() => {
        Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: undefined })
        Object.defineProperty(window, 'webkitSpeechRecognition', {
            configurable: true,
            value: undefined,
        })
    })
    await unsupported.goto(process.env.UI_TEST_URL ?? 'http://127.0.0.1:5175/')
    await unsupported
        .getByRole('button', { name: '语音输入', exact: true })
        .click({ timeout: 90000 })
    await unsupported.getByText(/当前浏览器不支持语音输入/).waitFor()
    assert.equal(await unsupported.getByRole('textbox', { name: '和昔涟说句话' }).isEnabled(), true)
    console.log(
        'PASS: speech input opt-in, interim corrections, final results, editing, permission failure, cancellation, unsupported browser and mobile layout'
    )
} finally {
    await browser.close()
}
