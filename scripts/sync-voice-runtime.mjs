// Keep the portable frontend in Git so static hosts do not need a Rust toolchain.
import { copyFile, mkdir } from 'node:fs/promises'
const target = new URL('../src/lib/voice/runtime/', import.meta.url)
await mkdir(target, { recursive: true })
for (const file of [
    'cyrene_voice_frontend.js',
    'cyrene_voice_frontend.d.ts',
    'cyrene_voice_frontend_bg.wasm',
    'cyrene_voice_frontend_bg.wasm.d.ts',
    'LICENSE',
]) {
    await copyFile(new URL('../src/lib/voice/wasm/' + file, import.meta.url), new URL(file, target))
}
