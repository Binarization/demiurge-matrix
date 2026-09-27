import { expect, test } from 'bun:test'
import { consumeChatStream } from '../src/lib/chat-stream'
import { PhraseStream, SpeechTextFilter } from '../src/lib/voice/phrase-stream'
const chunk = (delta: any, finishReason: string | null = null) => ({
    data: { choices: [{ index: 0, delta, finishReason }] },
})
test('SDK envelopes deliver deltas before completion and ignore reasoning', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => {
        release = r
    })
    async function* source() {
        yield chunk({ reasoning: 'internal', content: '你' })
        await gate
        yield chunk({ content: '好' })
        yield chunk({}, 'stop')
    }
    const deltas: string[] = []
    const result = consumeChatStream(source(), d => deltas.push(d))
    await new Promise(r => setTimeout(r, 0))
    expect(deltas).toEqual(['你'])
    release()
    expect(await result).toBe('你好')
})
test('truncated stream preserves delivered text but fails completion', async () => {
    const deltas: string[] = []
    async function* source() {
        yield chunk({ content: '还没说完' })
    }
    await expect(consumeChatStream(source(), d => deltas.push(d))).rejects.toThrow('提前断开')
    expect(deltas).toEqual(['还没说完'])
})
test('aborted and tool-bearing answer streams never leak tool arguments', async () => {
    const abort = new AbortController()
    abort.abort()
    async function* source() {
        yield chunk({ content: 'stale' })
    }
    const deltas: string[] = []
    await expect(consumeChatStream(source(), d => deltas.push(d), abort.signal)).rejects.toThrow()
    async function* tools() {
        yield chunk({ toolCalls: [{ function: { arguments: 'secret' } }], content: 'preamble' })
    }
    await expect(consumeChatStream(tools(), d => deltas.push(d))).rejects.toThrow('工具调用')
    expect(deltas).toEqual([])
})
test('split emotion tags never become spoken text', () => {
    const filter = new SpeechTextFilter()
    expect(filter.push('<emo')).toBe('')
    expect(filter.push('te happy=0.7 /')).toBe('')
    expect(filter.push('>你好，伙伴。')).toBe('你好，伙伴。')
})
test('first phrase arrives before stream end, tail flushes exactly once', async () => {
    const stream = new PhraseStream(1000)
    stream.push('<emote sad=0.2 />你好，伙伴。后面')
    expect(await stream.next()).toBe('你好，伙伴。')
    stream.push('还有一句。')
    stream.end()
    stream.end()
    expect(await stream.next()).toBe('后面还有一句。')
    expect(await stream.next()).toBeNull()
})
test('latency timer releases a safe Chinese phrase without punctuation', async () => {
    const stream = new PhraseStream(5)
    stream.push('我们可以一起去看看')
    expect(await stream.next()).toBe('我们可以一起去看看')
    stream.end()
    expect(await stream.next()).toBeNull()
})
test('decimal split across tokens and incomplete Latin words stay together', async () => {
    const stream = new PhraseStream(1000)
    stream.push('花了3.')
    stream.push('14元，Hello')
    stream.push(' world。')
    stream.end()
    const parts: string[] = []
    let part: string | null
    while ((part = await stream.next()) !== null) parts.push(part)
    expect(parts.join('')).toBe('花了3.14元，Hello world。')
    expect(parts.some(p => p.includes('3.14'))).toBe(true)
    expect(parts.some(p => p.includes('Hello world'))).toBe(true)
})
test('cancel drops queued phrases and settles pending readers', async () => {
    const stream = new PhraseStream(1000)
    stream.push('你好，伙伴。残留')
    stream.cancel()
    expect(await stream.next()).toBeNull()
    const second = new PhraseStream()
    const waiting = second.next()
    second.cancel()
    expect(await waiting).toBeNull()
    second.push('不会再播放。')
    expect(await second.next()).toBeNull()
})

test('long unpunctuated Chinese text is bounded without dropping characters', async () => {
    const stream = new PhraseStream(1000),
        input = '我们一起去看花'.repeat(100)
    stream.push(input)
    stream.end()
    const parts: string[] = []
    let part: string | null
    while ((part = await stream.next()) !== null) parts.push(part)
    expect(parts.join('')).toBe(input)
    expect(parts.every(p => p.length <= 80)).toBe(true)
})
