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

/**
 * All memory tools bundled together
 */
export const memoryTools: Tool[] = [
    storeMemoryTool,
    recallMemoryTool,
    forgetMemoryTool,
    updateMemoryTool,
    listMemoriesTool,
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
 * Get relevant memories for a given context
 */
export async function getRelevantMemories(
    context: string,
    limit: number = 5
): Promise<StoredMemory[]> {
    const searchResults = await memoryStore.search(context, limit)

    // Also get high-importance memories that might be relevant
    const importantMemories = await memoryStore.getMostImportant(3)

    // Merge and deduplicate
    const seen = new Set<string>()
    const merged: StoredMemory[] = []

    for (const memory of [...searchResults, ...importantMemories]) {
        if (!seen.has(memory.id)) {
            seen.add(memory.id)
            merged.push(memory)
        }
    }

    // Sort by relevance score (if available) or importance
    return merged
        .sort((a, b) => {
            const aScore = ('relevanceScore' in a ? (a as any).relevanceScore : 0) + a.importance
            const bScore = ('relevanceScore' in b ? (b as any).relevanceScore : 0) + b.importance
            return bScore - aScore
        })
        .slice(0, limit)
}
