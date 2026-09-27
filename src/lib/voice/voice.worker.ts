import * as ort from 'onnxruntime-web/webgpu'
import ortWasm from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url'
import ortModule from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url'
import init, { Frontend } from './wasm/cyrene_voice_frontend'
import { expandBert, normalizePcm, readStyle, type Prepared } from './data'

ort.env.wasm.numThreads = 1
ort.env.wasm.proxy = false
ort.env.wasm.wasmPaths = { wasm: ortWasm, mjs: ortModule }
let bert: ort.InferenceSession | undefined, model: ort.InferenceSession | undefined
let frontend: Frontend, style: Float32Array
let initializing: Promise<void> | undefined
let backend = ''
const status = (text: string) => self.postMessage({ type: 'status', text })
async function load(base: string, mode: 'webgpu' | 'wasm') {
    const response = await fetch(new URL('manifest.json', base), { cache: 'no-cache' })
    if (!response.ok) throw new Error('未找到本地声音模型，请先运行 voice:prepare')
    const manifest = await response.json()
    if (manifest.version !== 1) throw new Error('声音资源版本不支持')
    const asset = async (key: string) => {
        const entry = manifest.files[key]
        if (!entry || !/^[\w.-]+$/.test(entry.url) || !/^[a-f0-9]{64}$/.test(entry.sha256))
            throw new Error('声音清单格式错误')
        const url = new URL(entry.url, base).href
        const cache = await caches.open('cyrene-voice-v1').catch(() => null)
        const saved = await cache?.match(url)
        if (saved) return saved.arrayBuffer()
        status(
            `正在加载${key === 'bert' ? '中文 BERT（571 MiB）' : key === 'model' ? '角色模型（188 MiB）' : key}…`
        )
        const r = await fetch(url)
        if (!r.ok) throw new Error(`模型资源加载失败：${key}`)
        const bytes = await r.arrayBuffer()
        const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b =>
            b.toString(16).padStart(2, '0')
        ).join('')
        if (digest !== entry.sha256) throw new Error(`模型校验失败：${key}`)
        await cache?.put(url, new Response(bytes)).catch(() => status('缓存空间不足，本次仍可使用'))
        return bytes
    }
    const config = JSON.parse(new TextDecoder().decode(await asset('config')))
    if (
        config.data.sampling_rate !== 44100 ||
        !config.data.add_blank ||
        config.data.use_jp_extra ||
        config.data.n_speakers !== 1
    )
        throw new Error('声音配置不兼容')
    await init()
    frontend = new Frontend(new TextDecoder().decode(await asset('tokenizer')))
    style = readStyle(await asset('style'))
    if (mode === 'webgpu') {
        const gpu = (
            self.navigator as Navigator & {
                gpu?: { requestAdapter: () => Promise<{ features: Set<string> } | null> }
            }
        ).gpu
        const adapter = await gpu?.requestAdapter()
        if (!adapter)
            throw new Error('此设备没有可用 WebGPU，请尝试 WASM；若仍无法加载则不能开启朗读')
        if (!adapter.features.has('shader-f16'))
            throw new Error('此设备不支持模型所需的 shader-f16')
    }
    const options: ort.InferenceSession.SessionOptions = {
        executionProviders: mode === 'webgpu' ? ['webgpu', 'wasm'] : ['wasm'],
        graphOptimizationLevel: 'all',
    }
    status('正在初始化中文 BERT…')
    bert = await ort.InferenceSession.create(await asset('bert'), options)
    if (mode === 'webgpu' && !ort.env.webgpu.device)
        throw new Error('WebGPU 后端未启动，请选择 WASM 重试')
    status('正在初始化角色声音…')
    model = await ort.InferenceSession.create(await asset('model'), options)
    backend = mode
    status('正在预热角色声音…')
    await synthesize('你好，伙伴。')
    status(`角色声音已就绪（${mode === 'webgpu' ? 'WebGPU / WASM' : 'WASM'}）`)
}
const int = (values: number[], dims: number[]) =>
    new ort.Tensor('int64', BigInt64Array.from(values, BigInt), dims)
const scalar = (value: number) => new ort.Tensor('float32', new Float32Array([value]), [])
async function synthesize(text: string) {
    const start = performance.now()
    const p: Prepared = JSON.parse(frontend.prepare(text)),
        n = p.phones.length,
        tokens = p.input_ids.length
    if (tokens > 512) throw new Error('文本超过 BERT 长度限制')
    const bf = {
        input_ids: int(p.input_ids, [1, tokens]),
        attention_mask: int(p.attention_mask, [1, tokens]),
        token_type_ids: int(p.token_type_ids, [1, tokens]),
    }
    let outputs: ort.InferenceSession.ReturnType | undefined
    let features: Float32Array
    try {
        outputs = await bert!.run(bf)
        features = expandBert(outputs[bert!.outputNames[0]!]!.data as Float32Array, p.word2ph, n)
    } finally {
        Object.values(bf).forEach(t => t.dispose())
        if (outputs) Object.values(outputs).forEach(t => t.dispose())
    }
    const bertMs = performance.now() - start
    const feeds = {
        x_tst: int(p.phones, [1, n]),
        x_tst_lengths: int([n], [1]),
        sid: int([0], [1]),
        tones: int(p.tones, [1, n]),
        language: int(p.languages, [1, n]),
        bert: new ort.Tensor('float32', features!, [1, 1024, n]),
        ja_bert: new ort.Tensor('float32', new Float32Array(1024 * n), [1, 1024, n]),
        en_bert: new ort.Tensor('float32', new Float32Array(1024 * n), [1, 1024, n]),
        style_vec: new ort.Tensor('float32', style, [1, 256]),
        length_scale: scalar(1),
        sdp_ratio: scalar(0.2),
        noise_scale: scalar(0.6),
        noise_scale_w: scalar(0.8),
    }
    let result: ort.InferenceSession.ReturnType | undefined
    try {
        result = await model!.run(feeds, ['output'])
        const pcm = normalizePcm(new Float32Array(result.output!.data as Float32Array))
        return {
            pcm,
            metrics: {
                backend,
                bertMs,
                totalMs: performance.now() - start,
                audioSeconds: pcm.length / 44100,
                normalized: p.normalized,
            },
        }
    } finally {
        Object.values(feeds).forEach(t => t.dispose())
        if (result) Object.values(result).forEach(t => t.dispose())
    }
}
// A single queue bounds transient tensors even if callers send multiple requests.
let queue = Promise.resolve()
self.onmessage = event => {
    const request = event.data
    queue = queue.then(async () => {
        try {
            if (request.type === 'init') {
                initializing ??= load(request.base, request.mode)
                await initializing
                self.postMessage({ type: 'ready', id: request.id })
            } else if (request.type === 'synthesize') {
                if (!initializing) throw new Error('声音尚未初始化')
                await initializing
                const result = await synthesize(request.text)
                self.postMessage(
                    { type: 'audio', id: request.id, ...result },
                    { transfer: [result.pcm.buffer] }
                )
            }
        } catch (error) {
            self.postMessage({ type: 'error', id: request.id, error: String(error) })
        }
    })
}
