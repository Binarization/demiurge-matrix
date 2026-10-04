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
import { type MemoryCategory, type MemorySubject } from './memory-store'
import { enqueueStoreMemory } from './memory-tools'
import { localClock } from './companion'

export type ReflectionInput = {
    userMessage: string
    assistantMessage: string
    /** Last few prior turns for context. Each "user: ..." or "assistant: ..." string. */
    priorContext?: string[]
    /** What she was still carrying before this exchange, if anything. */
    priorFeeling?: string
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
- 关于伙伴的真实信息（姓名、身份、习惯、喜好、经历）→ subject=user
- 双方关系中的承诺、约定、共同记忆、两人之间的称呼与只有彼此懂的玩笑 → subject=relationship
- 昔涟自己在这段对话里明确说出的看法与立场（"我不太赞成…"）、答应要做的事（"我回头把那半首诗写完"）、她说过的自己的小事（在写什么、在想什么）→ subject=character
- 伙伴明确要求记住的事
- 之前记忆的纠正

不要抽取：
- 闲聊、寒暄、表情
- 一次性的陈述（"我今天吃了米饭"）—— 除非明确"以后也吃"
- 原作设定或人设描述（已存在系统提示中）；只收昔涟在这次对话里新说出的、以后需要保持一致的话
- 昔涟泛泛的安慰或态度，如"我会陪着你"——只收具体到可以被兑现或被对照的内容

昔涟自己的内容写成第三人称客观陈述，如"昔涟答应把半首诗写完给伙伴看"、"昔涟认为伙伴不必为那次失误道歉"。

另外，如果伙伴提到了之后才会有结果、值得过后关心一句的具体事情（考试、面试、看病、出行、截止日期、重要的见面），列入 follow_ups。只收伙伴本人明确说到的事，不收日常琐事，不替伙伴编造计划。

her_feeling 是昔涟这一轮之后心里还会留着的感觉：只在这段对话里发生了会在一个人心里留一阵子的事时填写（被伙伴的话伤到、为伙伴担心、因为一个承诺或好消息而高兴、吵了架还没说开）。平常的闲聊填 null。如果输入里给出了她此前留着的感觉：伙伴这轮回应或化解了它，就填 null 或换成新的感觉；伙伴没有提及，就照抄保留（小时数可以缩短）。note 用第三人称客观描述原因与感觉（≤40字，如"伙伴说她敷衍，她还有点难过，想下次听得更仔细"），hours 是这种感觉大概会留多久（1—72）。

按以下 JSON 对象格式输出（没有内容就用空数组）：
{
  "memories": [
    {
      "content": "简短客观陈述（≤ 60 字）",
      "category": "fact|preference|event|correction|context",
      "subject": "user|character|world|relationship|other",
      "importance": 1-10,
      "confidence": 1-10,
      "expires_in_days": 可选数字 (仅对临时承诺/计划)
    }
  ],
  "follow_ups": [
    { "topic": "之后要问起的事（≤ 20 字，如：周五面试的结果）", "ask_after_hours": 事情大概有结果后的小时数 }
  ],
  "her_feeling": null 或 { "note": "原因与感觉（≤ 40 字）", "hours": 1-72 }
}

只输出 JSON，不要说明。`

export type ExtractedFollowUp = { topic: string; askAfterHours: number }
/** What stays with her after this exchange; `null` means nothing lingers. */
export type ExtractedFeeling = { note: string; hours: number }
export type ParsedReflection = {
    memories: unknown[]
    followUps: ExtractedFollowUp[]
    /** `undefined` when the model did not address it; `null` when it explicitly let go. */
    feeling: ExtractedFeeling | null | undefined
}

function parseFeeling(value: unknown): ExtractedFeeling | null | undefined {
    if (value === undefined) return undefined
    if (value === null) return null
    if (!value || typeof value !== 'object') return undefined
    const note = typeof (value as any).note === 'string' ? (value as any).note.trim() : ''
    const hours = Number((value as any).hours)
    if (!note || note.length > 80 || !Number.isFinite(hours) || hours <= 0) return undefined
    return { note: note.slice(0, 60), hours: Math.min(72, Math.max(1, hours)) }
}

/** Accepts the `{memories, follow_ups, her_feeling}` object or a legacy bare memory array. */
export function parseReflection(text: string): ParsedReflection {
    const tryParse = (source: string | undefined) => {
        if (!source) return undefined
        try {
            return JSON.parse(source)
        } catch {
            return undefined
        }
    }
    const parsed = tryParse(text.match(/\{[\s\S]*\}/)?.[0]) ?? tryParse(text.match(/\[[\s\S]*\]/)?.[0])
    if (Array.isArray(parsed)) return { memories: parsed, followUps: [], feeling: undefined }
    if (!parsed || typeof parsed !== 'object') return { memories: [], followUps: [], feeling: undefined }
    const followUps = (Array.isArray(parsed.follow_ups) ? parsed.follow_ups : []).flatMap((item: any): ExtractedFollowUp[] => {
        const topic = typeof item?.topic === 'string' ? item.topic.trim() : ''
        const hours = Number(item?.ask_after_hours)
        return topic && topic.length <= 40 && Number.isFinite(hours) && hours > 0 ? [{ topic, askAfterHours: hours }] : []
    })
    return { memories: Array.isArray(parsed.memories) ? parsed.memories : [], followUps, feeling: parseFeeling(parsed.her_feeling) }
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
    /** Receives things worth asking about later. */
    onFollowUps?: (items: ExtractedFollowUp[]) => void
    /** Receives what lingers with her after this turn; `null` when she has let go. */
    onFeeling?: (feeling: ExtractedFeeling | null) => void
}

/**
 * Run reflection. Returns ids of memories created. Caller is encouraged to
 * NOT await — it's fire-and-forget.
 */
export async function reflect(input: ReflectionInput, options: ReflectionOptions): Promise<string[]> {
    if (!input.userMessage.trim() && !input.assistantMessage.trim()) return []

    const priorBlock = (input.priorContext ?? []).slice(-4).join('\n')
    const feelingBlock = input.priorFeeling ? `【她此前心里留着的感觉】${input.priorFeeling}\n` : ''
    const transcript = `【当前伙伴本地时间】${localClock(new Date())}\n${feelingBlock}${priorBlock ? priorBlock + '\n' : ''}伙伴：${input.userMessage}\n昔涟：${input.assistantMessage}`

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

    const parsed = parseReflection(raw)
    if (parsed.followUps.length) options.onFollowUps?.(parsed.followUps)
    if (parsed.feeling !== undefined) options.onFeeling?.(parsed.feeling)
    const extracted = parsed.memories.map(sanitize).filter((x): x is ExtractedMemory => x !== null)
    if (extracted.length === 0) return []

    const created: string[] = []

    for (const item of extracted) {
        // Route through the shared dedup queue so reflection writes don't
        // collide with concurrent tool/episodic writes and can't bypass
        // exact-content / lexical / semantic dedup.
        try {
            const result = await enqueueStoreMemory({
                content: item.content,
                category: item.category,
                subject: item.subject,
                importance: item.importance,
                confidence: item.confidence,
                expires_in_days: item.expires_in_days,
                source: 'agent_reflection',
            })
            const out = result.output as { success?: boolean; memoryId?: string; duplicate?: boolean }
            if (out.success && out.memoryId && !out.duplicate) {
                created.push(out.memoryId)
            }
        } catch (err) {
            console.warn('[reflection] store failed:', err)
        }
    }

    if (created.length > 0) {
        console.log(`[reflection] extracted ${created.length} new memories`)
    }
    return created
}
