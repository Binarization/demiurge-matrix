import assets from './assets.json'
import manifest from './manifest.json'

const files = new Map(assets.map(asset => [asset.path, asset]))
const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Expose-Headers': 'Content-Length, ETag',
    'X-Content-Type-Options': 'nosniff',
}
export default {
    async fetch(request, env, ctx) {
        const path = new URL(request.url).pathname
        const name = path.startsWith('/voice/') ? path.slice('/voice/'.length) : ''
        const asset = files.get(name)
        // Exact allowlist only: never expose bucket listing, arbitrary keys, or writes.
        if (name !== 'manifest.json' && !asset)
            return new Response('Not found', { status: 404, headers: cors })
        if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method))
            return new Response('Method not allowed', {
                status: 405,
                headers: { ...cors, Allow: 'GET, HEAD, OPTIONS' },
            })
        if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
        if (name === 'manifest.json') {
            return new Response(request.method === 'HEAD' ? null : JSON.stringify(manifest), {
                headers: {
                    ...cors,
                    'Content-Type': 'application/json',
                    'Cache-Control': 'public, max-age=300',
                },
            })
        }
        if (!asset) return new Response('Not found', { status: 404, headers: cors })
        const headers = {
            ...cors,
            'Content-Type': name.endsWith('.json')
                ? 'application/json'
                : 'application/octet-stream',
            'Content-Length': String(asset.size),
            'Cache-Control': 'public, max-age=31536000, immutable',
        }
        if (request.method === 'HEAD') return new Response(null, { headers })
        // Native pipeTo avoids running JavaScript for every network chunk of a
        // 571 MiB model. FixedLengthStream also makes truncation a transport error.
        const { readable, writable } = new FixedLengthStream(asset.size)
        const transfer = async () => {
            try {
                for (const part of asset.parts) {
                    const object = await env.VOICE.get(part.key)
                    if (!object || object.size !== part.size)
                        throw new Error('Voice part unavailable')
                    await object.body.pipeTo(writable, { preventClose: true })
                }
                await writable.getWriter().close()
            } catch (error) {
                console.error('Voice download failed', asset.path, String(error))
                await writable.abort(error).catch(() => {})
            }
        }
        ctx.waitUntil(transfer())
        return new Response(readable, { headers })
    },
} satisfies ExportedHandler<Env>
