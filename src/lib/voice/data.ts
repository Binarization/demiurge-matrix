export interface Prepared {
    normalized: string
    phones: number[]
    tones: number[]
    languages: number[]
    input_ids: number[]
    attention_mask: number[]
    token_type_ids: number[]
    word2ph: number[]
}
export function expandBert(hidden: Float32Array, counts: number[], frames: number): Float32Array {
    if (
        hidden.length !== counts.length * 1024 ||
        counts.some(n => !Number.isInteger(n) || n < 0) ||
        counts.reduce((a, b) => a + b, 0) !== frames
    )
        throw new Error('BERT 音素对齐失败')
    const out = new Float32Array(1024 * frames)
    for (let c = 0; c < 1024; c++) {
        let offset = c * frames
        counts.forEach((n, token) => {
            out.fill(hidden[token * 1024 + c]!, offset, offset + n)
            offset += n
        })
    }
    return out
}
export function readStyle(buffer: ArrayBuffer): Float32Array {
    const bytes = new Uint8Array(buffer),
        view = new DataView(buffer)
    if (bytes[0] !== 147 || new TextDecoder().decode(bytes.subarray(1, 6)) !== 'NUMPY')
        throw new Error('风格文件不是 NPY')
    const version = bytes[6],
        start = version === 1 ? 10 : 12
    if (version !== 1 && version !== 2) throw new Error('不支持此 NPY 版本')
    const length = version === 1 ? view.getUint16(8, true) : view.getUint32(8, true)
    const header = new TextDecoder().decode(bytes.subarray(start, start + length))
    if (
        !/'descr':\s*'<f4'/.test(header) ||
        !/'fortran_order':\s*False/.test(header) ||
        !/'shape':\s*\(1,\s*256\)/.test(header)
    )
        throw new Error('需要 Neutral [1,256] FLOAT32 风格向量')
    if (buffer.byteLength !== start + length + 1024) throw new Error('风格文件大小错误')
    const result = new Float32Array(256)
    for (let i = 0; i < 256; i++) result[i] = view.getFloat32(start + length + i * 4, true)
    if (result.some(v => !Number.isFinite(v))) throw new Error('风格向量包含非法数值')
    return result
}
export function normalizePcm(pcm: Float32Array): Float32Array {
    if (!pcm.length || pcm.length > 44100 * 120) throw new Error('合成音频长度异常')
    let peak = 0
    for (const x of pcm) {
        if (!Number.isFinite(x)) throw new Error('模型输出包含非法数值')
        peak = Math.max(peak, Math.abs(x))
    }
    if (peak > 0) {
        const scale = 0.97 / peak
        for (let i = 0; i < pcm.length; i++) pcm[i] = pcm[i]! * scale
    }
    return pcm
}
