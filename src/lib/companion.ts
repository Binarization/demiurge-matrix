/**
 * Companionship continuity: local time sense, absence awareness and
 * "things she keeps in mind" (follow-ups) between visits.
 *
 * Everything here is derived from the real transcript and reflection output;
 * nothing invents shared history.
 */
import type { ConversationEntry, ConversationSession } from './conversation-store'

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
/** A visit after this much silence counts as "coming back". */
export const RETURN_GAP_MS = 3 * HOUR_MS
/** Due follow-ups older than this are dropped rather than asked late. */
const FOLLOW_UP_STALE_MS = 4 * DAY_MS
const MAX_OPEN_FOLLOW_UPS = 12

export type FollowUp = {
    id: string
    /** What to ask about, e.g. "周五的面试结果". */
    topic: string
    createdAt: number
    askAfter: number
    status: 'open' | 'raised' | 'dropped'
}

/** Something that stayed with her after an exchange; fades by `until`. */
export type Feeling = {
    note: string
    createdAt: number
    until: number
}

export function feelingFrom(incoming: { note: string; hours: number } | null, now = Date.now()): Feeling | undefined {
    if (!incoming) return undefined
    const note = incoming.note.trim().slice(0, 60)
    if (!note) return undefined
    return { note, createdAt: now, until: now + Math.min(72, Math.max(1, incoming.hours)) * HOUR_MS }
}

export function currentFeeling(feeling: Feeling | undefined, now = Date.now()): Feeling | undefined {
    return feeling && feeling.until > now ? feeling : undefined
}

const feelingLine = (session: ConversationSession, now: number) => {
    const feeling = currentFeeling(session.feeling, now)
    return feeling ? `上次对话后你心里还留着的感觉（${describeGap(now - feeling.createdAt)}前）：${feeling.note}。可以自然带出，不夸大、不反复提；伙伴解释或道歉后就放下。` : ''
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

export function timeOfDay(date: Date): string {
    const h = date.getHours()
    if (h < 5) return '深夜'
    if (h < 8) return '清晨'
    if (h < 11) return '上午'
    if (h < 13) return '中午'
    if (h < 17) return '下午'
    if (h < 19) return '傍晚'
    if (h < 23) return '晚上'
    return '深夜'
}

export function describeGap(ms: number): string {
    if (ms < 10 * 60_000) return '刚刚还在聊'
    if (ms < HOUR_MS) return `约${Math.round(ms / 60_000)}分钟`
    if (ms < DAY_MS) return `约${Math.round(ms / HOUR_MS)}小时`
    const days = Math.round(ms / DAY_MS)
    if (days < 14) return `约${days}天`
    if (days < 60) return `约${Math.round(days / 7)}周`
    return `约${Math.round(days / 30)}个月`
}

export function localClock(now: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0')
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} 星期${WEEKDAYS[now.getDay()]} ${pad(now.getHours())}:${pad(now.getMinutes())}（${timeOfDay(now)}，${zone}）`
}

const lastUserEntry = (messages: ConversationEntry[]) =>
    [...messages].reverse().find(entry => entry.role === 'user' && entry.status === 'complete')

/** Page open but nobody has said anything for this long: she may say one soft line. */
export const QUIET_SPEAK_AFTER_MS = 12 * 60_000

export type QuietState = { now: number; lastActivityAt: number }

/**
 * May she break a long silence while the partner is (apparently) still here?
 * Only once per silence: her unprompted line is a `greeting`, and she never
 * stacks a second one before the partner answers. A failed or interrupted turn
 * is not hers to talk over.
 */
export function shouldSpeakWhileQuiet(session: ConversationSession, state: QuietState): boolean {
    const last = session.messages[session.messages.length - 1]
    if (!last || last.kind === 'greeting' || last.status !== 'complete') return false
    const quietFor = Math.min(state.now - last.timestamp, state.now - state.lastActivityAt)
    return quietFor >= QUIET_SPEAK_AFTER_MS
}

/** Should she speak first on this visit? */
export function shouldGreetOnReturn(session: ConversationSession, now = Date.now()): boolean {
    const last = session.messages[session.messages.length - 1]
    if (!last || last.kind === 'greeting') return false
    return now - last.timestamp >= RETURN_GAP_MS
}

export function dueFollowUps(followUps: FollowUp[] = [], now = Date.now()): FollowUp[] {
    return followUps.filter(item => item.status === 'open' && item.askAfter <= now && now - item.askAfter < FOLLOW_UP_STALE_MS)
}

/** Mark raised follow-ups and drop stale ones; returns a pruned list. */
export function settleFollowUps(followUps: FollowUp[] = [], raised: FollowUp[], now = Date.now()): FollowUp[] {
    const raisedIds = new Set(raised.map(item => item.id))
    return followUps
        .map(item => {
            if (raisedIds.has(item.id)) return { ...item, status: 'raised' as const }
            if (item.status === 'open' && now - item.askAfter >= FOLLOW_UP_STALE_MS) return { ...item, status: 'dropped' as const }
            return item
        })
        .filter(item => item.status === 'open' || now - item.askAfter < 30 * DAY_MS)
        .slice(-40)
}

export function addFollowUps(
    followUps: FollowUp[] = [],
    incoming: Array<{ topic: string; askAfterHours: number }>,
    now = Date.now()
): FollowUp[] {
    const next = [...followUps]
    for (const { topic, askAfterHours } of incoming) {
        const clean = topic.trim().slice(0, 40)
        if (!clean || next.some(item => item.status === 'open' && item.topic === clean)) continue
        next.push({
            id: crypto.randomUUID(),
            topic: clean,
            createdAt: now,
            askAfter: now + Math.max(1, Math.min(24 * 30, askAfterHours)) * HOUR_MS,
            status: 'open',
        })
    }
    const open = next.filter(item => item.status === 'open')
    const overflow = new Set(open.slice(0, Math.max(0, open.length - MAX_OPEN_FOLLOW_UPS)).map(item => item.id))
    return next.filter(item => !overflow.has(item.id))
}

/** Per-turn presence facts appended to the interaction context. */
export function presenceContext(session: ConversationSession, due: FollowUp[], now = Date.now()): string {
    const parts = [`伙伴本地时间：${localClock(new Date(now))}。`]
    const first = session.messages[0]
    if (first) parts.push(`第一条对话记录在${describeGap(now - first.timestamp)}前。`)
    const previousUser = lastUserEntry(session.messages)
    if (previousUser) parts.push(`伙伴上一条消息在${describeGap(now - previousUser.timestamp)}前。`)
    const feeling = feelingLine(session, now)
    if (feeling) parts.push(feeling)
    if (due.length)
        parts.push(`伙伴之前提过、现在可能已有结果的事：${due.map(item => item.topic).join('；')}。若与当前话题不冲突，可以自然关心一句；伙伴正忙着说别的就先放下，不追问。`)
    return parts.join('')
}

/** Context for the line she offers when the partner has gone quiet but stayed. */
export function quietBrief(session: ConversationSession, due: FollowUp[], quietForMs: number, now = Date.now()): string {
    const recent = session.messages
        .filter(entry => entry.status === 'complete')
        .slice(-4)
        .map(entry => `${entry.role === 'user' ? '伙伴' : '昔涟'}：${entry.content.replace(/^\s*<emote\b[^>]*>\s*/i, '').slice(0, 120)}`)
    const own = (session.sceneEvents ?? [])
        .filter(event => event.outcome === 'complete' && event.action.startsWith('自己') && now - event.timestamp < 30 * 60_000)
        .slice(-3)
        .map(event => event.action)
    return [
        `伙伴本地时间：${localClock(new Date(now))}。`,
        `页面还开着，但伙伴已经${describeGap(quietForMs)}没有动静；不知道是在忙别的还是在看着你。`,
        recent.length ? `刚才的对话（真实记录）：\n${recent.join('\n')}` : '',
        own.length ? `这段安静里你自己做过的小事：${own.join('；')}。` : '',
        feelingLine(session, now),
        due.length ? `伙伴之前提过、现在可能已有结果的事：${due.map(item => item.topic).join('；')}。只在合适时轻轻问一件。` : '',
    ].filter(Boolean).join('\n')
}

/** Context for the "you're back" opening line. */
export function returnBrief(session: ConversationSession, due: FollowUp[], now = Date.now()): string {
    const last = session.messages[session.messages.length - 1]
    const recent = session.messages
        .filter(entry => entry.status === 'complete')
        .slice(-6)
        .map(entry => `${entry.role === 'user' ? '伙伴' : '昔涟'}：${entry.content.replace(/^\s*<emote\b[^>]*>\s*/i, '').slice(0, 120)}`)
    return [
        `伙伴本地时间：${localClock(new Date(now))}。`,
        last ? `距离上次对话：${describeGap(now - last.timestamp)}。` : '',
        recent.length ? `上次对话结尾（真实记录）：\n${recent.join('\n')}` : '',
        feelingLine(session, now),
        due.length ? `伙伴之前提过、现在可能已有结果的事：${due.map(item => item.topic).join('；')}。挑最重要的一件轻轻问起。` : '',
    ].filter(Boolean).join('\n')
}
