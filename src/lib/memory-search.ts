/**
 * Hybrid retrieval: lexical (Flexsearch) + vector (cosine) + decay strength.
 * Optionally LLM-reranks the top candidates for semantic precision.
 */

import { memoryStore, effectiveStrength, type StoredMemory, type MemorySearchResult, type MemoryCategory } from './memory-store'
import { embed, cosineSimilarity, isEmbeddingsAvailable } from './embeddings'
import type { OpenRouterClient } from './openrouter'

export type HybridSearchOptions = {
    limit?: number
    /** Final blended score weights. Tuned for Chinese-heavy chat. */
    weights?: {
        lexical?: number // default 0.45
        vector?: number  // default 0.40
        strength?: number // default 0.15
    }
    /** Restrict to a category. */
    category?: MemoryCategory
    /** Pre-computed query embedding, if the caller already has one. */
    queryEmbedding?: number[] | null
}

export type RerankOptions = {
    client: OpenRouterClient
    model?: string
    limit?: number
    /** Optional context shown to the reranker for better judgment. */
    contextHint?: string
}

const VECTOR_FLOOR = 0.05 // similarity below this contributes nothing

function normalize(value: number, max: number): number {
    if (max <= 0) return 0
    return Math.max(0, Math.min(1, value / max))
}

/**
 * Hybrid search across all valid memories. Returns up to `limit` results
 * sorted by blended relevance score.
 */
export async function hybridSearch(query: string, options: HybridSearchOptions = {}): Promise<MemorySearchResult[]> {
    const limit = options.limit ?? 10
    const w = {
        lexical: options.weights?.lexical ?? 0.45,
        vector: options.weights?.vector ?? 0.40,
        strength: options.weights?.strength ?? 0.15,
    }
    const trimmed = query.trim()
    if (!trimmed) return []

    // 1. Lexical pool — overshoot to give the blend more candidates.
    const lexicalPool = await memoryStore.search(trimmed, Math.max(limit * 3, 20))
    const candidateMap = new Map<string, MemorySearchResult>()
    let maxLexical = 0
    for (const m of lexicalPool) {
        if (options.category && m.category !== options.category) continue
        const lex = m.lexicalScore ?? m.relevanceScore
        maxLexical = Math.max(maxLexical, lex)
        candidateMap.set(m.id, { ...m, lexicalScore: lex, vectorScore: 0 })
    }

    // 2. Vector pool — cosine across all live memories that have embeddings.
    let queryVec: number[] | null = options.queryEmbedding ?? null
    if (queryVec === undefined || queryVec === null) {
        if (isEmbeddingsAvailable()) {
            queryVec = await embed(trimmed)
        }
    }

    if (queryVec) {
        const all = await memoryStore.getAllValid()
        for (const mem of all) {
            if (options.category && mem.category !== options.category) continue
            if (!mem.embedding || mem.embedding.length === 0) continue
            const sim = cosineSimilarity(queryVec, mem.embedding)
            if (sim < VECTOR_FLOOR) continue
            const existing = candidateMap.get(mem.id)
            if (existing) {
                existing.vectorScore = sim
            } else {
                candidateMap.set(mem.id, {
                    ...mem,
                    relevanceScore: 0,
                    lexicalScore: 0,
                    vectorScore: sim,
                })
            }
        }
    }

    // 3. Blend. Normalize each component to [0, 1] before weighting.
    const now = Date.now()
    const blended: MemorySearchResult[] = []
    let maxStrength = 0
    for (const m of candidateMap.values()) {
        const s = effectiveStrength(m, now)
        if (s > maxStrength) maxStrength = s
    }

    for (const m of candidateMap.values()) {
        const lexN = normalize(m.lexicalScore ?? 0, maxLexical || 1)
        const vecN = m.vectorScore ?? 0 // cosine is already 0-1
        const str = effectiveStrength(m, now)
        const strN = normalize(str, maxStrength || 1)

        const score = w.lexical * lexN + w.vector * vecN + w.strength * strN
        blended.push({
            ...m,
            relevanceScore: score,
            strength: str,
        })
    }

    blended.sort((a, b) => b.relevanceScore - a.relevanceScore)
    return blended.slice(0, limit)
}

/**
 * Cosine-similar to a precomputed vector. Used by contradiction detection
 * to find candidates close enough to the new memory to be worth comparing.
 */
export async function findSimilarByEmbedding(
    embedding: number[],
    threshold: number = 0.78,
    limit: number = 5
): Promise<MemorySearchResult[]> {
    const all = await memoryStore.getAllValid()
    const results: MemorySearchResult[] = []
    for (const mem of all) {
        if (!mem.embedding || mem.embedding.length === 0) continue
        const sim = cosineSimilarity(embedding, mem.embedding)
        if (sim >= threshold) {
            results.push({ ...mem, relevanceScore: sim, vectorScore: sim })
        }
    }
    results.sort((a, b) => b.relevanceScore - a.relevanceScore)
    return results.slice(0, limit)
}

/**
 * LLM-reranks a candidate set. The model receives the query plus a numbered
 * list and returns the indices of the top picks in JSON. Cheap and tolerant
 * of model error: malformed output falls back to the original order.
 */
export async function rerankWithLLM(
    query: string,
    candidates: StoredMemory[],
    options: RerankOptions
): Promise<StoredMemory[]> {
    const limit = Math.min(options.limit ?? 5, candidates.length)
    if (candidates.length <= limit) return candidates

    const numbered = candidates.map((m, i) => `[${i}] (${m.category}/${m.subject}, 重要性=${m.importance}) ${m.content}`).join('\n')
    const contextLine = options.contextHint ? `\n对话背景：${options.contextHint}\n` : ''

    const system = `你是记忆相关性判官。从给定的候选记忆中，挑选出与"查询"最相关的 ${limit} 条。${contextLine}

只输出 JSON 格式：{"picks": [<索引>, ...]}。不要解释。`
    const user = `查询：${query}\n\n候选记忆：\n${numbered}\n\n请按相关度从高到低，输出最相关的 ${limit} 条索引。`

    try {
        const response = await options.client.sendChat(
            [
                { role: 'system', content: system },
                { role: 'user', content: user },
            ],
            { model: options.model }
        )
        const content = (response as any)?.choices?.[0]?.message?.content ?? ''
        const match = content.match(/\{[\s\S]*\}/)
        if (!match) return candidates.slice(0, limit)
        const parsed = JSON.parse(match[0])
        const picks: number[] = Array.isArray(parsed?.picks) ? parsed.picks : []
        const out: StoredMemory[] = []
        const seen = new Set<number>()
        for (const idx of picks) {
            if (typeof idx === 'number' && idx >= 0 && idx < candidates.length && !seen.has(idx)) {
                out.push(candidates[idx])
                seen.add(idx)
                if (out.length >= limit) break
            }
        }
        // Backfill from the top of the input order if the model returned fewer picks.
        if (out.length < limit) {
            for (let i = 0; i < candidates.length && out.length < limit; i++) {
                if (!seen.has(i)) out.push(candidates[i])
            }
        }
        return out
    } catch (err) {
        console.warn('[rerank] failed, returning top-N by hybrid score:', err)
        return candidates.slice(0, limit)
    }
}
