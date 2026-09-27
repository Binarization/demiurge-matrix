// Real SDK SSE parsing + real local ONNX/audio, with a deterministic fake LLM.
import { chromium } from 'playwright'
import assert from 'node:assert/strict'
const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--enable-unsafe-webgpu', '--autoplay-policy=no-user-gesture-required'],
})
try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } })
    // Never send the fixture key or requests to an actual provider.
    await context.route('https://openrouter.ai/**', route => route.abort())
    await context.addInitScript(() => {
        window.__voiceTest = {
            sounds: 0,
            firstSound: 0,
            llmDone: false,
            streamCount: 0,
            aborted: false,
        }
        Object.defineProperty(window, 'speechSynthesis', {
            configurable: true,
            get() {
                throw new Error('Native speech synthesis was accessed')
            },
        })
        localStorage.setItem(
            'demiurge_openrouter_config',
            JSON.stringify({ apiKey: 'local-test-fixture', model: 'fixture' })
        )
        if (!localStorage.getItem('demiurge_conversation_v1'))
            localStorage.setItem(
                'demiurge_conversation_v1',
                JSON.stringify({
                    version: 1,
                    messages: [
                        {
                            id: 'g',
                            role: 'assistant',
                            content: '你好，伙伴。',
                            timestamp: 1,
                            status: 'complete',
                        },
                    ],
                    voiceEnabled: false,
                    voiceBackend: 'webgpu',
                })
            )
        const create = AudioContext.prototype.createBufferSource
        AudioContext.prototype.createBufferSource = function (...args) {
            const source = create.apply(this, args),
                start = source.start.bind(source)
            source.start = (...parameters) => {
                window.__voiceTest.sounds++
                window.__voiceTest.firstSound ||= performance.now()
                return start(...parameters)
            }
            return source
        }
        const original = window.fetch.bind(window)
        window.fetch = async (input, init) => {
            const request = new Request(input, init)
            if (!request.url.includes('openrouter.ai')) return original(input, init)
            const body = await request.clone().json()
            if (!body.stream) {
                const planning = body.tools?.some(t => t.function.name === 'begin_response')
                return new Response(
                    JSON.stringify({
                        id: 'fixture',
                        object: 'chat.completion',
                        created: 1,
                        model: 'fixture',
                        choices: [
                            {
                                index: 0,
                                finish_reason: planning ? 'tool_calls' : 'stop',
                                message: planning
                                    ? {
                                          role: 'assistant',
                                          content: '此段工具说明绝不能朗读',
                                          tool_calls: [
                                              {
                                                  id: 'route1',
                                                  type: 'function',
                                                  function: {
                                                      name: 'begin_response',
                                                      arguments: '{}',
                                                  },
                                              },
                                          ],
                                      }
                                    : { role: 'assistant', content: '[]' },
                            },
                        ],
                    }),
                    { headers: { 'Content-Type': 'application/json' } }
                )
            }
            window.__voiceTest.llmDone = false
            window.__voiceTest.streamCount++
            const encoder = new TextEncoder()
            let timer
            let closed = false
            const pieces = ['<emo', 'te happy=0.5 />', '你好，', '伙伴。']
            return new Response(
                new ReadableStream({
                    start(controller) {
                        const emit = (content, finish = null) =>
                            controller.enqueue(
                                encoder.encode(
                                    'data: ' +
                                        JSON.stringify({
                                            id: 'fixture',
                                            object: 'chat.completion.chunk',
                                            created: 1,
                                            model: 'fixture',
                                            choices: [
                                                {
                                                    index: 0,
                                                    delta: { content },
                                                    finish_reason: finish,
                                                },
                                            ],
                                        }) +
                                        '\n\n'
                                )
                            )
                        let i = 0
                        const tick = () => {
                            if (closed) return
                            if (i < pieces.length) {
                                emit(pieces[i++])
                                timer = setTimeout(tick, 80)
                            } else
                                timer = setTimeout(() => {
                                    if (closed) return
                                    emit('我们慢慢聊，好吗？')
                                    emit('', 'stop')
                                    controller.enqueue(encoder.encode('data: [DONE]\n\n'))
                                    window.__voiceTest.llmDone = true
                                    closed = true
                                    controller.close()
                                }, 6500)
                        }
                        request.signal.addEventListener(
                            'abort',
                            () => {
                                if (closed) return
                                closed = true
                                clearTimeout(timer)
                                window.__voiceTest.aborted = true
                                controller.error(new DOMException('Aborted', 'AbortError'))
                            },
                            { once: true }
                        )
                        tick()
                    },
                    cancel() {
                        closed = true
                        clearTimeout(timer)
                    },
                }),
                { headers: { 'Content-Type': 'text/event-stream' } }
            )
        }
    })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', e => errors.push(e.message))
    await page.goto(process.env.VOICE_TEST_URL ?? 'http://127.0.0.1:5175/')
    await page.getByRole('button', { name: '打开设置' }).click({ timeout: 60000 })
    const toggle = page.getByLabel('朗读昔涟的回复')
    assert.equal(await toggle.isEnabled(), false)
    assert.equal(await page.getByLabel('声音来源').locator('option').count(), 2)
    await page.getByRole('button', { name: '加载角色声音' }).click()
    await page
        .getByText('角色声音已就绪（WebGPU / WASM）', { exact: true })
        .waitFor({ timeout: 180000 })
    assert.equal(await toggle.isEnabled(), true)
    await toggle.check()
    await page.getByRole('button', { name: '×', exact: true }).click()
    await page.getByPlaceholder('输入你想说的话...').fill('讲一句话给我听')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await page.waitForFunction(() => window.__voiceTest.sounds > 0, {}, { timeout: 120000 })
    assert.equal(
        await page.evaluate(() => window.__voiceTest.llmDone),
        false,
        'first audio must precede final LLM text'
    )
    assert.equal(
        await page.evaluate(
            () =>
                JSON.parse(localStorage.getItem('demiurge_conversation_v1')).messages.at(-1).status
        ),
        'pending'
    )
    await page.waitForFunction(() => window.__voiceTest.llmDone)
    await page.waitForFunction(
        () =>
            JSON.parse(localStorage.getItem('demiurge_conversation_v1')).messages.at(-1).status ===
            'complete'
    )
    await page
        .getByRole('button', { name: '打断', exact: true })
        .waitFor({ state: 'hidden', timeout: 30000 })
    let transcript = await page.evaluate(
        () => JSON.parse(localStorage.getItem('demiurge_conversation_v1')).messages
    )
    assert.equal(transcript.at(-1).content, '<emote happy=0.5 />你好，伙伴。我们慢慢聊，好吗？')
    const sounds = await page.evaluate(() => window.__voiceTest.sounds)
    assert.equal(sounds, 2, 'must not re-read the full answer after stream completion')
    await page.getByPlaceholder('输入你想说的话...').fill('再说一句')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await page.waitForFunction(previous => window.__voiceTest.sounds > previous, sounds)
    await page.getByRole('button', { name: '打断', exact: true }).click()
    const afterStop = await page.evaluate(() => window.__voiceTest.sounds)
    await page.waitForTimeout(7000)
    assert.equal(await page.evaluate(() => window.__voiceTest.sounds), afterStop)
    transcript = await page.evaluate(
        () => JSON.parse(localStorage.getItem('demiurge_conversation_v1')).messages
    )
    assert.equal(transcript.at(-1).status, 'interrupted')
    assert.equal(transcript.at(-1).content, '<emote happy=0.5 />你好，伙伴。')
    assert.deepEqual(errors, [])
    const unavailable = await browser.newPage()
    await unavailable.route('**/voice/manifest.json', route =>
        route.fulfill({ status: 404, body: 'missing' })
    )
    await unavailable.goto(process.env.VOICE_TEST_URL ?? 'http://127.0.0.1:5175/')
    await unavailable.getByLabel('声音来源').waitFor({ timeout: 60000 })
    const disabledToggle = unavailable.getByLabel('朗读昔涟的回复')
    assert.equal(await disabledToggle.isEnabled(), false)
    await unavailable.getByRole('button', { name: '加载角色声音' }).click()
    await unavailable.getByText(/未找到本地声音模型/).waitFor()
    assert.equal(await disabledToggle.isEnabled(), false)
    assert.equal(await disabledToggle.isChecked(), false)
    await unavailable.close()

    console.log(
        'PASS: real WebGPU audio before final SSE text; no full-answer replay; cancellation preserves partial transcript; native speech never accessed'
    )
} finally {
    await browser.close()
}
