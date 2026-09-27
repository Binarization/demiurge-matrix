import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import Icons from 'unplugin-icons/vite'
import wasm from 'vite-plugin-wasm'

export default defineConfig({
    plugins: [
        wasm(),
        {
            name: 'omit-overridden-ort-wasm',
            apply: 'build',
            generateBundle(_options, bundle) {
                // ORT's fallback URL causes Vite to emit this even though the voice
                // Worker supplies wasmBinary from our compressed runtime instead.
                for (const [name, entry] of Object.entries(bundle)) {
                    if (
                        entry.type === 'asset' &&
                        /^assets\/ort-wasm-simd-threaded\.asyncify-[\w-]+\.wasm$/.test(name)
                    ) {
                        delete bundle[name]
                    }
                }
            },
        },
        vue(),
        tailwindcss(),
        Icons({
            compiler: 'vue3',
            autoInstall: false,
        }),
    ],
    resolve: {
        alias: {
            '@': fileURLToPath(new URL('./src', import.meta.url)),
        },
    },
    build: {
        target: 'esnext',
    },
    worker: {
        format: 'es',
        plugins: () => [wasm()],
    },
})
