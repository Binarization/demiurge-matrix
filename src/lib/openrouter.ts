import { OpenRouter } from '@openrouter/sdk'
import { loadStoredOpenRouterConfig, type StoredOpenRouterConfig } from './openrouter-config'

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool'

export type ChatMessage = {
    role: ChatRole
    content: string
    name?: string
    toolCallId?: string
    tool_call_id?: string  // Some SDKs expect snake_case directly
    tool_calls?: Array<{
        id: string
        type: 'function'
        function: {
            name: string
            arguments: string
        }
    }>
}

type OpenRouterMessage = {
    role: 'system' | 'user' | 'assistant' | 'tool'
    content?: string | null
    name?: string
    toolCallId?: string
    toolCalls?: Array<{
        id: string
        type: 'function'
        function: {
            name: string
            arguments: string
        }
    }>
}

type OpenRouterClientOptions = {
    apiKey?: string
    model?: string
    headers?: Record<string, string>
    storedConfig?: StoredOpenRouterConfig | null
}

export class OpenRouterClient {
    private client: OpenRouter
    private model: string
    private readonly defaultHeaders: Record<string, string>

    constructor(options: OpenRouterClientOptions = {}) {
        const storedConfig = options.storedConfig ?? loadStoredOpenRouterConfig()
        const apiKey = options.apiKey ?? storedConfig?.apiKey
        if (!apiKey) {
            throw new Error(
                'OpenRouter API key is missing. Save it in settings or pass apiKey to OpenRouterClient.'
            )
        }

        this.client = new OpenRouter({
            apiKey,
        })
        this.model = options.model ?? storedConfig?.model ?? 'openai/gpt-4o'
        this.defaultHeaders = {
            'X-Title': 'DEMIURGE-MATRIX',
            ...options.headers,
        }
    }

    async sendChat(
        messages: ChatMessage[],
        options?: {
            model?: string
            stream?: boolean
            headers?: Record<string, string>
            tools?: any[]
            toolChoice?: 'auto' | 'required' | 'none'
            signal?: AbortSignal
        }
    ): Promise<any> {
        const headers = { ...this.defaultHeaders, ...options?.headers }
        const requestBody: any = {
            model: options?.model ?? this.model,
            messages: this.toOpenRouterMessages(messages) as any,
            stream: options?.stream ?? false,
        }

        // Add tools if provided
        if (options?.tools && options.tools.length > 0) {
            requestBody.tools = options.tools
            if (options.toolChoice) requestBody.toolChoice = options.toolChoice
        }

        return this.client.chat.send(requestBody, { headers, signal: options?.signal })
    }

    private toOpenRouterMessages(messages: ChatMessage[]): OpenRouterMessage[] {
        return messages.map(message => {
            switch (message.role) {
                case 'system':
                    return { role: 'system', content: message.content }
                case 'user':
                    return { role: 'user', content: message.content, name: message.name }
                case 'assistant':
                    // The SDK serializes camelCase to the API's snake_case.
                    const assistantMsg: OpenRouterMessage = {
                        role: 'assistant',
                        content: message.content || null,
                        name: message.name
                    }
                    if (message.tool_calls && message.tool_calls.length > 0) {
                        assistantMsg.toolCalls = message.tool_calls
                    }
                    return assistantMsg
                case 'tool': {
                    const tid = message.toolCallId ?? message.tool_call_id
                    if (!tid) {
                        throw new Error(
                            'Tool messages require a toolCallId for OpenRouter compatibility.'
                        )
                    }
                    return {
                        role: 'tool',
                        content: message.content,
                        toolCallId: tid,
                    }
                }
                default:
                    return { role: 'system', content: message.content }
            }
        })
    }
}
