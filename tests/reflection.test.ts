import { expect, mock, test } from 'bun:test'

// Same in-memory store shape as agent-memory.test.ts: no browser database, no network.
let records: any[] = []
const memoryStore = {
    getAllValid: async () => records.filter(m => m.isValid === 1),
    search: async () => [],
    getById: async (id: string) => records.find(m => m.id === id),
    update: async (id: string, changes: any) => Object.assign(records.find(m => m.id === id), changes),
    recordAccess: async () => {},
    store: async (content: string, category: string, importance: number, options: any) => {
        const record = { id: `m${records.length}`, content, category, importance, isValid: 1, ...options }
        records.push(record)
        return record
    },
    supersede: async () => {},
}
mock.module('../src/lib/memory-store', () => ({ memoryStore, effectiveStrength: () => 1 }))
mock.module('../src/lib/memory-search', () => ({
    hybridSearch: async () => [],
    findSimilarByEmbedding: async () => [],
    rerankWithLLM: async (_: any, candidates: any) => candidates,
}))
mock.module('../src/lib/embeddings', () => ({
    isEmbeddingsAvailable: () => false,
    embed: async () => [1, 0],
    cosineSimilarity: () => 0,
}))
const { reflect } = await import('../src/lib/reflection')

const client = (content: string) => ({ sendChat: async () => ({ choices: [{ message: { content } }] }) }) as any

test('her own commitments and opinions are stored under the character subject', async () => {
    records = []
    const output = JSON.stringify({
        memories: [
            { content: '昔涟答应把半首诗写完给伙伴看', category: 'event', subject: 'character', importance: 6, confidence: 9 },
            { content: '伙伴叫昔涟"小涟"', category: 'preference', subject: 'relationship', importance: 6, confidence: 8 },
            { content: '', category: 'fact', subject: 'user' },
        ],
        follow_ups: [],
    })
    const ids = await reflect({ userMessage: '那首诗写完了记得给我看', assistantMessage: '好，我答应你。' }, { client: client(output) })
    expect(ids).toHaveLength(2)
    expect(records.map(item => item.subject)).toEqual(['character', 'relationship'])
    expect(records.every(item => item.source === 'agent_reflection')).toBe(true)
})

test('what lingers with her is reported, and an explicit null lets it go', async () => {
    records = []
    const seen: any[] = []
    const withFeeling = JSON.stringify({ memories: [], follow_ups: [], her_feeling: { note: '伙伴说她敷衍，她还有点难过', hours: 200 } })
    await reflect({ userMessage: '你总是敷衍', assistantMessage: '是我的问题。' }, { client: client(withFeeling), onFeeling: f => seen.push(f) })
    expect(seen).toEqual([{ note: '伙伴说她敷衍，她还有点难过', hours: 72 }])
    await reflect({ userMessage: '刚才说重了，对不起', assistantMessage: '没事的。', priorFeeling: '她还有点难过' },
        { client: client('{"memories":[],"follow_ups":[],"her_feeling":null}'), onFeeling: f => seen.push(f) })
    expect(seen[1]).toBeNull()
    await reflect({ userMessage: '今天天气好', assistantMessage: '是呢。' }, { client: client('{"memories":[]}'), onFeeling: f => seen.push(f) })
    expect(seen).toHaveLength(2)
})
