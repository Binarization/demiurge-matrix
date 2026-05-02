import type { ChatMessage } from './openrouter'
import { OpenRouterClient } from './openrouter'
import { memoryStore, type StoredMemory } from './memory-store'
import { enqueueStoreMemory, formatMemoriesForPrompt, getRelevantMemories, memoryTools } from './memory-tools'
import { hybridSearch, rerankWithLLM } from './memory-search'
import { reflect } from './reflection'

type ToolExecutionContext = {
    addMemory: (entry: MemoryEntry) => void
    memory: ReadonlyArray<MemoryEntry>
}

export type ToolResult = {
    name: string
    output: unknown
    message?: string
    memoryEntry?: MemoryEntry
    toolCallId?: string
}

export type ToolParameter = {
    type: 'string' | 'number' | 'boolean' | 'object' | 'array'
    description: string
    enum?: string[]
    required?: boolean
}

export type Tool = {
    name: string
    description: string
    parameters?: Record<string, ToolParameter>
    execute: (args: unknown, context: ToolExecutionContext) => Promise<ToolResult> | ToolResult
}

export type ToolCallRequest = {
    id?: string
    name: string
    arguments: Record<string, unknown>
}

export type MemoryEntry = {
    role: 'system' | 'user' | 'assistant' | 'tool' | 'memory'
    content: string
    timestamp: number
    metadata?: Record<string, unknown>
}

type AgentOptions = {
    name?: string
    systemPrompt: string
    model?: string
    tools?: Tool[]
    maxRecursions?: number
    client?: OpenRouterClient
    /** Conversation turns to keep in history (default: 20). */
    maxContextMessages?: number
    /** Register the built-in memory tools (default: true). */
    enableMemoryTools?: boolean
    /** Auto-inject relevant memories into the system prompt (default: true). */
    autoInjectMemories?: boolean
    /** Maximum memories to inject per request (default: 5). */
    maxInjectedMemories?: number
    /** LLM-rerank the hybrid candidates for better precision (default: true). */
    enableRerank?: boolean
    /** Run reflection pass after each turn (default: true). */
    enableReflection?: boolean
    /** Summarize old turns into an episodic memory before trimming (default: true). */
    enableEpisodicSummary?: boolean
    /** Cheap model for reflection/rerank/summary. Falls back to main model. */
    auxiliaryModel?: string
}

type AgentRunOptions = {
    maxRecursions?: number
    stream?: boolean
}

export type AgentRunResult = {
    content: string
    raw: unknown
}

type OpenRouterToolCall = {
    id: string
    type: 'function'
    function: {
        name: string
        arguments: string
    }
}

type OpenRouterToolDefinition = {
    type: 'function'
    function: {
        name: string
        description: string
        parameters: {
            type: 'object'
            properties: Record<string, unknown>
            required: string[]
        }
    }
}

const MEMORY_TOOL_NAMES = new Set([
    'store_memory',
    'recall_memory',
    'forget_memory',
    'update_memory',
    'list_memories',
    'cleanup_memories',
])

const CATEGORY_ENUM = ['fact', 'preference', 'event', 'correction', 'context']
const SUBJECT_ENUM = ['user', 'character', 'world', 'relationship', 'other']

export class Agent {
    private readonly baseSystemPrompt: string
    private readonly model?: string
    private readonly client: OpenRouterClient
    private readonly maxRecursions: number
    private readonly maxContextMessages: number
    private readonly autoInjectMemories: boolean
    private readonly maxInjectedMemories: number
    private readonly enableRerank: boolean
    private readonly enableReflection: boolean
    private readonly enableEpisodicSummary: boolean
    private readonly auxiliaryModel?: string
    private readonly toolRegistry = new Map<string, Tool>()
    private readonly history: ChatMessage[] = []
    private readonly memory: MemoryEntry[] = []
    private injectedMemories: StoredMemory[] = []
    private lastUserInput = ''

    constructor(options: AgentOptions) {
        this.baseSystemPrompt = options.systemPrompt
        this.model = options.model
        this.maxRecursions = options.maxRecursions ?? 3
        this.maxContextMessages = options.maxContextMessages ?? 20
        this.autoInjectMemories = options.autoInjectMemories ?? true
        this.maxInjectedMemories = options.maxInjectedMemories ?? 5
        this.enableRerank = options.enableRerank ?? true
        this.enableReflection = options.enableReflection ?? true
        this.enableEpisodicSummary = options.enableEpisodicSummary ?? true
        this.auxiliaryModel = options.auxiliaryModel
        this.client = options.client ?? new OpenRouterClient({ model: options.model })

        options.tools?.forEach(tool => this.registerTool(tool))

        if (options.enableMemoryTools !== false) {
            memoryTools.forEach(tool => {
                if (!this.toolRegistry.has(tool.name)) this.registerTool(tool)
            })
        }
    }

    registerTool(tool: Tool) {
        if (this.toolRegistry.has(tool.name)) {
            console.warn(`Tool "${tool.name}" is already registered, skipping.`)
            return
        }
        this.toolRegistry.set(tool.name, tool)
    }

    getHistory(): ReadonlyArray<ChatMessage> {
        return this.history
    }

    getMemory(): ReadonlyArray<MemoryEntry> {
        return this.memory
    }

    getClient(): OpenRouterClient {
        return this.client
    }

    addMemory(entry: Omit<MemoryEntry, 'timestamp'> & Partial<Pick<MemoryEntry, 'timestamp'>>) {
        const timestamp = entry.timestamp ?? Date.now()
        const { timestamp: _ignored, ...rest } = entry
        this.memory.push({ ...(rest as Omit<MemoryEntry, 'timestamp'>), timestamp })
    }

    /**
     * Build the system prompt — base prompt + tool instructions + injected
     * memory section (if auto-injection is on).
     */
    private buildSystemPrompt(injectedMemories: StoredMemory[]): string {
        const memorySection = this.autoInjectMemories ? formatMemoriesForPrompt(injectedMemories) : ''

        const memoryInstructions = `
【记忆管理 - 主动维护】
你拥有长期记忆能力，必须主动使用！

可用工具：
- store_memory（content, category, subject?, importance, confidence?, expires_in_days?）
- forget_memory / update_memory（修改既有记忆）
- recall_memory（混合检索：关键词+语义+时效）
- list_memories（按 strongest/recent/important 排序）
- cleanup_memories（按强度阈值清理衰减记忆）

⚡ 立即存储：姓名/身份 → fact (importance 9-10) | 偏好 → preference (7-8)
🗑️ 立即更正：与已有记忆矛盾时 → store_memory 会自动取代旧记忆，无需手动 forget
🔄 临时计划：用 expires_in_days 标注（如"下周去北京"用 7）
🚫 不需要记忆：闲聊、问候、临时话题

importance：10=核心身份 | 8-9=重要 | 6-7=一般 | 4-5=背景 | 1-3=临时
confidence：用户明说=9-10 | 你推断=5-7 | 不确定=1-4
`

        return this.baseSystemPrompt + memoryInstructions + memorySection
    }

    private getToolDefinitions(): OpenRouterToolDefinition[] {
        const definitions: OpenRouterToolDefinition[] = []

        for (const [_, tool] of this.toolRegistry) {
            const properties: Record<string, unknown> = {}
            const required: string[] = []

            if (tool.name === 'store_memory') {
                properties.content = { type: 'string', description: '要记住的信息（≤60字）' }
                properties.category = { type: 'string', enum: CATEGORY_ENUM, description: '记忆类型' }
                properties.subject = { type: 'string', enum: SUBJECT_ENUM, description: '关于谁/什么（默认推断）' }
                properties.importance = { type: 'number', description: '重要性 1-10' }
                properties.confidence = { type: 'number', description: '可信度 1-10（默认=importance）' }
                properties.expires_in_days = { type: 'number', description: '过期天数（仅临时承诺/计划）' }
                properties.reason = { type: 'string', description: '为什么值得记住' }
                required.push('content', 'category')
            } else if (tool.name === 'recall_memory') {
                properties.query = { type: 'string', description: '搜索文本' }
                properties.limit = { type: 'number', description: '最大返回数量' }
                properties.category = { type: 'string', enum: CATEGORY_ENUM, description: '过滤类别' }
                properties.subject = { type: 'string', enum: SUBJECT_ENUM, description: '过滤主体' }
                required.push('query')
            } else if (tool.name === 'forget_memory') {
                properties.memoryId = { type: 'string', description: '记忆 ID' }
                properties.reason = { type: 'string', description: '原因' }
                required.push('memoryId')
            } else if (tool.name === 'update_memory') {
                properties.memoryId = { type: 'string', description: '记忆 ID' }
                properties.content = { type: 'string', description: '新内容' }
                properties.importance = { type: 'number', description: '新重要性 1-10' }
                properties.confidence = { type: 'number', description: '新可信度 1-10' }
                properties.reason = { type: 'string', description: '原因' }
                required.push('memoryId')
            } else if (tool.name === 'list_memories') {
                properties.category = { type: 'string', enum: CATEGORY_ENUM, description: '过滤类别' }
                properties.subject = { type: 'string', enum: SUBJECT_ENUM, description: '过滤主体' }
                properties.sortBy = {
                    type: 'string',
                    enum: ['recent', 'important', 'strongest'],
                    description: '排序方式',
                }
                properties.limit = { type: 'number', description: '最大返回数量' }
            } else if (tool.name === 'cleanup_memories') {
                properties.threshold = { type: 'number', description: '强度阈值，低于则清理（默认 0.5）' }
                properties.dryRun = { type: 'boolean', description: '仅预览不删除' }
            } else if (tool.parameters) {
                for (const [key, param] of Object.entries(tool.parameters)) {
                    properties[key] = {
                        type: param.type,
                        description: param.description,
                        ...(param.enum ? { enum: param.enum } : {}),
                    }
                    if (param.required) required.push(key)
                }
            }

            definitions.push({
                type: 'function',
                function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: { type: 'object', properties, required },
                },
            })
        }

        return definitions
    }

    /**
     * Trim history. Optionally summarizes the dropped tail into an episodic
     * memory before discarding so the long-term store retains the gist.
     */
    private async trimHistory(): Promise<void> {
        const conversationMessages = this.history.filter(m => m.role === 'user' || m.role === 'assistant')
        const turns = Math.floor(conversationMessages.length / 2)
        if (turns <= this.maxContextMessages) return

        const messagesToRemove = (turns - this.maxContextMessages) * 2

        // Collect the tail-to-be-dropped for summarization
        const tailToDrop: ChatMessage[] = []
        let firstNonSystemIdx = 0
        for (let i = 0; i < this.history.length; i++) {
            if (this.history[i].role !== 'system') {
                firstNonSystemIdx = i
                break
            }
        }

        let collected = 0
        let i = firstNonSystemIdx
        const removeIndices: number[] = []
        while (collected < messagesToRemove && i < this.history.length) {
            const msg = this.history[i]
            if (msg.role === 'user' || msg.role === 'assistant') {
                tailToDrop.push(msg)
                removeIndices.push(i)
                collected++
            } else if (msg.role === 'tool') {
                // Drop orphaned tool messages alongside their owning turn
                removeIndices.push(i)
            }
            i++
        }

        // Episodic summary before removal
        if (this.enableEpisodicSummary && tailToDrop.length >= 2) {
            try {
                await this.summarizeIntoEpisodicMemory(tailToDrop)
            } catch (err) {
                console.warn('[Agent] episodic summary failed:', err)
            }
        }

        // Remove in reverse to preserve indices
        for (let j = removeIndices.length - 1; j >= 0; j--) {
            this.history.splice(removeIndices[j], 1)
        }
    }

    private async summarizeIntoEpisodicMemory(turns: ChatMessage[]): Promise<void> {
        const transcript = turns
            .map(m => `${m.role === 'user' ? '伙伴' : '昔涟'}：${m.content}`)
            .join('\n')

        const system = `把下面这段对话浓缩成一句客观摘要（≤80字），用于长期记忆。只输出摘要文本，不要前缀。`
        const response = await this.client.sendChat(
            [
                { role: 'system', content: system },
                { role: 'user', content: transcript },
            ],
            { model: this.auxiliaryModel ?? this.model }
        )
        const summary = (response as any)?.choices?.[0]?.message?.content?.trim()
        if (!summary || summary.length === 0) return

        await enqueueStoreMemory({
            content: summary,
            category: 'event',
            subject: 'relationship',
            importance: 5,
            confidence: 7,
            source: 'agent_reflection',
            metadata: { kind: 'episodic_summary', turnCount: turns.length },
        })
    }

    private buildMessagesForAPI(systemPrompt: string): ChatMessage[] {
        const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt }]
        for (const msg of this.history) {
            if (msg.role !== 'system') messages.push(msg)
        }
        return messages
    }

    /**
     * Construct the retrieval query from recent conversation. A short user
     * turn like "为什么？" yields nothing on its own — joining the last 2-3
     * turns gives the retriever real signal.
     */
    private buildRetrievalQuery(latestInput: string): string {
        const recent = this.history
            .filter(m => m.role === 'user' || m.role === 'assistant')
            .slice(-4)
            .map(m => m.content)
            .filter(Boolean)
        return [...recent, latestInput].join(' ')
    }

    async run(userInput: string, options: AgentRunOptions = {}): Promise<AgentRunResult> {
        await this.trimHistory()

        this.lastUserInput = userInput
        const retrievalQuery = this.buildRetrievalQuery(userInput)
        this.history.push({ role: 'user', content: userInput })

        const maxRecursions = options.maxRecursions ?? this.maxRecursions
        let iterations = 0
        let finalContent = ''
        let lastRaw: unknown

        // Hybrid retrieval + optional LLM rerank
        if (this.autoInjectMemories) {
            try {
                const candidates = await hybridSearch(retrievalQuery, {
                    limit: this.maxInjectedMemories * 2,
                })
                if (this.enableRerank && candidates.length > this.maxInjectedMemories) {
                    this.injectedMemories = await rerankWithLLM(retrievalQuery, candidates, {
                        client: this.client,
                        model: this.auxiliaryModel ?? this.model,
                        limit: this.maxInjectedMemories,
                        contextHint: userInput,
                    })
                } else {
                    // Fall back to hybrid + pinned strongest
                    this.injectedMemories = await getRelevantMemories(retrievalQuery, this.maxInjectedMemories)
                }
            } catch (error) {
                console.warn('Failed to get relevant memories:', error)
                this.injectedMemories = []
            }
        } else {
            this.injectedMemories = []
        }

        const systemPrompt = this.buildSystemPrompt(this.injectedMemories)
        const tools = this.getToolDefinitions()

        while (iterations < maxRecursions) {
            const messages = this.buildMessagesForAPI(systemPrompt)

            /* eslint-disable no-await-in-loop */
            const response: any = await this.client.sendChat(messages, {
                model: this.model,
                stream: options.stream,
                tools: tools.length > 0 ? tools : undefined,
            })
            lastRaw = response

            const assistantMessage = response?.choices?.[0]?.message
            if (!assistantMessage) {
                throw new Error('OpenRouter response missing assistant message.')
            }

            const { content, toolCalls, rawToolCalls } = this.normalizeAssistantMessage(assistantMessage)

            if (toolCalls.length > 0) {
                this.history.push({
                    role: 'assistant',
                    content: content || '',
                    tool_calls: rawToolCalls,
                })

                const toolResults = await this.executeToolCalls(toolCalls)

                for (const result of toolResults) {
                    const toolContent =
                        result.message ??
                        (typeof result.output === 'string'
                            ? result.output
                            : JSON.stringify(result.output, null, 2))
                    const toolCallId = result.toolCallId

                    this.history.push({
                        role: 'tool',
                        content: toolContent,
                        name: result.name,
                        toolCallId,
                        tool_call_id: toolCallId,
                    })

                    if (result.memoryEntry) this.addMemory(result.memoryEntry)
                }

                if (content) finalContent = content

                const isAllMemoryTools = toolCalls.every(tc => MEMORY_TOOL_NAMES.has(tc.name))
                if (content && isAllMemoryTools) break
                if (content) break

                iterations += 1
                continue
            }

            if (content) {
                this.history.push({ role: 'assistant', content })
                finalContent = content
            }
            break
        }

        // Fire-and-forget reflection. Errors in here must not affect the user.
        if (this.enableReflection && finalContent) {
            const priorContext = this.history
                .filter(m => m.role === 'user' || m.role === 'assistant')
                .slice(-6, -2)
                .map(m => `${m.role === 'user' ? '伙伴' : '昔涟'}：${m.content}`)
            void reflect(
                {
                    userMessage: userInput,
                    assistantMessage: finalContent,
                    priorContext,
                },
                {
                    client: this.client,
                    model: this.auxiliaryModel ?? this.model,
                }
            ).catch(err => console.warn('[Agent] reflection failed:', err))
        }

        return { content: finalContent, raw: lastRaw }
    }

    private async executeToolCalls(toolCalls: ToolCallRequest[]) {
        const executions = toolCalls.map(async toolCall => {
            const toolCallId = toolCall.id ?? this.generateToolCallId(toolCall.name)
            const tool = this.toolRegistry.get(toolCall.name)

            if (!tool) {
                return {
                    name: toolCall.name,
                    output: { success: false, error: `Tool "${toolCall.name}" not registered` },
                    message: `Tool "${toolCall.name}" not registered`,
                    toolCallId,
                } satisfies ToolResult
            }

            try {
                const output = await tool.execute(toolCall.arguments, {
                    addMemory: entry => this.addMemory(entry),
                    memory: this.memory,
                })
                const normalizedOutput = typeof output.output === 'object' && output.output !== null
                    ? { success: true, ...output.output }
                    : { success: true, result: output.output }
                return {
                    ...output,
                    output: normalizedOutput,
                    name: output.name ?? toolCall.name,
                    toolCallId: output.toolCallId ?? toolCallId,
                }
            } catch (error) {
                return {
                    name: toolCall.name,
                    output: { success: false, error: error instanceof Error ? error.message : 'Unknown tool error' },
                    message: error instanceof Error ? error.message : 'Unknown tool error',
                    toolCallId,
                } satisfies ToolResult
            }
        })

        return Promise.all(executions)
    }

    private generateToolCallId(seed: string) {
        const random = Math.random().toString(36).slice(2, 8)
        return `${seed || 'tool'}_${Date.now().toString(36)}_${random}`
    }

    private normalizeAssistantMessage(message: any): {
        content: string
        toolCalls: ToolCallRequest[]
        rawToolCalls: OpenRouterToolCall[]
    } {
        const content = Array.isArray(message.content)
            ? message.content.map((chunk: any) => chunk?.text ?? '').join('\n').trim()
            : (message.content ?? '')

        const rawToolCalls: OpenRouterToolCall[] = message.tool_calls ?? message.toolCalls ?? []

        const toolCalls: ToolCallRequest[] = rawToolCalls.map(toolCall => {
            let parsedArgs: Record<string, unknown> = {}
            try {
                parsedArgs = toolCall.function.arguments ? JSON.parse(toolCall.function.arguments) : {}
            } catch (error) {
                parsedArgs = {
                    error: 'Failed to parse tool arguments',
                    raw: toolCall.function.arguments,
                }
            }
            return { id: toolCall.id, name: toolCall.function.name, arguments: parsedArgs }
        })

        return { content, toolCalls, rawToolCalls }
    }

    getInjectedMemories(): ReadonlyArray<StoredMemory> {
        return this.injectedMemories
    }

    async getMemoryStats(): Promise<{ count: number; categories: Record<string, number> }> {
        const count = await memoryStore.getCount()
        const categories: Record<string, number> = {}
        for (const cat of ['fact', 'preference', 'event', 'correction', 'context'] as const) {
            const catMemories = await memoryStore.getByCategory(cat, 1000)
            categories[cat] = catMemories.length
        }
        return { count, categories }
    }
}
