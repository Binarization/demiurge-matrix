import type { ChatMessage } from './openrouter'
import { OpenRouterClient } from './openrouter'
import { memoryStore, type StoredMemory } from './memory-store'
import { formatMemoriesForPrompt, getRelevantMemories, memoryTools } from './memory-tools'

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
    maxContextMessages?: number // Maximum conversation turns to keep (default: 20)
    enableMemoryTools?: boolean // Whether to enable built-in memory tools (default: true)
    autoInjectMemories?: boolean // Whether to auto-inject relevant memories (default: true)
    maxInjectedMemories?: number // Maximum memories to inject per request (default: 5)
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

export class Agent {
    private readonly baseSystemPrompt: string
    private readonly model?: string
    private readonly client: OpenRouterClient
    private readonly maxRecursions: number
    private readonly maxContextMessages: number
    private readonly autoInjectMemories: boolean
    private readonly maxInjectedMemories: number
    private readonly toolRegistry = new Map<string, Tool>()
    private readonly history: ChatMessage[] = []
    private readonly memory: MemoryEntry[] = []
    private injectedMemories: StoredMemory[] = []

    constructor(options: AgentOptions) {
        this.baseSystemPrompt = options.systemPrompt
        this.model = options.model
        this.maxRecursions = options.maxRecursions ?? 3
        this.maxContextMessages = options.maxContextMessages ?? 20
        this.autoInjectMemories = options.autoInjectMemories ?? true
        this.maxInjectedMemories = options.maxInjectedMemories ?? 5
        this.client = options.client ?? new OpenRouterClient({ model: options.model })

        // Register user-provided tools
        options.tools?.forEach(tool => {
            this.registerTool(tool)
        })

        // Register memory tools if enabled (default: true)
        if (options.enableMemoryTools !== false) {
            memoryTools.forEach(tool => {
                if (!this.toolRegistry.has(tool.name)) {
                    this.registerTool(tool)
                }
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
     * Build the system prompt with injected memories
     */
    private buildSystemPrompt(injectedMemories: StoredMemory[]): string {
        const memorySection = formatMemoriesForPrompt(injectedMemories)

        // Add memory tool instructions
        const memoryInstructions = `
【记忆管理 - 主动维护】
你拥有长期记忆能力，必须主动使用！不仅要存储，还要删除和更新。

可用工具：
- store_memory: 存储新信息 | forget_memory: 删除记忆 | update_memory: 更新记忆
- recall_memory: 搜索记忆 | list_memories: 列出记忆 | cleanup_memories: 批量清理

⚡ 立即存储：
• 名字、身份、职业 → fact (9-10) | 喜好、偏好 → preference (7-8)
• 重要人物、宠物 → fact (8) | 经历、故事 → event (6-8)
• 目标、计划 → fact (7-8) | 习惯、作息 → preference (6-7)

🗑️ 立即删除（forget_memory）：
• 用户说"不对/错了/我改变想法了" → 删除旧记忆
• 发现矛盾信息 → 删除错误的那条
• 用户明确要求忘记某事 → 立即删除
• 过时的信息（如：旧地址、前任工作）→ 删除

🔄 立即更新（update_memory）：
• 用户更正信息 → 更新而不是新建
• 偏好变化（"我现在喜欢X了"）→ 更新原记忆
• 重要性变化 → 调整 importance 值

🧹 定期清理（cleanup_memories）：
• 记忆数量多时主动清理重复和低价值记忆
• 可以先用 dryRun: true 预览

🚫 不需要记忆：闲聊、问候、临时话题、已存在的记忆

重要性：10=核心身份 | 8-9=重要 | 6-7=一般 | 4-5=背景 | 1-3=临时
`

        return this.baseSystemPrompt + memoryInstructions + memorySection
    }

    /**
     * Get tool definitions for OpenRouter API
     */
    private getToolDefinitions(): OpenRouterToolDefinition[] {
        const definitions: OpenRouterToolDefinition[] = []

        for (const [_, tool] of this.toolRegistry) {
            const properties: Record<string, unknown> = {}
            const required: string[] = []

            // Memory tools have specific parameter schemas
            if (tool.name === 'store_memory') {
                properties.content = { type: 'string', description: 'The information to remember' }
                properties.category = {
                    type: 'string',
                    enum: ['fact', 'preference', 'event', 'correction', 'context'],
                    description: 'Category of the memory',
                }
                properties.importance = {
                    type: 'number',
                    description: 'Importance level 1-10',
                }
                properties.reason = { type: 'string', description: 'Why this is worth remembering' }
                required.push('content', 'category')
            } else if (tool.name === 'recall_memory') {
                properties.query = { type: 'string', description: 'Search query for memories' }
                properties.limit = { type: 'number', description: 'Maximum results to return' }
                properties.category = {
                    type: 'string',
                    enum: ['fact', 'preference', 'event', 'correction', 'context'],
                    description: 'Filter by category',
                }
                required.push('query')
            } else if (tool.name === 'forget_memory') {
                properties.memoryId = { type: 'string', description: 'ID of the memory to forget' }
                properties.reason = { type: 'string', description: 'Why this should be forgotten' }
                required.push('memoryId')
            } else if (tool.name === 'update_memory') {
                properties.memoryId = { type: 'string', description: 'ID of the memory to update' }
                properties.content = { type: 'string', description: 'New content for the memory' }
                properties.importance = { type: 'number', description: 'New importance level' }
                properties.reason = { type: 'string', description: 'Why this update is needed' }
                required.push('memoryId')
            } else if (tool.name === 'list_memories') {
                properties.category = {
                    type: 'string',
                    enum: ['fact', 'preference', 'event', 'correction', 'context'],
                    description: 'Filter by category',
                }
                properties.sortBy = {
                    type: 'string',
                    enum: ['recent', 'important'],
                    description: 'Sort order',
                }
                properties.limit = { type: 'number', description: 'Maximum results' }
            } else if (tool.name === 'cleanup_memories') {
                properties.strategy = {
                    type: 'string',
                    enum: ['duplicates', 'outdated', 'low_importance', 'all'],
                    description: 'Cleanup strategy: duplicates, outdated, low_importance, or all',
                }
                properties.dryRun = {
                    type: 'boolean',
                    description: 'If true, only report what would be cleaned without removing',
                }
            } else if (tool.parameters) {
                // Use custom parameters if defined
                for (const [key, param] of Object.entries(tool.parameters)) {
                    properties[key] = {
                        type: param.type,
                        description: param.description,
                        ...(param.enum ? { enum: param.enum } : {}),
                    }
                    if (param.required) {
                        required.push(key)
                    }
                }
            }

            definitions.push({
                type: 'function',
                function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: {
                        type: 'object',
                        properties,
                        required,
                    },
                },
            })
        }

        return definitions
    }

    /**
     * Trim history to respect context window limit
     * Keeps the system message and most recent messages
     */
    private trimHistory(): void {
        // Count user/assistant message pairs (excluding system and tool messages)
        const conversationMessages = this.history.filter(
            m => m.role === 'user' || m.role === 'assistant'
        )

        // Each "turn" is a user message + assistant response
        const turns = Math.floor(conversationMessages.length / 2)

        if (turns <= this.maxContextMessages) {
            return // No trimming needed
        }

        // Find how many messages to remove
        const messagesToRemove = (turns - this.maxContextMessages) * 2

        // Find the first non-system message index
        let firstNonSystemIdx = 0
        for (let i = 0; i < this.history.length; i++) {
            if (this.history[i].role !== 'system') {
                firstNonSystemIdx = i
                break
            }
        }

        // Remove old messages (keep system prompt)
        let removed = 0
        let i = firstNonSystemIdx
        while (removed < messagesToRemove && i < this.history.length) {
            const msg = this.history[i]
            if (msg.role === 'user' || msg.role === 'assistant') {
                this.history.splice(i, 1)
                removed++
            } else if (msg.role === 'tool') {
                // Also remove orphaned tool messages
                this.history.splice(i, 1)
            } else {
                i++
            }
        }
    }

    /**
     * Build messages for API call, including system prompt with memories
     */
    private buildMessagesForAPI(systemPrompt: string): ChatMessage[] {
        // Start with the dynamic system prompt
        const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt }]

        // Add conversation history (excluding the original system message)
        for (const msg of this.history) {
            if (msg.role !== 'system') {
                messages.push(msg)
            }
        }

        return messages
    }

    async run(userInput: string, options: AgentRunOptions = {}): Promise<AgentRunResult> {
        // Trim history before adding new message
        this.trimHistory()

        this.history.push({ role: 'user', content: userInput })

        const maxRecursions = options.maxRecursions ?? this.maxRecursions
        let iterations = 0
        let finalContent = ''
        let lastRaw: unknown

        // Get relevant memories for this context
        if (this.autoInjectMemories) {
            try {
                this.injectedMemories = await getRelevantMemories(
                    userInput,
                    this.maxInjectedMemories
                )
            } catch (error) {
                console.warn('Failed to get relevant memories:', error)
                this.injectedMemories = []
            }
        }

        // Build system prompt with memories
        const systemPrompt = this.buildSystemPrompt(this.injectedMemories)

        // Get tool definitions
        const tools = this.getToolDefinitions()

        // Debug: log tool definitions
        if (tools.length > 0) {
            console.log('[Agent] Tools registered:', tools.map(t => t.function.name))
        }

        while (iterations < maxRecursions) {
            const messages = this.buildMessagesForAPI(systemPrompt)

            // Debug: log message count
            console.log('[Agent] Iteration', iterations, '- Sending', messages.length, 'messages')

            /* eslint-disable no-await-in-loop */
            const response: any = await this.client.sendChat(messages, {
                model: this.model,
                stream: options.stream,
                tools: tools.length > 0 ? tools : undefined,
            })
            lastRaw = response

            // Debug: log raw response details
            const finishReason = response?.choices?.[0]?.finish_reason
            console.log('[Agent] Response finish_reason:', finishReason)

            const assistantMessage = response?.choices?.[0]?.message
            if (!assistantMessage) {
                throw new Error('OpenRouter response missing assistant message.')
            }

            // Debug: log raw assistant message
            console.log('[Agent] Assistant message:', {
                hasContent: !!assistantMessage.content,
                contentLength: assistantMessage.content?.length ?? 0,
                hasToolCalls: !!assistantMessage.tool_calls,
                toolCallsCount: assistantMessage.tool_calls?.length ?? 0,
                rawMessage: JSON.stringify(assistantMessage),
            })

            const { content, toolCalls, rawToolCalls } = this.normalizeAssistantMessage(assistantMessage)

            // Debug: log tool calls
            if (toolCalls.length > 0) {
                console.log('[Agent] Tool calls requested:', toolCalls.map(t => ({ name: t.name, id: t.id })))
            }

            // Execute any tool calls
            if (toolCalls.length > 0) {
                // Always add assistant message with tool_calls to history first
                this.history.push({
                    role: 'assistant',
                    content: content || '',
                    tool_calls: rawToolCalls,
                })

                // Execute tools
                const toolResults = await this.executeToolCalls(toolCalls)

                // Debug: log tool results
                console.log('[Agent] Tool results:', toolResults.map(r => ({ name: r.name, success: (r.output as any)?.success })))

                // Always add tool results to history
                for (const result of toolResults) {
                    const toolContent =
                        result.message ??
                        (typeof result.output === 'string'
                            ? result.output
                            : JSON.stringify(result.output, null, 2))
                    const toolCallId = result.toolCallId

                    console.log('[Agent] Adding tool result to history:', { name: result.name, toolCallId })

                    this.history.push({
                        role: 'tool',
                        content: toolContent,
                        name: result.name,
                        toolCallId,
                        tool_call_id: toolCallId,  // SDK may expect snake_case
                    })

                    if (result.memoryEntry) {
                        this.addMemory(result.memoryEntry)
                    }
                }

                // If we have content, use it as the response
                if (content) {
                    finalContent = content
                }

                // Check if all tool calls are memory-related (fire-and-forget)
                const isAllMemoryTools = toolCalls.every(tc =>
                    ['store_memory', 'recall_memory', 'forget_memory', 'update_memory', 'list_memories', 'cleanup_memories'].includes(tc.name)
                )

                // If we have content and all tools are memory tools, we're done
                if (content && isAllMemoryTools) {
                    console.log('[Agent] Content received with memory tools - done')
                    break
                }

                // If we have content already, we're done (tools were side effects)
                if (content) {
                    console.log('[Agent] Content already received, tools executed as side effects - done')
                    break
                }

                // No content - continue loop to get model's response after tool execution
                iterations += 1
                console.log('[Agent] No content yet, continuing to iteration', iterations)
                continue
            }

            // No tool calls - just add assistant content to history
            if (content) {
                this.history.push({ role: 'assistant', content })
                finalContent = content
            }

            // No tool calls and no content - unusual, but break to avoid infinite loop
            if (!content) {
                console.log('[Agent] No content and no tool calls - breaking')
            }
            break
        }

        return {
            content: finalContent,
            raw: lastRaw,
        }
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
                // Ensure output always has success field
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
            ? message.content
                  .map((chunk: any) => chunk?.text ?? '')
                  .join('\n')
                  .trim()
            : (message.content ?? '')

        // OpenRouter SDK might use either tool_calls or toolCalls
        const rawToolCalls: OpenRouterToolCall[] = message.tool_calls ?? message.toolCalls ?? []

        console.log('[Agent] normalizeAssistantMessage - tool_calls:', message.tool_calls, 'toolCalls:', message.toolCalls, 'result:', rawToolCalls)

        const toolCalls: ToolCallRequest[] = rawToolCalls.map(toolCall => {
            let parsedArgs: Record<string, unknown> = {}
            try {
                parsedArgs = toolCall.function.arguments
                    ? JSON.parse(toolCall.function.arguments)
                    : {}
            } catch (error) {
                parsedArgs = {
                    error: 'Failed to parse tool arguments',
                    raw: toolCall.function.arguments,
                }
            }
            return {
                id: toolCall.id,
                name: toolCall.function.name,
                arguments: parsedArgs,
            }
        })

        return { content, toolCalls, rawToolCalls }
    }

    /**
     * Get the current injected memories
     */
    getInjectedMemories(): ReadonlyArray<StoredMemory> {
        return this.injectedMemories
    }

    /**
     * Get memory statistics
     */
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
