import { consumeChatStream } from './chat-stream'
import type { ChatMessage } from './openrouter'
import { OpenRouterClient } from './openrouter'
import { memoryStore, type StoredMemory } from './memory-store'
import { enqueueStoreMemory, formatMemoriesForPrompt, getRelevantMemories, memoryTools } from './memory-tools'
import { hybridSearch, rerankWithLLM } from './memory-search'
import { reflect, type ExtractedFollowUp } from './reflection'

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
    initialHistory?: ChatMessage[]
    /** Receives follow-ups found by the reflection pass. */
    onFollowUps?: (items: ExtractedFollowUp[]) => void
}

type AgentRunOptions = {
    maxRecursions?: number
    stream?: boolean
    onDelta?: (text: string) => void
    signal?: AbortSignal
    interactionContext?: string
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
    private readonly onFollowUps?: (items: ExtractedFollowUp[]) => void
    private readonly toolRegistry = new Map<string, Tool>()
    private readonly history: ChatMessage[] = []
    private readonly memory: MemoryEntry[] = []
    private injectedMemories: StoredMemory[] = []

    constructor(options: AgentOptions) {
        this.baseSystemPrompt = options.systemPrompt
        this.model = options.model
        this.onFollowUps = options.onFollowUps
        this.maxRecursions = options.maxRecursions ?? 3
        this.maxContextMessages = options.maxContextMessages ?? 20
        this.autoInjectMemories = options.autoInjectMemories ?? true
        this.maxInjectedMemories = options.maxInjectedMemories ?? 5
        this.enableRerank = options.enableRerank ?? true
        this.enableReflection = options.enableReflection ?? true
        this.enableEpisodicSummary = options.enableEpisodicSummary ?? true
        this.auxiliaryModel = options.auxiliaryModel
        this.client = options.client ?? new OpenRouterClient({ model: options.model })
        this.history.push(...(options.initialHistory ?? []).map(message => ({ ...message })))

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
        // A turn starts at a user message and includes every tool round and
        // the final answer. Never split a tool call from its result.
        const turnStarts = this.history.flatMap((message, index) =>
            message.role === 'user' ? [index] : []
        )
        const keepTurns = Math.max(0, Math.floor(this.maxContextMessages))
        if (turnStarts.length <= keepTurns) return
        const cutIndex = turnStarts[turnStarts.length - keepTurns] ?? this.history.length
        const tailToDrop = this.history.slice(0, cutIndex)
            .filter(message => message.role === 'user' || message.role === 'assistant')

        // Episodic summary before removal
        if (this.enableEpisodicSummary && tailToDrop.length >= 2) {
            try {
                await this.summarizeIntoEpisodicMemory(tailToDrop)
            } catch (err) {
                console.warn('[Agent] episodic summary failed:', err)
            }
        }

        this.history.splice(0, cutIndex)
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
        options.signal?.throwIfAborted()
        await this.trimHistory()
        options.signal?.throwIfAborted()

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

        options.signal?.throwIfAborted()
        const systemPrompt = this.buildSystemPrompt(this.injectedMemories) +
            (options.interactionContext ? `\n【本次交互状态】\n${options.interactionContext}` : '')
        const tools = this.getToolDefinitions()

        // Tools run before the public answer: speech cannot retract a tool preamble.
        // The explicit finish tool lets planning stop without generating an unused answer.
        const responseTool = {
            type: 'function', function: { name: 'begin_response',
                description: '信息已经足够，开始给伙伴回复。不需要查询或记忆操作时立即选择此工具，不要生成回复正文。',
                parameters: { type: 'object', properties: {}, additionalProperties: false } },
        }
        while (iterations < maxRecursions && (!options.stream || tools.length > 0)) {
            options.signal?.throwIfAborted()
            const messages = this.buildMessagesForAPI(systemPrompt + (options.stream
                ? '\n当前仅决定必要的工具操作，不输出面向伙伴的正文。已有信息足够时调用 begin_response。不要为了调用工具而查询；日常问候直接 begin_response。'
                : ''))

            /* eslint-disable no-await-in-loop */
            const response: any = await this.client.sendChat(messages, {
                model: this.model,
                stream: false,
                tools: options.stream ? [...tools, responseTool] : tools.length > 0 ? tools : undefined,
                toolChoice: options.stream ? 'required' : undefined,
                signal: options.signal,
            })
            options.signal?.throwIfAborted()
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

                const finishCalls = options.stream ? toolCalls.filter(call => call.name === 'begin_response') : []
                const toolResults = await this.executeToolCalls(toolCalls.filter(call => !finishCalls.includes(call)))
                for (const call of finishCalls) toolResults.push({ name: call.name, toolCallId: call.id, output: { ready: true } })
                options.signal?.throwIfAborted()

                for (const result of toolResults) {
                    // The model needs the actual data, not just the UI summary.
                    const toolContent = typeof result.output === 'string'
                        ? result.output
                        : JSON.stringify(result.output ?? { message: result.message ?? '' })
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

                iterations += 1
                if (finishCalls.length) break
                continue
            }

            if (options.stream) break // A provider ignoring tool_choice must not leak its planning prose.
            if (content) {
                this.history.push({ role: 'assistant', content })
                finalContent = content
            }
            break
        }

        if (options.stream) {
            options.signal?.throwIfAborted()
            const response = await this.client.sendChat(this.buildMessagesForAPI(systemPrompt +
                '\n现在只输出面向伙伴的最终回答。首个短语自然简短；不要输出工具操作或内部思考。'), {
                model: this.model, stream: true, signal: options.signal,
            })
            finalContent = await consumeChatStream(response, options.onDelta, options.signal)
            lastRaw = undefined // Do not retain a consumed stream and its network resources.
            if (finalContent) this.history.push({ role: 'assistant', content: finalContent })
        }

        // Exhausting the tool budget (or an empty model response) must still
        // end the turn with a visible answer, never a tool preamble or silence.
        if (!finalContent) {
            finalContent = '抱歉，刚才没能把这件事处理好。我们再试一次，好吗？'
            this.history.push({ role: 'assistant', content: finalContent })
            if (options.stream) options.onDelta?.(finalContent)
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
                    onFollowUps: this.onFollowUps,
                }
            ).catch(err => console.warn('[Agent] reflection failed:', err))
        }

        return { content: finalContent, raw: lastRaw }
    }

    private async executeToolCalls(toolCalls: ToolCallRequest[]): Promise<ToolResult[]> {
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
