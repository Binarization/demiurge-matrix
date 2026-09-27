import { afterEach, beforeEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { loadStoredOpenRouterConfig, saveStoredOpenRouterConfig, OPENROUTER_STORAGE_KEY } from '../src/lib/openrouter-config'

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
let storage: Map<string, string>
beforeEach(() => {
    storage = new Map()
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {
        localStorage: {
            getItem: (key: string) => storage.get(key) ?? null,
            setItem: (key: string, value: string) => storage.set(key, value),
            removeItem: (key: string) => storage.delete(key),
        },
    } })
})
afterEach(() => {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else Reflect.deleteProperty(globalThis, 'window')
})
test('first launch has no implicit credentials', () => {
    expect(loadStoredOpenRouterConfig()).toBeNull()
    expect(storage.size).toBe(0)
})
test('user-provided credentials and model survive loading', () => {
    const config = { apiKey: 'test-user-owned-key', model: 'test-model' }
    saveStoredOpenRouterConfig(config)
    expect(loadStoredOpenRouterConfig()).toEqual(config)
    expect(storage.has(OPENROUTER_STORAGE_KEY)).toBe(true)
})
test('frontend default contains no shared credential or base64 decoder', () => {
    const core = readFileSync(new URL('../src/components/Core.vue', import.meta.url), 'utf8')
    expect(core).toMatch(/const getDefaultConfig = \(\) => \(\{\s*apiKey: ''/)
    expect(core).not.toMatch(/atob\(|apiKey:\s*'c2st|sk-or-v1-/)
})
