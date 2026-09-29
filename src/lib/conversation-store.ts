import type { ChatMessage } from './openrouter'
import type { Tool } from './agent'
import { emptyMood, normalizeMood, type Mood } from './interaction'

export const CONVERSATION_KEY = 'demiurge_conversation_v1'
export type ConversationEntry = {
    id: string
    role: 'user' | 'assistant'
    content: string
    timestamp: number
    status: 'complete' | 'pending' | 'failed' | 'interrupted'
    speechInterrupted?: boolean
}
export type ConversationSession = {
    version: 1
    messages: ConversationEntry[]
    mood: Mood
    moodUpdatedAt: number
    voiceEnabled: boolean
    voiceBackend?: 'webgpu' | 'wasm'
    sceneEvents?: Array<{ timestamp: number; action: string; outcome: 'complete' | 'cancel' }>
}
export const createSession = (): ConversationSession => ({ version: 1, messages: [], mood: emptyMood(), moodUpdatedAt: Date.now(), voiceEnabled: false })
export function loadConversation(storage: Pick<Storage, 'getItem'> = window.localStorage): ConversationSession {
    const raw = storage.getItem(CONVERSATION_KEY)
    if (!raw) return createSession()
    const data = JSON.parse(raw)
    if (data?.version !== 1 || !Array.isArray(data.messages)) throw new Error('对话存档格式无法识别，原存档未覆盖。')
    const messages = data.messages.map((entry: any): ConversationEntry => {
        if (!entry || typeof entry.id !== 'string' || !['user', 'assistant'].includes(entry.role) ||
            typeof entry.content !== 'string' || !Number.isFinite(entry.timestamp) ||
            !['complete', 'pending', 'failed', 'interrupted'].includes(entry.status)) throw new Error('对话存档损坏，原存档未覆盖。')
        return { id: entry.id, role: entry.role, content: entry.content, timestamp: entry.timestamp,
            status: entry.status === 'pending' ? 'interrupted' : entry.status,
            speechInterrupted: entry.speechInterrupted === true }
    })
    return { version: 1, messages, sceneEvents: Array.isArray(data.sceneEvents) ? data.sceneEvents.filter((event: any) => Number.isFinite(event?.timestamp) && typeof event.action === 'string' && ['complete', 'cancel'].includes(event.outcome)).slice(-20) : [], mood: normalizeMood(data.mood),
        moodUpdatedAt: Number.isFinite(data.moodUpdatedAt) ? data.moodUpdatedAt : Date.now(), voiceEnabled: data.voiceEnabled === true && ['webgpu', 'wasm'].includes(data.voiceBackend),
        voiceBackend: data.voiceBackend === 'wasm' ? 'wasm' : 'webgpu' }
}
export function saveConversation(session: ConversationSession, storage: Pick<Storage, 'setItem'> = window.localStorage) {
    // Let quota/security errors surface to the UI; never silently discard history.
    storage.setItem(CONVERSATION_KEY, JSON.stringify(session))
}
export function recentConversation(messages: ConversationEntry[], turns = 20): ChatMessage[] {
    const starts = messages.flatMap((entry, index) => entry.role === 'user' ? [index] : [])
    const start = starts.length > turns ? starts[starts.length - turns]! : 0
    return messages.slice(start).map(entry => ({
        role: entry.role,
        content: entry.content + (entry.status !== 'complete' ? '\n[此轮未完成，未收到最终回答]' : '') +
            (entry.speechInterrupted ? '\n[这条文字已显示，但朗读被伙伴打断]' : ''),
    }))
}
export function conversationRecallTool(getEntries: () => ConversationEntry[]): Tool {
    return {
        name: 'recall_conversation',
        description: '查找双方真实对话存档中的原话。用具体词语搜索，不要把未完成的轮次当成已履行约定。',
        parameters: { query: { type: 'string', description: '原话的关键词', required: true } },
        execute: async args => {
            const query = (args as { query?: unknown })?.query
            if (typeof query !== 'string' || !query.trim()) return { name:'recall_conversation', output:{ success:false, error:'需要搜索词' } }
            const terms = query.toLowerCase().trim().split(/\s+/)
            const matches = getEntries().filter(entry => terms.some(term => entry.content.toLowerCase().includes(term))).slice(-6)
            return { name:'recall_conversation', output:{ success:true, messages:matches, count:matches.length } }
        },
    }
}
