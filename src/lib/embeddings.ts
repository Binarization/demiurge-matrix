/**
 * Embeddings client and similarity utilities.
 *
 * Uses an OpenAI-compatible embeddings endpoint. When not configured,
 * `embed()` returns null and the caller is expected to fall back to lexical.
 *
 * Single-flight cache: identical text within the cache window doesn't re-hit
 * the API. The store also caches the embedding on the memory record itself.
 */

import { loadEmbeddingsConfig, type StoredEmbeddingsConfig } from './embeddings-config'

type EmbedOptions = {
    config?: StoredEmbeddingsConfig
    signal?: AbortSignal
}

const inflight = new Map<string, Promise<number[] | null>>()
const memoryCache = new Map<string, number[]>()
const MAX_CACHE = 200

export function cosineSimilarity(a: number[], b: number[]): number {
    const len = Math.min(a.length, b.length)
    if (len === 0) return 0
    let dot = 0
    let normA = 0
    let normB = 0
    for (let i = 0; i < len; i++) {
        dot += a[i] * b[i]
        normA += a[i] * a[i]
        normB += b[i] * b[i]
    }
    if (normA === 0 || normB === 0) return 0
    return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

export function isEmbeddingsAvailable(config?: StoredEmbeddingsConfig): boolean {
    const c = config ?? loadEmbeddingsConfig()
    return Boolean(c.enabled && c.apiKey && c.baseUrl && c.model)
}

/**
 * Embed a single string. Returns null when embeddings are disabled or the
 * call fails — callers must tolerate null and fall back.
 */
export async function embed(text: string, options: EmbedOptions = {}): Promise<number[] | null> {
    const config = options.config ?? loadEmbeddingsConfig()
    if (!isEmbeddingsAvailable(config)) return null

    const trimmed = text.trim()
    if (!trimmed) return null

    const cacheKey = `${config.model}:${config.dimensions ?? 'full'}:${trimmed}`
    const cached = memoryCache.get(cacheKey)
    if (cached) return cached

    const existing = inflight.get(cacheKey)
    if (existing) return existing

    const p = (async () => {
        try {
            const url = `${config.baseUrl.replace(/\/$/, '')}/embeddings`
            const body: Record<string, unknown> = {
                model: config.model,
                input: trimmed,
            }
            if (config.dimensions) body.dimensions = config.dimensions

            const res = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${config.apiKey}`,
                },
                body: JSON.stringify(body),
                signal: options.signal,
            })
            if (!res.ok) {
                console.warn('[embeddings] non-OK response', res.status, await res.text().catch(() => ''))
                return null
            }
            const json = await res.json() as { data?: Array<{ embedding?: number[] }> }
            const vec = json.data?.[0]?.embedding
            if (!Array.isArray(vec)) return null

            if (memoryCache.size >= MAX_CACHE) {
                const firstKey = memoryCache.keys().next().value
                if (firstKey) memoryCache.delete(firstKey)
            }
            memoryCache.set(cacheKey, vec)
            return vec
        } catch (err) {
            console.warn('[embeddings] failed:', err)
            return null
        } finally {
            inflight.delete(cacheKey)
        }
    })()
    inflight.set(cacheKey, p)
    return p
}

/**
 * Batch embedding to amortize round-trips. Order is preserved.
 * Falls back to per-item embed() on providers that don't support batch.
 */
export async function embedBatch(texts: string[], options: EmbedOptions = {}): Promise<(number[] | null)[]> {
    const config = options.config ?? loadEmbeddingsConfig()
    if (!isEmbeddingsAvailable(config)) return texts.map(() => null)

    try {
        const url = `${config.baseUrl.replace(/\/$/, '')}/embeddings`
        const body: Record<string, unknown> = {
            model: config.model,
            input: texts,
        }
        if (config.dimensions) body.dimensions = config.dimensions

        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${config.apiKey}`,
            },
            body: JSON.stringify(body),
            signal: options.signal,
        })
        if (!res.ok) {
            console.warn('[embeddings] batch failed, falling back', res.status)
            return Promise.all(texts.map(t => embed(t, options)))
        }
        const json = await res.json() as { data?: Array<{ embedding?: number[]; index?: number }> }
        const data = json.data ?? []
        const out: (number[] | null)[] = new Array(texts.length).fill(null)
        for (const item of data) {
            const idx = item.index ?? data.indexOf(item)
            if (idx >= 0 && idx < out.length && Array.isArray(item.embedding)) {
                out[idx] = item.embedding
            }
        }
        return out
    } catch (err) {
        console.warn('[embeddings] batch error:', err)
        return Promise.all(texts.map(t => embed(t, options)))
    }
}

export function clearEmbeddingsCache() {
    inflight.clear()
    memoryCache.clear()
}
