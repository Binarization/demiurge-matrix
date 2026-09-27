import { expect, test } from 'bun:test'
import worker from '../deploy/voice/worker'
import assets from '../deploy/voice/assets.json'

// Bun lacks the Workers-native stream; exercise ordering/error propagation with
// its standard identity stream. Production additionally enforces byte length.
Object.assign(globalThis, {
    FixedLengthStream: class extends TransformStream {
        constructor(_length: number) {
            super()
        }
    },
})
const ctx = { waitUntil: (_promise: Promise<unknown>) => {} } as ExecutionContext

test('download proxy only exposes manifest and exact released model names', async () => {
    let reads = 0
    const env = {
        VOICE: {
            get: async () => {
                reads++
                throw new Error('must not read')
            },
        },
    } as Env
    for (const path of [
        '/voice/',
        '/voice/future-model.onnx',
        '/part-private.bin',
        '/voice/../secret',
    ]) {
        expect(
            (await worker.fetch(new Request('https://voice.test' + path), env, ctx)).status
        ).toBe(404)
    }
    expect(
        (
            await worker.fetch(
                new Request('https://voice.test/voice/manifest.json', { method: 'POST' }),
                env,
                ctx
            )
        ).status
    ).toBe(405)
    const manifest = await worker.fetch(
        new Request('https://voice.test/voice/manifest.json'),
        env,
        ctx
    )
    expect(manifest.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect((await manifest.json()).version).toBe(1)
    expect(reads).toBe(0)
})
test('download streams approved private parts in order and HEAD does not read storage', async () => {
    const asset = assets[0]!
    const reads: string[] = []
    const env = {
        VOICE: {
            get: async (key: string) => {
                reads.push(key)
                const part = asset.parts.find(part => part.key === key)!
                return { size: part.size, body: new Response('part-' + reads.length).body! }
            },
        },
    } as Env
    const url = 'https://voice.test/voice/' + asset.path
    const head = await worker.fetch(new Request(url, { method: 'HEAD' }), env, ctx)
    expect(head.headers.get('Content-Length')).toBe(String(asset.size))
    expect(reads).toEqual([])
    const response = await worker.fetch(new Request(url), env, ctx)
    expect(await response.text()).toBe(asset.parts.map((_, i) => 'part-' + (i + 1)).join(''))
    expect(reads).toEqual(asset.parts.map(part => part.key))
})
test('missing private part fails download instead of returning corrupt success bytes', async () => {
    const env = {
        VOICE: {
            get: async () => {
                await new Promise(resolve => setTimeout(resolve, 0))
                return null
            },
        },
    } as Env
    const response = await worker.fetch(
        new Request('https://voice.test/voice/' + assets[0]!.path),
        env,
        ctx
    )
    await expect(response.arrayBuffer()).rejects.toThrow('Voice part unavailable')
})
