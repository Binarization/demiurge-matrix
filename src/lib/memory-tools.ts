/**
 * Memory Tools for Agent
 *
 * These tools allow the agent to:
 * - Store important information for long-term recall
 * - Search and recall relevant memories
 * - Forget/invalidate incorrect or outdated memories
 * - Update existing memories with corrections
 */

import type { Tool, ToolResult } from './agent'
import { memoryStore, type MemoryCategory, type StoredMemory } from './memory-store'
import { OpenRouterClient } from './openrouter'
import { loadStoredOpenRouterConfig } from './openrouter-config'

type StoreMemoryArgs = {
    content: string
    category: MemoryCategory
    importance?: number
    reason?: string
}

type RecallMemoryArgs = {
    query: string
    limit?: number
    category?: MemoryCategory
}

type ForgetMemoryArgs = {
    memoryId: string
    reason?: string
}

type UpdateMemoryArgs = {
    memoryId: string
    content?: string
    importance?: number
    reason?: string
}

type ListMemoriesArgs = {
    category?: MemoryCategory
    sortBy?: 'recent' | 'important'
    limit?: number
}

/**
 * Expand a search query into related Chinese terms using LLM (token-efficient)
 * Returns additional keywords to search for
 */
async function expandSearchQuery(query: string): Promise<string[]> {
    try {
        const config = loadStoredOpenRouterConfig()
        if (!config?.apiKey) return []

        const client = new OpenRouterClient({
            apiKey: config.apiKey,
            model: config.model,
        })

        const response = await client.sendChat([
            {
                role: 'system',
                content: `输出1-3个相关中文关键词用于记忆搜索。格式：词1,词2
只输出逗号分隔的中文词，不要解释。`,
            },
            {
                role: 'user',
                content: query,
            },
        ])

        const result = response?.choices?.[0]?.message?.content?.trim()
        if (!result) return []

        // Parse comma-separated keywords, only keep Chinese words
        return result
            .split(/[,，、\s]+/)
            .map((k: string) => k.trim())
            .filter((k: string) => k.length >= 1 && k.length <= 10 && /[\u4e00-\u9fa5]/.test(k))
            .slice(0, 3)
    } catch (error) {
        console.warn('Failed to expand search query:', error)
        return []
    }
}

/**
 * Tool for storing new memories
 */
export const storeMemoryTool: Tool = {
    name: 'store_memory',
    description: `Store important information to long-term memory for future recall. Use this when:
- Learning a new fact about the user (name, preferences, experiences)
- Recording a significant event or decision
- Noting something the user explicitly wants you to remember
- Correcting a previous misunderstanding

Parameters:
- content: The information to remember (be specific and clear)
- category: One of 'fact', 'preference', 'event', 'correction', 'context'
- importance: 1-10 scale (10 = critical to remember, 1 = minor detail)
- reason: Why this is worth remembering`,

    execute: async (args: unknown): Promise<ToolResult> => {
        const { content, category, importance = 5, reason } = args as StoreMemoryArgs

        if (!content || !category) {
            return {
                name: 'store_memory',
                output: { success: false, error: 'Missing required parameters: content and category' },
                message: '记忆存储失败：缺少必要参数。',
            }
        }

        const validCategories: MemoryCategory[] = ['fact', 'preference', 'event', 'correction', 'context']
        if (!validCategories.includes(category)) {
            return {
                name: 'store_memory',
                output: { success: false, error: `Invalid category. Must be one of: ${validCategories.join(', ')}` },
                message: '记忆存储失败：无效的分类。',
            }
        }

        try {
            const memory = await memoryStore.store(content, category, importance, { reason })

            return {
                name: 'store_memory',
                output: {
                    success: true,
                    memoryId: memory.id,
                    category: memory.category,
                    importance: memory.importance,
                },
                message: `已记住：${content.slice(0, 50)}${content.length > 50 ? '...' : ''}`,
            }
        } catch (error) {
            return {
                name: 'store_memory',
                output: { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
                message: '记忆存储失败。',
            }
        }
    },
}

/**
 * Tool for recalling memories based on search query
 */
export const recallMemoryTool: Tool = {
    name: 'recall_memory',
    description: `Search long-term memory for relevant information. Use this when:
- The user asks about something you might have discussed before
- You need to remember user preferences or past events
- Looking up previously stored facts or context
- Checking if you have relevant background information

Parameters:
- query: What to search for (keywords or natural language)
- limit: Maximum number of memories to return (default: 5)
- category: Optional filter by category`,

    execute: async (args: unknown): Promise<ToolResult> => {
        const { query, limit = 5, category } = args as RecallMemoryArgs

        if (!query) {
            return {
                name: 'recall_memory',
                output: { success: false, error: 'Missing required parameter: query' },
                message: '记忆检索失败：缺少搜索关键词。',
            }
        }

        try {
            let memories: StoredMemory[]

            if (category) {
                // Search within a specific category
                const categoryMemories = await memoryStore.getByCategory(category, 50)
                // Filter by query relevance
                const queryLower = query.toLowerCase()
                memories = categoryMemories
                    .filter(m => m.content.toLowerCase().includes(queryLower))
                    .slice(0, limit)
            } else {
                // Full-text search across all memories
                const results = await memoryStore.search(query, limit)
                memories = results
            }

            // Record access for retrieved memories
            await Promise.all(memories.map(m => memoryStore.recordAccess(m.id)))

            if (memories.length === 0) {
                return {
                    name: 'recall_memory',
                    output: { success: true, memories: [], count: 0 },
                    message: '没有找到相关记忆。',
                }
            }

            const formattedMemories = memories.map(m => ({
                id: m.id,
                content: m.content,
                category: m.category,
                importance: m.importance,
                createdAt: new Date(m.createdAt).toISOString(),
            }))

            return {
                name: 'recall_memory',
                output: {
                    success: true,
                    memories: formattedMemories,
                    count: memories.length,
                },
                message: `找到 ${memories.length} 条相关记忆。`,
            }
        } catch (error) {
            return {
                name: 'recall_memory',
                output: { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
                message: '记忆检索失败。',
            }
        }
    },
}

/**
 * Tool for forgetting/invalidating memories
 */
export const forgetMemoryTool: Tool = {
    name: 'forget_memory',
    description: `Mark a memory as invalid/forgotten. Use this when:
- A previously stored fact turns out to be incorrect
- The user corrects misinformation you remembered
- Information becomes outdated or irrelevant
- The user explicitly asks you to forget something

Parameters:
- memoryId: The ID of the memory to forget
- reason: Why this memory should be forgotten`,

    execute: async (args: unknown): Promise<ToolResult> => {
        const { memoryId, reason } = args as ForgetMemoryArgs

        if (!memoryId) {
            return {
                name: 'forget_memory',
                output: { success: false, error: 'Missing required parameter: memoryId' },
                message: '遗忘操作失败：缺少记忆ID。',
            }
        }

        try {
            // First check if memory exists
            const memory = await memoryStore.getById(memoryId)
            if (!memory) {
                return {
                    name: 'forget_memory',
                    output: { success: false, error: 'Memory not found' },
                    message: '找不到该记忆。',
                }
            }

            // Invalidate the memory
            await memoryStore.invalidate(memoryId)

            // If there's a reason, store it as a correction
            if (reason) {
                await memoryStore.store(
                    `[已遗忘] ${memory.content} - 原因: ${reason}`,
                    'correction',
                    3,
                    { originalMemoryId: memoryId }
                )
            }

            return {
                name: 'forget_memory',
                output: { success: true, memoryId, forgotten: memory.content.slice(0, 50) },
                message: `已遗忘该记忆。`,
            }
        } catch (error) {
            return {
                name: 'forget_memory',
                output: { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
                message: '遗忘操作失败。',
            }
        }
    },
}

/**
 * Tool for updating existing memories
 */
export const updateMemoryTool: Tool = {
    name: 'update_memory',
    description: `Update an existing memory with new information. Use this when:
- Need to correct or refine a previously stored fact
- Adjusting the importance of a memory
- Adding more detail to an existing memory

Parameters:
- memoryId: The ID of the memory to update
- content: New content (optional, replaces old content)
- importance: New importance level 1-10 (optional)
- reason: Why this update is being made`,

    execute: async (args: unknown): Promise<ToolResult> => {
        const { memoryId, content, importance, reason } = args as UpdateMemoryArgs

        if (!memoryId) {
            return {
                name: 'update_memory',
                output: { success: false, error: 'Missing required parameter: memoryId' },
                message: '更新操作失败：缺少记忆ID。',
            }
        }

        if (!content && importance === undefined) {
            return {
                name: 'update_memory',
                output: { success: false, error: 'Must provide content or importance to update' },
                message: '更新操作失败：没有提供更新内容。',
            }
        }

        try {
            const updates: Partial<Pick<StoredMemory, 'content' | 'importance'>> = {}
            if (content) updates.content = content
            if (importance !== undefined) updates.importance = importance

            const updated = await memoryStore.update(memoryId, updates)

            if (!updated) {
                return {
                    name: 'update_memory',
                    output: { success: false, error: 'Memory not found' },
                    message: '找不到该记忆。',
                }
            }

            return {
                name: 'update_memory',
                output: {
                    success: true,
                    memoryId,
                    content: updated.content.slice(0, 50),
                    importance: updated.importance,
                },
                message: `记忆已更新。`,
            }
        } catch (error) {
            return {
                name: 'update_memory',
                output: { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
                message: '更新操作失败。',
            }
        }
    },
}

/**
 * Tool for listing memories
 */
export const listMemoriesTool: Tool = {
    name: 'list_memories',
    description: `List stored memories. Use this when:
- Need to review what you remember about the user
- Looking for memories to potentially update or forget
- Getting an overview of stored information

Parameters:
- category: Filter by category (optional)
- sortBy: 'recent' or 'important' (default: 'recent')
- limit: Maximum number of memories to return (default: 10)`,

    execute: async (args: unknown): Promise<ToolResult> => {
        const { category, sortBy = 'recent', limit = 10 } = args as ListMemoriesArgs

        try {
            let memories: StoredMemory[]

            if (category) {
                memories = await memoryStore.getByCategory(category, limit)
            } else if (sortBy === 'important') {
                memories = await memoryStore.getMostImportant(limit)
            } else {
                memories = await memoryStore.getRecent(limit)
            }

            const totalCount = await memoryStore.getCount()

            const formattedMemories = memories.map(m => ({
                id: m.id,
                content: m.content.slice(0, 100) + (m.content.length > 100 ? '...' : ''),
                category: m.category,
                importance: m.importance,
                createdAt: new Date(m.createdAt).toISOString(),
            }))

            return {
                name: 'list_memories',
                output: {
                    success: true,
                    memories: formattedMemories,
                    count: memories.length,
                    totalCount,
                },
                message: `共有 ${totalCount} 条记忆，显示 ${memories.length} 条。`,
            }
        } catch (error) {
            return {
                name: 'list_memories',
                output: { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
                message: '列出记忆失败。',
            }
        }
    },
}

type CleanupMemoriesArgs = {
    strategy?: 'duplicates' | 'outdated' | 'low_importance' | 'all'
    dryRun?: boolean
}

/**
 * Tool for cleaning up redundant or outdated memories
 */
export const cleanupMemoriesTool: Tool = {
    name: 'cleanup_memories',
    description: `Analyze and clean up redundant, outdated, or low-value memories. Use this when:
- You notice duplicate or very similar memories
- Some memories seem outdated or no longer relevant
- Memory count is getting high and needs pruning
- User asks to organize or clean up memories

Parameters:
- strategy: 'duplicates' (similar content), 'outdated' (old + low access), 'low_importance' (importance <= 3), 'all' (comprehensive)
- dryRun: If true, only report what would be cleaned without actually removing`,

    execute: async (args: unknown): Promise<ToolResult> => {
        const { strategy = 'all', dryRun = false } = args as CleanupMemoriesArgs

        try {
            const allMemories = await memoryStore.getRecent(100)
            const toRemove: { id: string; reason: string; content: string }[] = []

            // 1. Find duplicates (similar content)
            if (strategy === 'duplicates' || strategy === 'all') {
                const contentMap = new Map<string, StoredMemory[]>()

                for (const memory of allMemories) {
                    // Normalize content for comparison
                    const normalized = memory.content
                        .toLowerCase()
                        .replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '')
                        .slice(0, 50)

                    if (!contentMap.has(normalized)) {
                        contentMap.set(normalized, [])
                    }
                    contentMap.get(normalized)!.push(memory)
                }

                // Mark duplicates (keep highest importance one)
                for (const [_, memories] of contentMap) {
                    if (memories.length > 1) {
                        memories.sort((a, b) => b.importance - a.importance)
                        // Keep first (highest importance), mark rest for removal
                        for (let i = 1; i < memories.length; i++) {
                            toRemove.push({
                                id: memories[i].id,
                                reason: '重复内容',
                                content: memories[i].content.slice(0, 30),
                            })
                        }
                    }
                }
            }

            // 2. Find outdated memories (old + rarely accessed + low importance)
            if (strategy === 'outdated' || strategy === 'all') {
                const now = Date.now()
                const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000

                for (const memory of allMemories) {
                    const isDuplicate = toRemove.some(r => r.id === memory.id)
                    if (isDuplicate) continue

                    // Old, rarely accessed, and not important
                    if (
                        memory.createdAt < thirtyDaysAgo &&
                        memory.accessCount < 3 &&
                        memory.importance <= 4 &&
                        memory.category !== 'fact' // Don't auto-remove facts
                    ) {
                        toRemove.push({
                            id: memory.id,
                            reason: '过时且很少访问',
                            content: memory.content.slice(0, 30),
                        })
                    }
                }
            }

            // 3. Find low importance memories
            if (strategy === 'low_importance' || strategy === 'all') {
                for (const memory of allMemories) {
                    const isDuplicate = toRemove.some(r => r.id === memory.id)
                    if (isDuplicate) continue

                    if (
                        memory.importance <= 2 &&
                        memory.accessCount < 2 &&
                        memory.category === 'context' // Only auto-remove context with very low importance
                    ) {
                        toRemove.push({
                            id: memory.id,
                            reason: '低重要性背景信息',
                            content: memory.content.slice(0, 30),
                        })
                    }
                }
            }

            // Execute cleanup if not dry run
            if (!dryRun && toRemove.length > 0) {
                for (const item of toRemove) {
                    await memoryStore.invalidate(item.id)
                }
            }

            const summary = toRemove.map(r => `- ${r.content}... (${r.reason})`).join('\n')

            return {
                name: 'cleanup_memories',
                output: {
                    success: true,
                    removed: toRemove.length,
                    dryRun,
                    details: toRemove,
                },
                message: dryRun
                    ? `发现 ${toRemove.length} 条可清理记忆:\n${summary}`
                    : `已清理 ${toRemove.length} 条记忆:\n${summary}`,
            }
        } catch (error) {
            return {
                name: 'cleanup_memories',
                output: { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
                message: '清理记忆失败。',
            }
        }
    },
}

/**
 * All memory tools bundled together
 */
export const memoryTools: Tool[] = [
    storeMemoryTool,
    recallMemoryTool,
    forgetMemoryTool,
    updateMemoryTool,
    listMemoriesTool,
    cleanupMemoriesTool,
]

/**
 * Format memories for injection into system prompt
 */
export function formatMemoriesForPrompt(memories: StoredMemory[]): string {
    if (memories.length === 0) return ''

    const lines = memories.map(m => {
        const categoryLabel = {
            fact: '事实',
            preference: '偏好',
            event: '事件',
            correction: '纠正',
            context: '背景',
        }[m.category]

        return `- [${categoryLabel}] ${m.content}`
    })

    return `\n【长期记忆】\n${lines.join('\n')}\n`
}

/**
 * Get relevant memories for a given context (intelligent search)
 * Uses Flexsearch + LLM query expansion, returns candidates for agent to evaluate
 */
export async function getRelevantMemories(
    context: string,
    limit: number = 5,
    useSmartSearch: boolean = true
): Promise<StoredMemory[]> {
    const seen = new Set<string>()
    const candidates: StoredMemory[] = []

    // 1. Direct Flexsearch full-text search
    const directResults = await memoryStore.search(context, limit * 2)
    for (const memory of directResults) {
        if (!seen.has(memory.id)) {
            seen.add(memory.id)
            candidates.push(memory)
        }
    }

    // 2. Expand query with related terms (if smart search enabled and not enough results)
    if (useSmartSearch && candidates.length < limit) {
        try {
            const expandedTerms = await expandSearchQuery(context)
            console.log('[Memory] Expanded search terms:', expandedTerms)

            for (const term of expandedTerms) {
                const termResults = await memoryStore.search(term, 3)
                for (const memory of termResults) {
                    if (!seen.has(memory.id)) {
                        seen.add(memory.id)
                        candidates.push(memory)
                    }
                }
            }
        } catch (error) {
            console.warn('Failed to expand search:', error)
        }
    }

    // 3. Add high-importance memories (always relevant)
    const importantMemories = await memoryStore.getMostImportant(3)
    for (const memory of importantMemories) {
        if (!seen.has(memory.id)) {
            seen.add(memory.id)
            candidates.push(memory)
        }
    }

    // 4. Simple shuffle + sort by importance (no LLM scoring - agent will evaluate)
    //    This ensures variety while prioritizing important memories
    if (candidates.length > limit) {
        // Shuffle candidates to add variety
        for (let i = candidates.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1))
            ;[candidates[i], candidates[j]] = [candidates[j], candidates[i]]
        }

        // Sort by importance (higher first) but keep some randomness
        candidates.sort((a, b) => {
            // Group by importance tiers (10-8, 7-5, 4-1)
            const tierA = Math.floor((a.importance - 1) / 3)
            const tierB = Math.floor((b.importance - 1) / 3)
            return tierB - tierA
        })
    }

    return candidates.slice(0, limit)
}

/**
 * Get memories suitable for generating an initial greeting
 * Returns high-importance facts and preferences about the user
 */
export async function getGreetingMemories(): Promise<StoredMemory[]> {
    const memories: StoredMemory[] = []
    const seen = new Set<string>()

    // Get high-importance facts (like user's name)
    const facts = await memoryStore.getByCategory('fact', 10)
    for (const m of facts.filter(f => f.importance >= 7)) {
        if (!seen.has(m.id)) {
            seen.add(m.id)
            memories.push(m)
        }
    }

    // Get important preferences
    const preferences = await memoryStore.getByCategory('preference', 5)
    for (const m of preferences.filter(p => p.importance >= 6)) {
        if (!seen.has(m.id)) {
            seen.add(m.id)
            memories.push(m)
        }
    }

    // Get recent significant events
    const events = await memoryStore.getByCategory('event', 3)
    for (const m of events.filter(e => e.importance >= 7)) {
        if (!seen.has(m.id)) {
            seen.add(m.id)
            memories.push(m)
        }
    }

    // Sort by importance descending
    return memories.sort((a, b) => b.importance - a.importance).slice(0, 5)
}
