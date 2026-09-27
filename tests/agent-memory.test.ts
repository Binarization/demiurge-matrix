import { beforeEach, describe, expect, mock, test } from 'bun:test'

// Keep regressions deterministic: no real network requests or browser database.
let records: any[] = []
let lexicalCandidates: any[] = []
let vectorCandidates: any[] = []
let vectorsEnabled = false
const memoryStore = {
    getAllValid: async () => records.filter(m => m.isValid === 1),
    search: async () => lexicalCandidates,
    getById: async (id: string) => records.find(m => m.id === id),
    update: async (id: string, changes: any) => Object.assign(records.find(m => m.id === id), changes),
    recordAccess: async () => {},
    store: async (content: string, category: string, importance: number, options: any) => {
        const record = { id: `m${records.length}`, content, category, importance, isValid: 1, ...options }
        records.push(record)
        return record
    },
    supersede: async (id: string, replacement: string) => {
        Object.assign(records.find(m => m.id === id), {isValid: 0, supersededBy: replacement})
    },
}
mock.module('../src/lib/memory-store', () => ({ memoryStore, effectiveStrength: () => 1 }))
mock.module('../src/lib/memory-search', () => ({
    hybridSearch: async () => records.filter(m => m.isValid === 1),
    findSimilarByEmbedding: async () => vectorCandidates,
    rerankWithLLM: async (_: any, candidates: any) => candidates,
}))
mock.module('../src/lib/embeddings', () => ({
    isEmbeddingsAvailable: () => vectorsEnabled,
    embed: async () => [1, 0],
    cosineSimilarity: (a: number[], b: number[]) =>
        a.reduce((sum, value, index) => sum + value * b[index], 0) /
        Math.sqrt(a.reduce((sum, value) => sum + value ** 2, 0) * b.reduce((sum, value) => sum + value ** 2, 0)),
}))
const { Agent } = await import('../src/lib/agent')
const { enqueueStoreMemory, recallMemoryTool, forgetMemoryTool } = await import('../src/lib/memory-tools')
const reply = (message: any) => ({ choices: [{ message }] })
const toolCall = (name = 'recall_memory', id = 'call1') => ({
    id, type: 'function', function: { name, arguments: '{"query":"猫"}' },
})
const makeAgent = (sendChat: any, extra: any = {}) => new Agent({
    systemPrompt: 'test', client: { sendChat } as any,
    autoInjectMemories: false, enableReflection: false,
    enableEpisodicSummary: false, enableMemoryTools: false,
    tools: [recallMemoryTool], ...extra,
})
const memory = (extra: any = {}) => ({
    id: 'old', content: '伙伴的猫叫小白', category: 'fact', subject: 'user',
    importance: 5, confidence: 5, isValid: 1, ...extra,
})
beforeEach(() => {
    records = []; lexicalCandidates = []; vectorCandidates = []; vectorsEnabled = false
})

describe('agent tool lifecycle', () => {
    test('recall sends actual memory content and IDs to the next model request', async () => {
        records.push(memory())
        const requests: any[] = []
        const agent = makeAgent(async (messages: any[]) => {
            requests.push(structuredClone(messages))
            return requests.length === 1
                ? reply({ content: '我查一下。', tool_calls: [toolCall()] })
                : reply({ content: '你的小猫叫小白。' })
        })
        expect((await agent.run('我的猫叫什么？')).content).toBe('你的小猫叫小白。')
        expect(requests).toHaveLength(2)
        const result = JSON.parse(requests[1].find((m: any) => m.role === 'tool').content)
        expect(result.memories[0]).toMatchObject({ id: 'old', content: '伙伴的猫叫小白' })
    })
    test('tool failures are visible to the model before it answers', async () => {
        let calls = 0
        const agent = makeAgent(async (messages: any[]) => {
            if (++calls === 1) return reply({ content: '稍等。', tool_calls: [toolCall('broken')] })
            const result = JSON.parse(messages.find((m: any) => m.role === 'tool').content)
            expect(result.success).toBe(false)
            expect(result.error).toContain('offline')
            return reply({ content: '暂时没能查到。' })
        }, { tools: [{ name: 'broken', execute: () => { throw new Error('offline') } }] })
        expect((await agent.run('查询')).content).toBe('暂时没能查到。')
    })
    test('exhaustion produces a visible terminal answer with bounded requests', async () => {
        let calls = 0
        const agent = makeAgent(async () => {
            calls++
            return reply({ content: '我查一下。', tool_calls: [toolCall('recall_memory', `call${calls}`)] })
        })
        const result = await agent.run('问题')
        expect(calls).toBe(3)
        expect(result.content).not.toBe('')
        expect(result.content).not.toBe('我查一下。')
        expect(agent.getHistory().at(-1)).toMatchObject({ role: 'assistant', content: result.content })
    })
    test('empty model response receives a fallback', async () => {
        const agent = makeAgent(async () => reply({ content: '' }))
        expect((await agent.run('问题')).content.length).toBeGreaterThan(0)
    })
    test('trimming keeps complete user turns including multiple tool rounds', async () => {
        let calls = 0
        const requests: any[] = []
        const agent = makeAgent(async (messages: any[]) => {
            requests.push(structuredClone(messages))
            calls++
            if (calls <= 2) return reply({content:'',tool_calls:[toolCall('recall_memory', `call${calls}`)]})
            return reply({ content: `answer${calls}` })
        }, { maxContextMessages: 1 })
        await agent.run('first')
        await agent.run('second')
        const secondRequest = requests[3]
        expect(secondRequest.filter((m: any) => m.role === 'tool')).toHaveLength(2)
        await agent.run('third')
        const thirdRequest = requests[4]
        expect(thirdRequest.map((m: any) => m.role)).toEqual(['system', 'user', 'assistant', 'user'])
        expect(thirdRequest[1].content).toBe('second')
    })
})

describe('memory writes', () => {
    test('lexical match with unrelated vector does not swallow new information', async () => {
        vectorsEnabled = true
        const old = memory({embedding:[0,1]})
        records.push(old); lexicalCandidates.push(old)
        const result = await enqueueStoreMemory({ content: '伙伴养了一只狗', category: 'fact' })
        expect((result.output as any).duplicate).not.toBe(true)
        expect(records).toHaveLength(2)
    })
    test('matching vectors still deduplicate', async () => {
        vectorsEnabled = true
        const old = memory({embedding:[1,0]})
        records.push(old); vectorCandidates.push(old)
        const result = await enqueueStoreMemory({ content: '小白是伙伴养的猫', category: 'fact' })
        expect((result.output as any).duplicate).toBe(true)
        expect(records).toHaveLength(1)
    })
    test('vectors of different dimensions are not treated as duplicates', async () => {
        vectorsEnabled = true
        const old = memory({embedding:[1,0,0]})
        records.push(old); lexicalCandidates.push(old)
        await enqueueStoreMemory({ content: '伙伴养了一只狗', category: 'fact' })
        expect(records).toHaveLength(2)
    })
    test('lexical dedup still works with embeddings disabled', async () => {
        const old = memory()
        records.push(old); lexicalCandidates.push(old)
        const result = await enqueueStoreMemory({ content: '伙伴的猫叫小白呀', category: 'fact' })
        expect((result.output as any).duplicate).toBe(true)
        expect(records).toHaveLength(1)
    })
    test('forget with a reason keeps only the invalidated audit record', async () => {
        records.push(memory())
        const result = await forgetMemoryTool.execute({ memoryId:'old', reason:'请忘掉' }, {} as any)
        expect((result.output as any).success).toBe(true)
        expect(records).toHaveLength(1)
        expect(records[0].isValid).toBe(0)
        const recalled = await recallMemoryTool.execute({ query:'猫' }, {} as any)
        expect((recalled.output as any).memories).toEqual([])
    })
})

describe('restoration and interruption', () => {
    test('the actual greeting and previous exchange reach the model after reconstruction', async () => {
        const agent=makeAgent(async (messages:any[])=>{
            expect(messages.slice(1,4).map((m:any)=>m.content)).toEqual(['你来啦','我喜欢星星','我记住了'])
            return reply({content:'我们接着聊。'})
        },{initialHistory:[{role:'assistant',content:'你来啦'},{role:'user',content:'我喜欢星星'},{role:'assistant',content:'我记住了'}]})
        await agent.run('继续')
    })
    test('aborted model responses never execute tools or append a stale answer', async () => {
        const abort=new AbortController()
        let release:(value:any)=>void=()=>{}
        let writes=0
        const pending=new Promise(resolve=>{release=resolve})
        const agent=makeAgent(async()=>pending,{tools:[{name:'write',execute:()=>{writes++;return {name:'write',output:{}}}}]})
        const running=agent.run('问题',{signal:abort.signal})
        await Promise.resolve();abort.abort()
        release(reply({content:'过时回复',tool_calls:[toolCall('write')]}))
        await expect(running).rejects.toThrow()
        expect(writes).toBe(0)
        expect(agent.getHistory().some(m=>m.content==='过时回复')).toBe(false)
    })
})

describe('streamed final answer',()=>{
    test('tool results finish before any visible delta and finish tool is not spoken',async()=>{
        records.push(memory())
        let calls=0;const deltas:string[]=[]
        const agent=makeAgent(async(messages:any[],options:any)=>{
            calls++
            if(calls===1){expect(options.toolChoice).toBe('required');return reply({content:'不应朗读',tool_calls:[toolCall()]})}
            if(calls===2){expect(messages.some(m=>m.role==='tool' && m.content.includes('小白'))).toBe(true);return reply({tool_calls:[{...toolCall('begin_response','finish'),function:{name:'begin_response',arguments:'{}'}}]})}
            expect(options.stream).toBe(true);expect(options.tools).toBeUndefined();expect(deltas).toEqual([])
            return (async function*(){yield {data:{choices:[{delta:{content:'小白'},finishReason:null}]}};yield {data:{choices:[{delta:{content:'很可爱。'},finishReason:'stop'}]}}})()
        })
        const result=await agent.run('我的猫叫什么？',{stream:true,onDelta:d=>deltas.push(d)})
        expect(deltas).toEqual(['小白','很可爱。']);expect(result.content).toBe('小白很可爱。')
        expect(calls).toBe(3)
    })
    test('without tools final response streams directly',async()=>{
        let calls=0
        const agent=makeAgent(async(_messages:any[],options:any)=>{
            calls++;expect(options.stream).toBe(true)
            return (async function*(){yield {choices:[{delta:{content:'你好。'},finish_reason:'stop'}]}})()
        },{tools:[]})
        expect((await agent.run('你好',{stream:true})).content).toBe('你好。');expect(calls).toBe(1)
    })
})
