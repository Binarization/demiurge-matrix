/**
 * Background reflection pass.
 *
 * After each agent turn, we ask a small model to extract durable memories
 * from the exchange. Decoupling this from the in-character chat flow means:
 *   1. The Cyrene persona doesn't need to break flow to call store_memory.
 *   2. Memory extraction can use a structured-output prompt without bleeding
 *      style instructions into the chat reply.
 *
 * Fire-and-forget — caller doesn't await. Errors are logged, never thrown.
 */

import type { OpenRouterClient } from './openrouter'
import { memoryStore, type MemoryCategory, type MemorySubject } from './memory-store'
import { embed, isEmbeddingsAvailable } from './embeddings'
import { findSimilarByEmbedding } from './memory-search'

export type ReflectionInput = {
    userMessage: string
    assistantMessage: string
    /** Last few prior turns for context. Each "user: ..." or "assistant: ..." string. */
    priorContext?: string[]
}

type ExtractedMemory = {
    content: string
    category: MemoryCategory
    subject: MemorySubject
    importance: number
    confidence: number
    expires_in_days?: number
}

const VALID_CATEGORIES: MemoryCategory[] = ['fact', 'preference', 'event', 'correction', 'context']
const VALID_SUBJECTS: MemorySubject[] = ['user', 'character', 'world', 'relationship', 'other']

const SYSTEM_PROMPT = `你是一名记忆抽取员。从一段"用户(伙伴)"和"助手(昔涟)"的对话中，挑出值得长期保留的事实/偏好/事件/纠正。

只抽取：
- 关于伙伴的真实信息（姓名、身份、习惯、喜好、经历）
- 双方关系中的承诺、约定、共同记忆
- 伙伴明确要求记住的事
- 之前记忆的纠正

不要抽取：
- 闲聊、寒暄、表情
- 一次性的陈述（"我今天吃了米饭"）—— 除非明确"以后也吃"
- 助手自己的人设描述（已存在系统提示中）

按以下 JSON 数组格式输出（如果没有值得记的，返回空数组）：
[
  {
    "content": "简短客观陈述（≤ 60 字）",
    "category": "fact|preference|event|correction|context",
    "subject": "user|character|world|relationship|other",
    "importance": 1-10,
    "confidence": 1-10,
    "expires_in_days": 可选数字 (仅对临时承诺/计划)
  }
]

只输出 JSON 数组，不要说明。`

function parseJSONArray(text: string): unknown[] {
    const match = text.match(/\[[\s\S]*\]/)
    if (!match) return []
    try {
        const parsed = JSON.parse(match[0])
        return Array.isArray(parsed) ? parsed : []
    } catch {
        return []
    }
}

function sanitize(item: unknown): ExtractedMemory | null {
    if (!item || typeof item !== 'object') return null
    const o = item as Record<string, unknown>
    const content = typeof o.content === 'string' ? o.content.trim() : ''
    if (!content || content.length > 200) return null

    const category = VALID_CATEGORIES.includes(o.category as MemoryCategory) ? (o.category as MemoryCategory) : 'context'
    const subject = VALID_SUBJECTS.includes(o.subject as MemorySubject) ? (o.subject as MemorySubject) : 'other'
    const importance = clamp(typeof o.importance === 'number' ? o.importance : 5, 1, 10)
    const confidence = clamp(typeof o.confidence === 'number' ? o.confidence : 6, 1, 10)
    const expiresInDays = typeof o.expires_in_days === 'number' && o.expires_in_days > 0 ? o.expires_in_days : undefined

    return { content, category, subject, importance, confidence, expires_in_days: expiresInDays }
}

function clamp(n: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, n))
}

export type ReflectionOptions = {
    client: OpenRouterClient
    /** Cheap model used for extraction. Defaults to whatever the client is set to. */
    model?: string
    /** Skip writing if a similar memory already exists (cosine ≥ this). */
    similarityThreshold?: number
}

/**
 * Run reflection. Returns ids of memories created. Caller is encouraged to
 * NOT await — it's fire-and-forget.
 */
export async function reflect(input: ReflectionInput, options: ReflectionOptions): Promise<string[]> {
    if (!input.userMessage.trim() && !input.assistantMessage.trim()) return []

    const priorBlock = (input.priorContext ?? []).slice(-4).join('\n')
    const transcript = `${priorBlock ? priorBlock + '\n' : ''}伙伴：${input.userMessage}\n昔涟：${input.assistantMessage}`

    let raw: string
    try {
        const response = await options.client.sendChat(
            [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: transcript },
            ],
            { model: options.model }
        )
        raw = (response as any)?.choices?.[0]?.message?.content ?? ''
    } catch (err) {
        console.warn('[reflection] LLM call failed:', err)
        return []
    }

    const extracted = parseJSONArray(raw).map(sanitize).filter((x): x is ExtractedMemory => x !== null)
    if (extracted.length === 0) return []

    const created: string[] = []
    const threshold = options.similarityThreshold ?? 0.85
    const embedAvailable = isEmbeddingsAvailable()

    for (const item of extracted) {
        // Optional dedup by embedding similarity
        let embedding: number[] | null = null
        if (embedAvailable) {
            embedding = await embed(item.content)
            if (embedding) {
                const similar = await findSimilarByEmbedding(embedding, threshold, 1)
                if (similar.length > 0) continue // Skip — already remembered
            }
        }

        const expiresAt = item.expires_in_days
            ? Date.now() + item.expires_in_days * 24 * 60 * 60 * 1000
            : undefined

        try {
            const stored = await memoryStore.store(item.content, item.category, item.importance, {
                subject: item.subject,
                confidence: item.confidence,
                source: 'agent_reflection',
                embedding: embedding ?? undefined,
                expiresAt,
            })
            created.push(stored.id)
        } catch (err) {
            console.warn('[reflection] store failed:', err)
        }
    }

    if (created.length > 0) {
        console.log(`[reflection] extracted ${created.length} new memories`)
    }
    return created
}
