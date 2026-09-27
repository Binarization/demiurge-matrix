/** Strip tags across arbitrary token boundaries, including the leading emote tag. */
export class SpeechTextFilter {
    private inTag = false
    push(delta: string): string {
        let result = ''
        for (const c of delta) {
            if (c === '<') this.inTag = true
            else if (c === '>' && this.inTag) this.inTag = false
            else if (!this.inTag) result += c
        }
        return result
    }
}

/** Text queue with a short first phrase and a maximum wait at safe boundaries.
 * Numeric/Latin runs are never split by the latency timer. PCM buffering is
 * independently bounded to one playing chunk and one synthesized lookahead. */
export class PhraseStream {
    private filter = new SpeechTextFilter()
    private pending = ''
    private queue: string[] = []
    private waiter: ((value: string | null) => void) | null = null
    private timer: ReturnType<typeof setTimeout> | undefined
    private closed = false
    private first = true
    constructor(private readonly waitMs = 450) {}
    push(delta: string) {
        if (this.closed) return
        this.pending += this.filter.push(delta)
        this.flush(false)
        if (!this.timer && this.pending.trim())
            this.timer = setTimeout(() => {
                this.timer = undefined
                this.flush(true)
            }, this.waitMs)
    }
    private emit(length: number) {
        const phrase = this.pending.slice(0, length).trim()
        this.pending = this.pending.slice(length)
        if (!phrase) return
        this.first = false
        if (this.waiter) {
            const resolve = this.waiter
            this.waiter = null
            resolve(phrase)
        } else this.queue.push(phrase)
    }
    private flush(timed: boolean) {
        while (this.pending.trim()) {
            const min = this.first ? 4 : 12
            let cut = 0
            for (let i = 0; i < this.pending.length; i++) {
                const c = this.pending[i]!
                const next = this.pending[i + 1]
                const decimal = /\d/.test(this.pending[i - 1] ?? '') && /\d/.test(next ?? '')
                // Wait for one-character lookahead to disambiguate decimal points.
                const end =
                    /[。！？!?；;\n]/.test(c) || (c === '.' && next !== undefined && !decimal)
                const pause =
                    /[，,：:、～~]/.test(c) &&
                    !(
                        /\d/.test(this.pending[i - 1] ?? '') &&
                        (next === undefined || /\d/.test(next))
                    )
                if ((end || pause) && this.pending.slice(0, i + 1).trim().length >= min) {
                    cut = i + 1
                    break
                }
                if (i >= 79 && /[\p{Script=Han}\s]/u.test(c)) {
                    cut = i + 1
                    break
                }
            }
            if (!cut && timed) {
                // Keep an unfinished Latin word or number for the next chunk.
                for (let i = this.pending.length - 1; i >= 5; i--) {
                    if (/[\p{Script=Han}\s]/u.test(this.pending[i]!)) {
                        cut = i + 1
                        break
                    }
                }
            }
            if (!cut) break
            this.emit(cut)
        }
        if (!this.pending.trim()) {
            clearTimeout(this.timer)
            this.timer = undefined
        }
    }
    next(): Promise<string | null> {
        if (this.queue.length) return Promise.resolve(this.queue.shift()!)
        if (this.closed) return Promise.resolve(null)
        return new Promise(resolve => {
            this.waiter = resolve
        })
    }
    end() {
        if (this.closed) return
        clearTimeout(this.timer)
        this.timer = undefined
        this.emit(this.pending.length)
        this.closed = true
        if (this.waiter) {
            this.waiter(null)
            this.waiter = null
        }
    }
    cancel() {
        clearTimeout(this.timer)
        this.timer = undefined
        this.pending = ''
        this.queue = []
        this.closed = true
        if (this.waiter) {
            this.waiter(null)
            this.waiter = null
        }
    }
}
