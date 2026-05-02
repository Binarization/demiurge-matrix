/**
 * Memory Tools for Agent
 *
 * v3 changes:
 *   - recall_memory uses hybrid (lexical + vector + decay) search
 *   - store_memory does semantic dup detection + soft-supersedes contradictions
 *   - new fields: subject, confidence, expires_in_days, source
 *   - cleanup driven by continuous decay (effectiveStrength) instead of brittle rules
 */

import type { Tool, ToolResult } from './agent'
import {
    memoryStore,
    effectiveStrength,
    type MemoryCategory,
    type MemorySource,
    type MemorySubject,
    type StoredMemory,
} from './memory-store'
import { embed, isEmbeddingsAvailable } from './embeddings'
import { hybridSearch, findSimilarByEmbedding } from './memory-search'

const VALID_CATEGORIES: MemoryCategory[] = ['fact', 'preference', 'event', 'correction', 'context']
const VALID_SUBJECTS: MemorySubject[] = ['user', 'character', 'world', 'relationship', 'other']

type StoreMemoryArgs = {
    content: string
    category: MemoryCategory
    importance?: number
    confidence?: number
    subject?: MemorySubject
    expires_in_days?: number
    reason?: string
    // Internal fields for non-LLM callers (reflection, episodic summary).
    // Not exposed via the tool schema in agent.ts.
    source?: MemorySource
    metadata?: Record<string, unknown>
}

type RecallMemoryArgs = {
    query: string
    limit?: number
    category?: MemoryCategory
    subject?: MemorySubject
}

type ForgetMemoryArgs = {
    memoryId: string
    reason?: string
}

type UpdateMemoryArgs = {
    memoryId: string
    content?: string
    importance?: number
    confidence?: number
    reason?: string
}

type ListMemoriesArgs = {
    category?: MemoryCategory
    subject?: MemorySubject
    sortBy?: 'recent' | 'important' | 'strongest'
    limit?: number
}

/**
 * Detect whether `newContent` likely contradicts `existing`. Heuristic only —
 * caught by overlapping keywords plus a polarity flip ("不/没" diff). Cheap,
 * good-enough for the common case "我喜欢X" → "我不喜欢X".
 */
function looksContradictory(newContent: string, existing: string): boolean {
    const negationTokens = ['不', '没', '别', '不再', '已经不', '已不', '不是', "don't", 'not', 'no longer']
    const newHasNeg = negationTokens.some(t => newContent.includes(t))
    const oldHasNeg = negationTokens.some(t => existing.includes(t))
    if (newHasNeg === oldHasNeg) return false
    // Both should share substantial content otherwise this isn't a contradiction
    const stripped = (s: string) => s.replace(/[^一-龥a-zA-Z0-9]/g, '').toLowerCase()
    const a = stripped(newContent)
    const b = stripped(existing)
    if (a.length < 4 || b.length < 4) return false
    // overlap ratio
    let shared = 0
    for (let i = 0; i < a.length - 1; i++) {
        if (b.includes(a.slice(i, i + 2))) shared += 1
    }
    return shared / (a.length - 1) > 0.45
}

// Serialize concurrent store_memory writes so dedup-then-insert is race-safe.
// Without this, parallel writers (Promise.all in agent.executeToolCalls,
// fire-and-forget reflection on every turn, episodic summaries) all run dedup
// before any commits and all insert. See screenshot 2026-05-02.
let storeMemoryQueue: Promise<unknown> = Promise.resolve()

/**
 * Enqueue a memory write through the shared dedup pipeline. All paths that
 * persist memory — the LLM tool, reflection, episodic summary — must go
 * through here so dedup is consistent and race-free.
 */
export function enqueueStoreMemory(args: StoreMemoryArgs): Promise<ToolResult> {
    const next = storeMemoryQueue
        .catch(() => {})
        .then(() => performStoreWithDedup(args))
    storeMemoryQueue = next.catch(() => {})
    return next
}

const performStoreWithDedup = async (a: StoreMemoryArgs): Promise<ToolResult> => {
    const content = a.content
    const category = a.category
    const importance = a.importance ?? 5
    const confidence = a.confidence ?? importance
    const subject = a.subject

    if (!content || !category) {
        return {
            name: 'store_memory',
            output: { success: false, error: 'Missing required parameters: content and category' },
            message: '记忆存储失败：缺少必要参数。',
        }
    }
    if (!VALID_CATEGORIES.includes(category)) {
        return {
            name: 'store_memory',
            output: { success: false, error: `Invalid category. Must be one of: ${VALID_CATEGORIES.join(', ')}` },
            message: '记忆存储失败：无效的分类。',
        }
    }
    if (subject && !VALID_SUBJECTS.includes(subject)) {
        return {
            name: 'store_memory',
            output: { success: false, error: `Invalid subject. Must be one of: ${VALID_SUBJECTS.join(', ')}` },
            message: '记忆存储失败：无效的主体。',
        }
    }

    try {
        const trimmed = content.trim()

        // 0. Exact-content fast path. Runs regardless of embedding availability,
        // catches the case where vector dedup misses a legacy memory without
        // an embedding (or where lexical tokenization happens to miss).
        const allValid = await memoryStore.getAllValid()
        const exact = allValid.find(m => m.content.trim() === trimmed)
        if (exact) {
            const updates: Partial<Pick<StoredMemory, 'importance' | 'confidence'>> = {}
            if (importance > exact.importance) updates.importance = importance
            if (confidence > exact.confidence) updates.confidence = confidence
            if (Object.keys(updates).length > 0) {
                await memoryStore.update(exact.id, updates)
            }
            await memoryStore.recordAccess(exact.id)
            return {
                name: 'store_memory',
                output: { success: true, memoryId: exact.id, duplicate: true },
                message: `已有相同记忆，已加强：${exact.content.slice(0, 30)}...`,
            }
        }

        // Embed up front so dup-detection and storage share the vector
        const embedding = isEmbeddingsAvailable() ? await embed(content) : null

        // 1. Semantic dup detection (preferred path) + lexical fallback.
        // Run lexical regardless so we also catch dupes whose existing record
        // pre-dates embeddings being enabled.
        const candidateMap = new Map<string, StoredMemory>()
        if (embedding) {
            const semantic = await findSimilarByEmbedding(embedding, 0.82, 5)
            for (const m of semantic) candidateMap.set(m.id, m)
        }
        const lexical = (await memoryStore.search(content, 5)) as StoredMemory[]
        for (const m of lexical) {
            if (!candidateMap.has(m.id)) candidateMap.set(m.id, m)
        }

        for (const existing of candidateMap.values()) {
            if (looksContradictory(content, existing.content)) {
                // Soft-supersede: write new memory, mark old as superseded
                const expiresAt = a.expires_in_days
                    ? Date.now() + a.expires_in_days * 24 * 60 * 60 * 1000
                    : undefined
                const stored = await memoryStore.store(content, category, importance, {
                    subject,
                    confidence,
                    source: a.source,
                    embedding: embedding ?? undefined,
                    expiresAt,
                    metadata: { ...a.metadata, reason: a.reason, supersedes: existing.id },
                })
                await memoryStore.supersede(existing.id, stored.id)
                return {
                    name: 'store_memory',
                    output: { success: true, memoryId: stored.id, supersededId: existing.id },
                    message: `已更新（取代旧记忆）：${content.slice(0, 40)}`,
                }
            }

            // Near-duplicate (no contradiction) — bump importance/confidence and skip.
            // Always check lexical overlap too, even when vector matched, so vector
            // false-positives across unrelated content don't collapse into a near-dup.
            const lexicalOverlap = sharedNgramRatio(content, existing.content)
            const hasEmbedding = !!existing.embedding && existing.embedding.length > 0
            const isNearDup = embedding && hasEmbedding
                ? true // already passed cosine ≥ 0.82
                : lexicalOverlap > 0.65

            if (isNearDup) {
                const updates: Partial<Pick<StoredMemory, 'importance' | 'confidence'>> = {}
                if (importance > existing.importance) updates.importance = importance
                if (confidence > existing.confidence) updates.confidence = confidence
                if (Object.keys(updates).length > 0) {
                    await memoryStore.update(existing.id, updates)
                }
                await memoryStore.recordAccess(existing.id)
                return {
                    name: 'store_memory',
                    output: { success: true, memoryId: existing.id, duplicate: true },
                    message: `已有相似记忆，已加强：${existing.content.slice(0, 30)}...`,
                }
            }
        }

        // 2. Plain new memory
        const expiresAt = a.expires_in_days
            ? Date.now() + a.expires_in_days * 24 * 60 * 60 * 1000
            : undefined
        const memory = await memoryStore.store(content, category, importance, {
            subject,
            confidence,
            source: a.source,
            embedding: embedding ?? undefined,
            expiresAt,
            metadata: { ...a.metadata, reason: a.reason },
        })

        return {
            name: 'store_memory',
            output: {
                success: true,
                memoryId: memory.id,
                category: memory.category,
                subject: memory.subject,
                importance: memory.importance,
                confidence: memory.confidence,
            },
            message: `已记住：${content.slice(0, 50)}${content.length > 50 ? '...' : ''}`,
        }
    } catch (error) {
        return {
            name: 'store_memory',
            output: { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
            message: '记忆存储失败。',
        }
    }
}

export const storeMemoryTool: Tool = {
    name: 'store_memory',
    description: `存储重要信息到长期记忆。

何时使用：
- 学到关于伙伴的新事实（姓名、偏好、经历）
- 重要事件或决定
- 伙伴明确要求记住的事
- 纠正之前的误解

参数：
- content: 要记住的信息（具体清晰，≤ 60字）
- category: 'fact' | 'preference' | 'event' | 'correction' | 'context'
- subject: 'user' | 'character' | 'world' | 'relationship' | 'other' (可选，默认推断)
- importance: 1-10 (10 = 关键)
- confidence: 1-10 (确定程度，默认 = importance)
- expires_in_days: 可选数字，临时承诺/计划用（"下周去北京"用 7）
- reason: 为什么值得记住`,

    execute: async (args: unknown): Promise<ToolResult> => {
        return enqueueStoreMemory(args as StoreMemoryArgs)
    },
}

function sharedNgramRatio(a: string, b: string): number {
    const norm = (s: string) => s.replace(/[^一-龥a-zA-Z0-9]/g, '').toLowerCase()
    const A = norm(a)
    const B = norm(b)
    if (A.length < 2 || B.length < 2) return 0
    let shared = 0
    for (let i = 0; i < A.length - 1; i++) {
        if (B.includes(A.slice(i, i + 2))) shared += 1
    }
    return shared / (A.length - 1)
}

export const recallMemoryTool: Tool = {
    name: 'recall_memory',
    description: `搜索长期记忆。结合关键词、语义和时效性。

何时使用：
- 伙伴提及之前讨论过的内容
- 需要回忆偏好、经历
- 查找相关背景信息

参数：
- query: 搜索文本（关键词或自然语言）
- limit: 最多返回数量（默认 5）
- category / subject: 可选过滤`,

    execute: async (args: unknown): Promise<ToolResult> => {
        const { query, limit = 5, category, subject } = args as RecallMemoryArgs
        if (!query) {
            return {
                name: 'recall_memory',
                output: { success: false, error: 'Missing required parameter: query' },
                message: '记忆检索失败：缺少搜索关键词。',
            }
        }

        try {
            const results = await hybridSearch(query, { limit, category })
            const filtered = subject ? results.filter(r => r.subject === subject) : results

            await Promise.all(filtered.map(m => memoryStore.recordAccess(m.id)))

            if (filtered.length === 0) {
                return {
                    name: 'recall_memory',
                    output: { success: true, memories: [], count: 0 },
                    message: '没有找到相关记忆。',
                }
            }

            const formatted = filtered.map(m => ({
                id: m.id,
                content: m.content,
                category: m.category,
                subject: m.subject,
                importance: m.importance,
                confidence: m.confidence,
                date: m.date,
            }))

            return {
                name: 'recall_memory',
                output: { success: true, memories: formatted, count: filtered.length },
                message: `找到 ${filtered.length} 条相关记忆。`,
            }
        } catch (error) {
            return {
                name: 'recall_memory',
                output: { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
                message: '记忆检索失败。',
            }
        }
    },
}

export const forgetMemoryTool: Tool = {
    name: 'forget_memory',
    description: `标记一条记忆为遗忘（软删除，保留审计痕迹）。

何时使用：
- 之前的事实被证实是错的
- 伙伴更正信息
- 信息过时
- 伙伴明确要求忘记`,

    execute: async (args: unknown): Promise<ToolResult> => {
        const { memoryId, reason } = args as ForgetMemoryArgs
        if (!memoryId) {
            return {
                name: 'forget_memory',
                output: { success: false, error: 'Missing required parameter: memoryId' },
                message: '遗忘操作失败：缺少记忆ID。',
            }
        }
        try {
            const memory = await memoryStore.getById(memoryId)
            if (!memory) {
                return {
                    name: 'forget_memory',
                    output: { success: false, error: 'Memory not found' },
                    message: '找不到该记忆。',
                }
            }
            // Soft delete — invalidate so it stays out of retrieval
            await memoryStore.update(memoryId, { isValid: 0 })
            if (reason) {
                await enqueueStoreMemory({
                    content: `[已遗忘] ${memory.content} - 原因: ${reason}`,
                    category: 'correction',
                    importance: 3,
                    source: 'agent_reflection',
                    metadata: { originalMemoryId: memoryId },
                })
            }
            return {
                name: 'forget_memory',
                output: { success: true, memoryId, forgotten: memory.content.slice(0, 50) },
                message: '已遗忘该记忆。',
            }
        } catch (error) {
            return {
                name: 'forget_memory',
                output: { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
                message: '遗忘操作失败。',
            }
        }
    },
}

export const updateMemoryTool: Tool = {
    name: 'update_memory',
    description: `更新已有记忆。

参数：
- memoryId: 记忆 ID
- content: 新内容（可选）
- importance: 新重要性 1-10
- confidence: 新可信度 1-10
- reason: 更新原因`,

    execute: async (args: unknown): Promise<ToolResult> => {
        const a = args as UpdateMemoryArgs
        const memoryId = a.memoryId
        if (!memoryId) {
            return {
                name: 'update_memory',
                output: { success: false, error: 'Missing required parameter: memoryId' },
                message: '更新操作失败：缺少记忆ID。',
            }
        }
        if (!a.content && a.importance === undefined && a.confidence === undefined) {
            return {
                name: 'update_memory',
                output: { success: false, error: 'Must provide content, importance, or confidence to update' },
                message: '更新操作失败：没有提供更新内容。',
            }
        }
        try {
            const updates: Partial<Pick<StoredMemory, 'content' | 'importance' | 'confidence' | 'embedding'>> = {}
            if (a.content) {
                updates.content = a.content
                // Re-embed on content change
                if (isEmbeddingsAvailable()) {
                    const newVec = await embed(a.content)
                    if (newVec) updates.embedding = newVec
                }
            }
            if (a.importance !== undefined) updates.importance = a.importance
            if (a.confidence !== undefined) updates.confidence = a.confidence

            const updated = await memoryStore.update(memoryId, updates)
            if (!updated) {
                return {
                    name: 'update_memory',
                    output: { success: false, error: 'Memory not found' },
                    message: '找不到该记忆。',
                }
            }
            return {
                name: 'update_memory',
                output: {
                    success: true,
                    memoryId,
                    content: updated.content.slice(0, 50),
                    importance: updated.importance,
                    confidence: updated.confidence,
                },
                message: '记忆已更新。',
            }
        } catch (error) {
            return {
                name: 'update_memory',
                output: { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
                message: '更新操作失败。',
            }
        }
    },
}

export const listMemoriesTool: Tool = {
    name: 'list_memories',
    description: `列出已有记忆。可按 category/subject 过滤，按 recent/important/strongest 排序。`,

    execute: async (args: unknown): Promise<ToolResult> => {
        const { category, subject, sortBy = 'strongest', limit = 10 } = args as ListMemoriesArgs
        try {
            let memories: StoredMemory[]
            if (category) {
                memories = await memoryStore.getByCategory(category, limit)
            } else if (subject) {
                memories = await memoryStore.getBySubject(subject, limit)
            } else if (sortBy === 'important') {
                memories = await memoryStore.getMostImportant(limit)
            } else if (sortBy === 'recent') {
                memories = await memoryStore.getRecent(limit)
            } else {
                memories = await memoryStore.getStrongest(limit)
            }
            const totalCount = await memoryStore.getCount()
            const formatted = memories.map(m => ({
                id: m.id,
                content: m.content.slice(0, 100) + (m.content.length > 100 ? '...' : ''),
                category: m.category,
                subject: m.subject,
                importance: m.importance,
                confidence: m.confidence,
                strength: Math.round(effectiveStrength(m) * 10) / 10,
                date: m.date,
            }))
            return {
                name: 'list_memories',
                output: { success: true, memories: formatted, count: memories.length, totalCount },
                message: `共有 ${totalCount} 条记忆，显示 ${memories.length} 条。`,
            }
        } catch (error) {
            return {
                name: 'list_memories',
                output: { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
                message: '列出记忆失败。',
            }
        }
    },
}

type CleanupMemoriesArgs = {
    threshold?: number
    dryRun?: boolean
}

export const cleanupMemoriesTool: Tool = {
    name: 'cleanup_memories',
    description: `清理低强度（衰减后）的记忆。强度 = importance × decay + 访问加成。

参数：
- threshold: 强度阈值（默认 0.5），低于则清理
- dryRun: 仅预览不实际清理`,

    execute: async (args: unknown): Promise<ToolResult> => {
        const { threshold = 0.5, dryRun = false } = (args ?? {}) as CleanupMemoriesArgs
        try {
            const removed = await memoryStore.pruneDecayed(threshold, dryRun)
            const summary = removed.map(r => `- ${r.content.slice(0, 30)}... (强度=${r.strength.toFixed(2)})`).join('\n')
            return {
                name: 'cleanup_memories',
                output: { success: true, removed: removed.length, dryRun, details: removed },
                message: dryRun
                    ? `发现 ${removed.length} 条可清理记忆:\n${summary}`
                    : `已清理 ${removed.length} 条记忆:\n${summary}`,
            }
        } catch (error) {
            return {
                name: 'cleanup_memories',
                output: { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
                message: '清理记忆失败。',
            }
        }
    },
}

export const memoryTools: Tool[] = [
    storeMemoryTool,
    recallMemoryTool,
    forgetMemoryTool,
    updateMemoryTool,
    listMemoriesTool,
    cleanupMemoriesTool,
]

/**
 * Render a list of memories for system-prompt injection.
 */
export function formatMemoriesForPrompt(memories: StoredMemory[]): string {
    if (memories.length === 0) return ''
    const categoryLabels: Record<MemoryCategory, string> = {
        fact: '事实',
        preference: '偏好',
        event: '事件',
        correction: '纠正',
        context: '背景',
    }
    const subjectLabels: Record<MemorySubject, string> = {
        user: '伙伴',
        character: '昔涟',
        world: '世界',
        relationship: '关系',
        other: '其他',
    }
    const lines = memories.map(m => {
        const cat = categoryLabels[m.category]
        const subj = subjectLabels[m.subject]
        return `- [${cat}·${subj}] (${m.date}) ${m.content}`
    })
    return `\n【长期记忆】\n${lines.join('\n')}\n`
}

/**
 * Hybrid retrieval entrypoint for Agent.run(). Builds the query from the
 * conversation context (not just the latest user message), runs hybrid
 * search, optionally LLM-reranks.
 */
export async function getRelevantMemories(
    contextOrQuery: string,
    limit: number = 5
): Promise<StoredMemory[]> {
    const seen = new Set<string>()
    const results: StoredMemory[] = []

    const hybrid = await hybridSearch(contextOrQuery, { limit: limit * 2 })
    for (const m of hybrid) {
        if (!seen.has(m.id)) {
            seen.add(m.id)
            results.push(m)
        }
    }

    // Always pin top-strength memories so the agent has user-name-level facts available
    const strongest = await memoryStore.getStrongest(3)
    for (const m of strongest) {
        if (!seen.has(m.id)) {
            seen.add(m.id)
            results.push(m)
        }
    }

    return results.slice(0, limit)
}

/**
 * Memories suitable for an opening greeting: high-importance facts and
 * preferences about the user, plus recent significant relationship events.
 */
export async function getGreetingMemories(): Promise<StoredMemory[]> {
    const memories: StoredMemory[] = []
    const seen = new Set<string>()

    const facts = await memoryStore.getByCategory('fact', 10)
    for (const m of facts.filter(f => f.importance >= 7 && f.subject === 'user')) {
        if (!seen.has(m.id)) {
            seen.add(m.id)
            memories.push(m)
        }
    }
    const preferences = await memoryStore.getByCategory('preference', 5)
    for (const m of preferences.filter(p => p.importance >= 6)) {
        if (!seen.has(m.id)) {
            seen.add(m.id)
            memories.push(m)
        }
    }
    const events = await memoryStore.getByCategory('event', 3)
    for (const m of events.filter(e => e.importance >= 7)) {
        if (!seen.has(m.id)) {
            seen.add(m.id)
            memories.push(m)
        }
    }
    return memories.sort((a, b) => effectiveStrength(b) - effectiveStrength(a)).slice(0, 5)
}
