import { access } from 'node:fs/promises'
try {
    await access(new URL('../src/lib/voice/wasm/cyrene_voice_frontend.js', import.meta.url))
    await access(new URL('../src/lib/voice/wasm/cyrene_voice_frontend_bg.wasm', import.meta.url))
} catch {
    console.error('缺少语音前处理 WASM。请先安装 Rust wasm32-unknown-unknown 与 wasm-pack，然后运行 npm run voice:build。')
    process.exit(1)
}
