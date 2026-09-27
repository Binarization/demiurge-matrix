import { access, readFile, writeFile, mkdir } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'

try {
    await access(new URL('../src/lib/voice/runtime/cyrene_voice_frontend.js', import.meta.url))
    await access(new URL('../src/lib/voice/runtime/cyrene_voice_frontend_bg.wasm', import.meta.url))
} catch {
    console.error(
        '缺少随仓库提供的语音前处理文件。请恢复 src/lib/voice/runtime，或安装 Rust/wasm-pack 后运行 npm run voice:build。'
    )
    process.exit(1)
}
// ORT's 25.9 MiB runtime exceeds Pages' per-file limit. Ship compressed bytes,
// then decompress in the voice Worker before supplying env.wasm.wasmBinary.
const runtime = await readFile(
    new URL(import.meta.resolve('onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm'))
)
// Use .bin: static servers may auto-decode .gz responses, causing double decompression.
const target = new URL('../src/lib/voice/generated/', import.meta.url)
await mkdir(target, { recursive: true })
await writeFile(new URL('ort-runtime.gzip.bin', target), gzipSync(runtime, { level: 9 }))
