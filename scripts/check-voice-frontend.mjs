import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import init, { Frontend } from '../src/lib/voice/runtime/cyrene_voice_frontend.js'
const manifest = JSON.parse(
    await readFile(new URL('../public/voice/manifest.json', import.meta.url))
)
const tokenizer = await readFile(
    new URL(`../public/voice/${manifest.files.tokenizer.url}`, import.meta.url),
    'utf8'
)
await init({
    module_or_path: await readFile(
        new URL('../src/lib/voice/runtime/cyrene_voice_frontend_bg.wasm', import.meta.url)
    ),
})
const frontend = new Frontend(tokenizer)
for (const text of [
    '你好，伙伴。',
    '今天是2026年9月27日，花了3.14元。',
    '重庆银行今天营业吗？',
    '你好，Hello world，AI伙伴。',
    '嗯。',
]) {
    const p = JSON.parse(frontend.prepare(text))
    assert.equal(p.phones.length, p.tones.length)
    assert.equal(p.phones.length, p.languages.length)
    assert.equal(
        p.phones.length,
        p.word2ph.reduce((a, b) => a + b, 0)
    )
    assert.equal(p.input_ids.length, p.word2ph.length)
    assert.equal(p.input_ids[0], 101)
    assert.equal(p.input_ids.at(-1), 102)
    assert(p.phones.every(Number.isInteger))
    console.log(
        JSON.stringify({
            text,
            normalized: p.normalized,
            phones: p.phones.length,
            tokens: p.input_ids.length,
        })
    )
}
frontend.free()
