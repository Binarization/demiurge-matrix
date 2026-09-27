import { PhraseStream } from './phrase-stream'
export type VoiceBackend = 'webgpu' | 'wasm'
export interface VoiceCallbacks {
    start: () => void
    pause?: () => void
    end: () => void
    error: () => void
    level?: (value: number | null) => void
}
interface Reply {
    type: string
    id?: number
    error?: string
    text?: string
    pcm?: Float32Array
    metrics?: Record<string, number | string>
}
export class LocalVoiceController {
    private worker: Worker | null = null
    private pending = new Map<number, { resolve: (r: Reply) => void; reject: (e: Error) => void }>()
    private nextId = 0
    private ready: Promise<Reply> | null = null
    private mode: 'webgpu' | 'wasm' = 'webgpu'
    private generation = 0
    private context: AudioContext | null = null
    private source: AudioBufferSourceNode | null = null
    private finish: (() => void) | null = null
    private frame = 0
    private phrases: PhraseStream | null = null
    private warmed = false
    onReady = (_ready: boolean) => {}
    onStatus = (_text: string) => {}
    onMetrics = (_metrics: Record<string, number | string>) => {}
    get available() {
        return typeof Worker !== 'undefined' && typeof AudioContext !== 'undefined'
    }
    get isReady() {
        return this.warmed
    }
    private resetWorker() {
        this.worker?.terminate()
        this.worker = null
        this.ready = null
        for (const p of this.pending.values()) p.reject(new Error('语音已取消'))
        this.pending.clear()
        this.warmed = false
        this.onReady(false)
    }
    private request(type: string, extra: Record<string, unknown> = {}) {
        const id = ++this.nextId
        return new Promise<Reply>((resolve, reject) => {
            this.pending.set(id, { resolve, reject })
            this.worker!.postMessage({ type, id, ...extra })
        })
    }
    initialize(mode: 'webgpu' | 'wasm') {
        if (mode !== this.mode) {
            this.stop()
            this.resetWorker()
            this.mode = mode
        }
        if (this.ready) return this.ready
        this.worker = new Worker(new URL('./voice.worker.ts', import.meta.url), { type: 'module' })
        const worker = this.worker
        this.onReady(false)
        this.worker.onmessage = ({ data }: MessageEvent<Reply>) => {
            if (this.worker !== worker) return
            if (data.type === 'status') {
                this.onStatus(data.text ?? '')
                return
            }
            const p = this.pending.get(data.id!)
            if (!p) return
            this.pending.delete(data.id!)
            if (data.type === 'error') p.reject(new Error(data.error))
            else p.resolve(data)
        }
        this.worker.onerror = event => {
            if (this.worker === worker) {
                this.onStatus(`语音工作线程出错：${event.message}`)
                this.resetWorker()
            }
        }
        this.ready = this.request('init', {
            base: new URL(`${import.meta.env.BASE_URL}voice/`, location.href).href,
            mode,
        }).then(reply => {
            if (this.worker !== worker) throw new Error('声音加载已取消')
            this.warmed = true
            this.onReady(true)
            return reply
        })
        this.ready.catch(e => {
            if (this.worker === worker) {
                this.onStatus(String(e))
                this.resetWorker()
            }
        })
        return this.ready
    }
    /** Call on an explicit user click to satisfy browser autoplay policy. */
    async unlock() {
        this.context ??= new AudioContext()
        await this.context.resume()
    }
    stop() {
        this.generation++
        cancelAnimationFrame(this.frame)
        this.source?.stop()
        this.source = null
        this.phrases?.cancel()
        this.phrases = null
        this.finish?.()
        this.finish = null
        // Discard any in-flight result, but keep warmed sessions for the next turn.
        // The worker serializes calls, so at most the previous chunk needs to drain.
    }
    dispose() {
        this.stop()
        this.resetWorker()
        void this.context?.close()
        this.context = null
    }
    speak(text: string, mode: VoiceBackend, callbacks: VoiceCallbacks): boolean {
        if (!text.trim()) return false
        const stream = this.beginStream(mode, callbacks)
        if (!stream) return false
        stream.push(text)
        stream.end()
        return true
    }
    beginStream(mode: VoiceBackend, callbacks: VoiceCallbacks): PhraseStream | null {
        this.stop()
        if (!this.available || !this.warmed || this.mode !== mode) return null
        const generation = this.generation
        const phrases = new PhraseStream()
        this.phrases = phrases
        let ended = false
        const end = () => {
            if (ended) return
            ended = true
            callbacks.level?.(null)
            callbacks.end()
        }
        this.finish = end
        const synthNext = async (): Promise<Float32Array | null> => {
            const chunk = await phrases.next()
            if (chunk === null || generation !== this.generation) return null
            const reply = await this.request('synthesize', { text: chunk })
            if (generation !== this.generation) return null
            if (reply.metrics) this.onMetrics(reply.metrics)
            return reply.pcm!
        }
        void (async () => {
            await this.unlock()
            if (generation !== this.generation) return
            let pcm = await synthNext()
            while (pcm && generation === this.generation) {
                const playing = this.play(pcm, generation, callbacks)
                const next = synthNext()
                next.catch(() => {}) // Rejection must be handled while audio is playing.
                await playing
                pcm = await next
            }
        })()
            .catch(error => {
                if (generation === this.generation) {
                    this.onStatus(String(error))
                    this.resetWorker()
                    callbacks.error()
                }
            })
            .finally(() => {
                if (generation === this.generation) {
                    phrases.cancel()
                    this.phrases = null
                    this.finish = null
                    end()
                }
            })
        return phrases
    }
    private play(pcm: Float32Array, generation: number, callbacks: VoiceCallbacks) {
        const context = this.context!,
            buffer = context.createBuffer(1, pcm.length, 44100)
        buffer.copyToChannel(new Float32Array(pcm), 0)
        const source = context.createBufferSource()
        source.buffer = buffer
        const analyser = context.createAnalyser()
        analyser.fftSize = 256
        source.connect(analyser)
        analyser.connect(context.destination)
        this.source = source
        const samples = new Float32Array(analyser.fftSize)
        const tick = () => {
            if (generation !== this.generation) return
            analyser.getFloatTimeDomainData(samples)
            let energy = 0
            for (const x of samples) energy += x * x
            callbacks.level?.(Math.min(0.85, Math.sqrt(energy / samples.length) * 4))
            this.frame = requestAnimationFrame(tick)
        }
        return new Promise<void>((resolve, reject) => {
            source.onended = () => {
                source.disconnect()
                analyser.disconnect()
                if (this.source === source) this.source = null
                if (generation === this.generation) {
                    cancelAnimationFrame(this.frame)
                    callbacks.level?.(0)
                    callbacks.pause?.()
                }
                resolve()
            }
            try {
                source.start()
                callbacks.start()
                tick()
            } catch (e) {
                source.disconnect()
                analyser.disconnect()
                reject(e)
            }
        })
    }
}
