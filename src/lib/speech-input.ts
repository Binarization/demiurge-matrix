// Web Speech recognition is separate from the local Cyrene speech synthesizer.
// Browsers may use an online recognition service; never start without a user action.
export interface RecognitionResult {
    readonly length: number
    readonly isFinal: boolean
    readonly [index: number]: { transcript: string }
}
export interface Recognition {
    lang: string
    continuous: boolean
    interimResults: boolean
    onstart: (() => void) | null
    onresult: ((event: { results: ArrayLike<RecognitionResult> }) => void) | null
    onerror: ((event: { error: string }) => void) | null
    onend: (() => void) | null
    start(): void
    stop(): void
    abort(): void
}
export type RecognitionConstructor = new () => Recognition
export type SpeechInputState = 'idle' | 'starting' | 'listening' | 'stopping'

export function browserRecognition(): RecognitionConstructor | undefined {
    if (typeof window === 'undefined' || !window.isSecureContext) return undefined
    const host = window as unknown as {
        SpeechRecognition?: RecognitionConstructor
        webkitSpeechRecognition?: RecognitionConstructor
    }
    return host.SpeechRecognition ?? host.webkitSpeechRecognition
}

const errors: Record<string, string> = {
    'not-allowed': '没有获得麦克风权限。请在浏览器的网站设置中允许麦克风，再试一次。',
    'service-not-allowed': '这个浏览器不允许语音识别，可以换一个支持语音识别的浏览器。',
    'audio-capture': '没有找到可用的麦克风，请检查设备连接和系统权限。',
    network: '语音识别服务暂时无法连接，请检查网络，或先用文字输入。',
    'no-speech': '还没有听清，可以再说一次。',
    'language-not-supported': '当前识别服务不支持普通话，请换一个支持的浏览器。',
}

export class SpeechInput {
    private recognition: Recognition | null = null
    private stopTimer: ReturnType<typeof setTimeout> | undefined
    private startTimer: ReturnType<typeof setTimeout> | undefined
    private state: SpeechInputState = 'idle'
    onState: (state: SpeechInputState) => void = () => {}
    onText: (text: string) => void = () => {}
    onError: (message: string) => void = () => {}

    constructor(private readonly Constructor = browserRecognition()) {}

    get supported() {
        return !!this.Constructor
    }

    private setState(state: SpeechInputState) {
        this.state = state
        this.onState(state)
    }

    start(draft: string) {
        this.cancel()
        if (!this.Constructor) {
            this.onError('当前浏览器不支持语音输入。请在支持语音识别的浏览器中打开，或继续打字。')
            return
        }
        this.onError('')
        let recognition: Recognition
        try {
            recognition = new this.Constructor()
        } catch {
            this.onError('语音识别无法启动，可以稍后再试，或继续打字。')
            return
        }
        this.recognition = recognition
        recognition.lang = 'zh-CN'
        recognition.continuous = true
        recognition.interimResults = true
        const current = () => this.recognition === recognition
        recognition.onstart = () => {
            if (!current()) return
            clearTimeout(this.startTimer)
            if (this.state !== 'stopping') this.setState('listening')
        }
        recognition.onresult = event => {
            if (!current()) return
            // Each event contains the complete session snapshot, including corrected interim text.
            const text = Array.from(event.results, result => result[0]?.transcript ?? '').join('')
            const separator =
                draft && text && /[A-Za-z0-9]$/.test(draft) && /^[A-Za-z0-9]/.test(text) ? ' ' : ''
            this.onText(draft + separator + text)
        }
        recognition.onerror = event => {
            if (!current()) return
            if (event.error !== 'aborted')
                this.onError(errors[event.error] ?? '语音识别暂时不可用，可以再试一次或继续打字。')
            this.cancel()
        }
        recognition.onend = () => {
            if (current()) this.release()
        }
        this.setState('starting')
        this.startTimer = setTimeout(() => {
            if (!current()) return
            this.onError('麦克风暂时没有启动。请检查权限，再试一次。')
            this.cancel()
        }, 30000)
        try {
            recognition.start()
        } catch {
            this.onError('无法启动麦克风，请检查浏览器权限后再试。')
            this.cancel()
        }
    }

    stop() {
        if (!this.recognition || this.state === 'stopping') return
        this.setState('stopping')
        clearTimeout(this.startTimer)
        // Keep final results briefly; a broken service must not leave the mic active indefinitely.
        this.stopTimer = setTimeout(() => this.cancel(), 2000)
        try {
            this.recognition.stop()
        } catch {
            this.cancel()
        }
    }

    private release() {
        const recognition = this.recognition
        this.recognition = null
        clearTimeout(this.stopTimer)
        clearTimeout(this.startTimer)
        if (recognition) {
            recognition.onstart = null
            recognition.onresult = null
            recognition.onerror = null
            recognition.onend = null
        }
        this.setState('idle')
        return recognition
    }

    cancel() {
        const recognition = this.release()
        try {
            recognition?.abort()
        } catch {
            /* Already ended. */
        }
    }
}
