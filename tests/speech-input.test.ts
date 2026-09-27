import { expect, test } from 'bun:test'
import { SpeechInput, type Recognition } from '../src/lib/speech-input'

class FakeRecognition implements Recognition {
    static instances: FakeRecognition[] = []
    lang = ''
    continuous = false
    interimResults = false
    onstart: Recognition['onstart'] = null
    onresult: Recognition['onresult'] = null
    onerror: Recognition['onerror'] = null
    onend: Recognition['onend'] = null
    aborted = false
    stopped = false
    constructor() {
        FakeRecognition.instances.push(this)
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
    result(...texts: string[]) {
        this.onresult?.({
            results: texts.map(text => Object.assign([{ transcript: text }], { isFinal: false })),
        })
    }
}
const latest = () => FakeRecognition.instances.at(-1)!
test('recognition updates draft snapshots without duplicating interim or final text', () => {
    const input = new SpeechInput(FakeRecognition)
    let draft = ''
    input.onText = text => {
        draft = text
    }
    input.start('今天：')
    const recognition = latest()
    recognition.result('我想')
    expect(draft).toBe('今天：我想')
    recognition.result('我想出去。', '一起')
    expect(draft).toBe('今天：我想出去。一起')
    recognition.result('我想出去。', '一起散步吧。')
    expect(draft).toBe('今天：我想出去。一起散步吧。')
    input.stop()
    expect(recognition.stopped).toBe(true)
    recognition.result('我想出去。', '一起散步吧！')
    recognition.onend?.()
    expect(draft).toBe('今天：我想出去。一起散步吧！')
})
test('editing, sending or leaving cancels and ignores callbacks from an old microphone session', () => {
    const input = new SpeechInput(FakeRecognition)
    let draft = ''
    input.onText = text => {
        draft = text
    }
    input.start('')
    const first = latest(),
        late = first.onresult!
    first.result('你好')
    input.cancel()
    expect(first.aborted).toBe(true)
    input.start('修改后的')
    late({ results: [Object.assign([{ transcript: '旧结果' }], { isFinal: true })] })
    expect(draft).toBe('你好')
    latest().result('新结果')
    expect(draft).toBe('修改后的新结果')
    input.cancel()
})
test('permission and network failures release the microphone and preserve draft', () => {
    for (const error of ['not-allowed', 'audio-capture', 'network', 'no-speech']) {
        const input = new SpeechInput(FakeRecognition)
        let state = '',
            message = '',
            draft = ''
        input.onState = next => {
            state = next
        }
        input.onError = next => {
            message = next
        }
        input.onText = next => {
            draft = next
        }
        input.start('原稿')
        const recognition = latest()
        recognition.result('留下的话')
        recognition.onerror?.({ error })
        expect(state).toBe('idle')
        expect(message.length).toBeGreaterThan(0)
        expect(recognition.aborted).toBe(true)
        expect(draft).toBe('原稿留下的话')
    }
})
test('unsupported browsers give a text fallback without starting audio', () => {
    const input = new SpeechInput()
    let error = ''
    input.onError = message => {
        error = message
    }
    expect(input.supported).toBe(false)
    input.start('')
    expect(error).toContain('不支持语音输入')
})
test('stop times out rather than keeping a stalled service active', async () => {
    const input = new SpeechInput(FakeRecognition)
    let state = ''
    input.onState = next => {
        state = next
    }
    input.start('')
    const recognition = latest()
    input.stop()
    await new Promise(resolve => setTimeout(resolve, 2100))
    expect(recognition.aborted).toBe(true)
    expect(state).toBe('idle')
})
