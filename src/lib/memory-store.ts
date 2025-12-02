/**
 * IndexedDB-based long-term memory storage for the Agent
 *
 * Features:
 * - Full-text search with Flexsearch (Chinese + English support)
 * - Memory categories (fact, preference, event, correction)
 * - Importance scoring for selective recall
 * - Automatic cleanup of stale/incorrect memories
 */

import { Index } from 'flexsearch'

// Type declaration for Intl.Segmenter (available in modern browsers)
declare global {
    namespace Intl {
        interface SegmenterOptions {
            granularity?: 'grapheme' | 'word' | 'sentence'
        }
        interface SegmentData {
            segment: string
            index: number
            isWordLike?: boolean
        }
        interface Segments {
            [Symbol.iterator](): IterableIterator<SegmentData>
        }
        class Segmenter {
            constructor(locale?: string, options?: SegmenterOptions)
            segment(input: string): Segments
        }
    }
}

export type MemoryCategory = 'fact' | 'preference' | 'event' | 'correction' | 'context'

export type StoredMemory = {
    id: string
    content: string
    category: MemoryCategory
    importance: number // 1-10 scale
    keywords: string[] // For search optimization
    createdAt: number
    lastAccessedAt: number
    accessCount: number
    isValid: number // 1 = valid, 0 = invalid (using number for IndexedDB compatibility)
    metadata?: Record<string, unknown>
}

export type MemorySearchResult = StoredMemory & {
    relevanceScore: number
}

const DB_NAME = 'demiurge_memory'
const DB_VERSION = 2 // Bumped version to handle schema change
const STORE_NAME = 'memories'

/**
 * Chinese text tokenizer for Flexsearch
 * Uses Intl.Segmenter for proper Chinese word segmentation (分词)
 * Falls back to character-by-character for older browsers
 */
function chineseTokenizer(text: string): string[] {
    const tokens: string[] = []

    // Check if Intl.Segmenter is available (modern browsers)
    if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
        // Use Intl.Segmenter for proper Chinese word segmentation
        const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' })
        const segments = segmenter.segment(text)

        for (const segment of segments) {
            const word = segment.segment.trim().toLowerCase()
            // Filter out punctuation and very short segments
            if (word.length >= 1 && /[\u4e00-\u9fa5a-zA-Z0-9]/.test(word)) {
                // For Chinese, keep single characters too (they can be meaningful)
                // For English, require at least 2 characters
                const isChinese = /[\u4e00-\u9fa5]/.test(word)
                if (isChinese || word.length >= 2) {
                    tokens.push(word)
                }
            }
        }
    } else {
        // Fallback: character-by-character for Chinese, word-by-word for English
        let englishBuffer = ''

        for (const char of text) {
            if (/[\u4e00-\u9fa5]/.test(char)) {
                // Flush English buffer
                if (englishBuffer.length >= 2) {
                    tokens.push(englishBuffer.toLowerCase())
                }
                englishBuffer = ''
                // Add Chinese character
                tokens.push(char)
            } else if (/[a-zA-Z0-9]/.test(char)) {
                englishBuffer += char
            } else {
                if (englishBuffer.length >= 2) {
                    tokens.push(englishBuffer.toLowerCase())
                }
                englishBuffer = ''
            }
        }

        if (englishBuffer.length >= 2) {
            tokens.push(englishBuffer.toLowerCase())
        }
    }

    // Remove duplicates while preserving order
    return [...new Set(tokens)]
}

/**
 * Create a Flexsearch index optimized for Chinese + English
 */
function createSearchIndex(): Index {
    return new Index({
        tokenize: chineseTokenizer,
        cache: 100,
        resolution: 9,
    })
}

class MemoryStore {
    private db: IDBDatabase | null = null
    private dbPromise: Promise<IDBDatabase> | null = null
    private searchIndex: Index | null = null
    private indexedMemories: Map<string, StoredMemory> = new Map()
    private indexInitialized = false
    private indexInitPromise: Promise<void> | null = null

    private async getDB(): Promise<IDBDatabase> {
        if (this.db) return this.db

        if (this.dbPromise) return this.dbPromise

        this.dbPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION)

            request.onerror = () => {
                reject(new Error(`Failed to open IndexedDB: ${request.error?.message}`))
            }

            request.onsuccess = () => {
                this.db = request.result
                resolve(this.db)
            }

            request.onupgradeneeded = event => {
                const db = (event.target as IDBOpenDBRequest).result
                const oldVersion = event.oldVersion

                // Handle fresh install or upgrade from version 1
                if (oldVersion < 1) {
                    // Fresh install
                    const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' })
                    store.createIndex('category', 'category', { unique: false })
                    store.createIndex('importance', 'importance', { unique: false })
                    store.createIndex('createdAt', 'createdAt', { unique: false })
                    store.createIndex('lastAccessedAt', 'lastAccessedAt', { unique: false })
                    store.createIndex('isValid', 'isValid', { unique: false })
                } else if (oldVersion === 1) {
                    // Upgrading from v1 - need to migrate boolean isValid to number
                    const transaction = (event.target as IDBOpenDBRequest).transaction
                    if (transaction) {
                        const store = transaction.objectStore(STORE_NAME)
                        const cursorRequest = store.openCursor()

                        cursorRequest.onsuccess = (e) => {
                            const cursor = (e.target as IDBRequest<IDBCursorWithValue>).result
                            if (cursor) {
                                const record = cursor.value
                                // Convert boolean to number
                                if (typeof record.isValid === 'boolean') {
                                    record.isValid = record.isValid ? 1 : 0
                                    cursor.update(record)
                                }
                                cursor.continue()
                            }
                        }
                    }
                }
            }
        })

        return this.dbPromise
    }

    /**
     * Initialize the Flexsearch index from IndexedDB
     */
    private async initSearchIndex(): Promise<void> {
        if (this.indexInitialized) return
        if (this.indexInitPromise) return this.indexInitPromise

        this.indexInitPromise = (async () => {
            const db = await this.getDB()
            this.searchIndex = createSearchIndex()
            this.indexedMemories.clear()

            return new Promise<void>((resolve, reject) => {
                const transaction = db.transaction([STORE_NAME], 'readonly')
                const store = transaction.objectStore(STORE_NAME)
                const index = store.index('isValid')
                const request = index.openCursor(IDBKeyRange.only(1)) // 1 = valid

                request.onsuccess = event => {
                    const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result

                    if (cursor) {
                        const memory = cursor.value as StoredMemory
                        // Add to Flexsearch index
                        this.searchIndex!.add(memory.id, memory.content)
                        this.indexedMemories.set(memory.id, memory)
                        cursor.continue()
                    } else {
                        this.indexInitialized = true
                        console.log(`[MemoryStore] Search index initialized with ${this.indexedMemories.size} memories`)
                        resolve()
                    }
                }

                request.onerror = () => reject(new Error(`Failed to init search index: ${request.error?.message}`))
            })
        })()

        return this.indexInitPromise
    }

    /**
     * Add a memory to the search index
     */
    private addToSearchIndex(memory: StoredMemory): void {
        if (this.searchIndex && memory.isValid === 1) {
            this.searchIndex.add(memory.id, memory.content)
            this.indexedMemories.set(memory.id, memory)
        }
    }

    /**
     * Remove a memory from the search index
     */
    private removeFromSearchIndex(id: string): void {
        if (this.searchIndex) {
            this.searchIndex.remove(id)
            this.indexedMemories.delete(id)
        }
    }

    /**
     * Generate a unique ID for a memory
     */
    private generateId(): string {
        const timestamp = Date.now().toString(36)
        const random = Math.random().toString(36).slice(2, 8)
        return `mem_${timestamp}_${random}`
    }

    /**
     * Extract keywords from content for search optimization
     */
    private extractKeywords(content: string): string[] {
        return chineseTokenizer(content)
    }

    /**
     * Store a new memory
     */
    async store(
        content: string,
        category: MemoryCategory,
        importance: number = 5,
        metadata?: Record<string, unknown>
    ): Promise<StoredMemory> {
        const db = await this.getDB()
        await this.initSearchIndex()

        const memory: StoredMemory = {
            id: this.generateId(),
            content,
            category,
            importance: Math.max(1, Math.min(10, importance)),
            keywords: this.extractKeywords(content),
            createdAt: Date.now(),
            lastAccessedAt: Date.now(),
            accessCount: 0,
            isValid: 1, // 1 = valid
            metadata,
        }

        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readwrite')
            const store = transaction.objectStore(STORE_NAME)
            const request = store.add(memory)

            request.onsuccess = () => {
                // Add to search index
                this.addToSearchIndex(memory)
                resolve(memory)
            }
            request.onerror = () => reject(new Error(`Failed to store memory: ${request.error?.message}`))
        })
    }

    /**
     * Full-text search across memories using Flexsearch
     */
    async search(query: string, limit: number = 10): Promise<MemorySearchResult[]> {
        await this.initSearchIndex()

        if (!this.searchIndex || !query.trim()) {
            return []
        }

        // Search using Flexsearch
        const searchResults = this.searchIndex.search(query, { limit: limit * 2 })

        // Map results to memories with relevance scores
        const results: MemorySearchResult[] = []
        const queryLower = query.toLowerCase()

        for (let i = 0; i < searchResults.length; i++) {
            const memoryId = String(searchResults[i])
            const memory = this.indexedMemories.get(memoryId)

            if (memory && memory.isValid === 1) {
                // Calculate relevance score
                let relevanceScore = 100 - i * 5 // Base score from search rank

                // Boost for exact substring match
                if (memory.content.toLowerCase().includes(queryLower)) {
                    relevanceScore += 30
                }

                // Importance factor
                relevanceScore += memory.importance * 3

                // Recency factor (memories accessed recently get a small boost)
                const daysSinceAccess = (Date.now() - memory.lastAccessedAt) / (1000 * 60 * 60 * 24)
                if (daysSinceAccess < 7) {
                    relevanceScore += Math.floor(7 - daysSinceAccess)
                }

                results.push({ ...memory, relevanceScore })
            }
        }

        // Sort by relevance and return top results
        results.sort((a, b) => b.relevanceScore - a.relevanceScore)
        return results.slice(0, limit)
    }

    /**
     * Get memories by category
     */
    async getByCategory(category: MemoryCategory, limit: number = 20): Promise<StoredMemory[]> {
        const db = await this.getDB()

        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readonly')
            const store = transaction.objectStore(STORE_NAME)
            const index = store.index('category')
            const request = index.openCursor(IDBKeyRange.only(category), 'prev')

            const results: StoredMemory[] = []

            request.onsuccess = event => {
                const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result

                if (cursor && results.length < limit) {
                    const memory = cursor.value as StoredMemory
                    if (memory.isValid === 1) {
                        results.push(memory)
                    }
                    cursor.continue()
                } else {
                    resolve(results)
                }
            }

            request.onerror = () => reject(new Error(`Failed to get memories: ${request.error?.message}`))
        })
    }

    /**
     * Get most important memories
     */
    async getMostImportant(limit: number = 10): Promise<StoredMemory[]> {
        const db = await this.getDB()

        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readonly')
            const store = transaction.objectStore(STORE_NAME)
            const index = store.index('importance')
            const request = index.openCursor(null, 'prev') // Descending order

            const results: StoredMemory[] = []

            request.onsuccess = event => {
                const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result

                if (cursor && results.length < limit) {
                    const memory = cursor.value as StoredMemory
                    if (memory.isValid === 1) {
                        results.push(memory)
                    }
                    cursor.continue()
                } else {
                    resolve(results)
                }
            }

            request.onerror = () => reject(new Error(`Failed to get memories: ${request.error?.message}`))
        })
    }

    /**
     * Get recent memories
     */
    async getRecent(limit: number = 10): Promise<StoredMemory[]> {
        const db = await this.getDB()

        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readonly')
            const store = transaction.objectStore(STORE_NAME)
            const index = store.index('createdAt')
            const request = index.openCursor(null, 'prev') // Most recent first

            const results: StoredMemory[] = []

            request.onsuccess = event => {
                const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result

                if (cursor && results.length < limit) {
                    const memory = cursor.value as StoredMemory
                    if (memory.isValid === 1) {
                        results.push(memory)
                    }
                    cursor.continue()
                } else {
                    resolve(results)
                }
            }

            request.onerror = () => reject(new Error(`Failed to get memories: ${request.error?.message}`))
        })
    }

    /**
     * Update memory access timestamp and count
     */
    async recordAccess(id: string): Promise<void> {
        const db = await this.getDB()

        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readwrite')
            const store = transaction.objectStore(STORE_NAME)
            const getRequest = store.get(id)

            getRequest.onsuccess = () => {
                const memory = getRequest.result as StoredMemory | undefined
                if (memory) {
                    memory.lastAccessedAt = Date.now()
                    memory.accessCount += 1
                    const putRequest = store.put(memory)
                    putRequest.onsuccess = () => {
                        // Update in-memory cache
                        if (this.indexedMemories.has(id)) {
                            this.indexedMemories.set(id, memory)
                        }
                        resolve()
                    }
                    putRequest.onerror = () => reject(new Error(`Failed to update memory: ${putRequest.error?.message}`))
                } else {
                    resolve() // Memory not found, silently ignore
                }
            }

            getRequest.onerror = () => reject(new Error(`Failed to get memory: ${getRequest.error?.message}`))
        })
    }

    /**
     * Mark a memory as invalid (soft delete)
     */
    async invalidate(id: string): Promise<void> {
        const db = await this.getDB()

        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readwrite')
            const store = transaction.objectStore(STORE_NAME)
            const getRequest = store.get(id)

            getRequest.onsuccess = () => {
                const memory = getRequest.result as StoredMemory | undefined
                if (memory) {
                    memory.isValid = 0 // 0 = invalid
                    const putRequest = store.put(memory)
                    putRequest.onsuccess = () => {
                        // Remove from search index
                        this.removeFromSearchIndex(id)
                        resolve()
                    }
                    putRequest.onerror = () => reject(new Error(`Failed to invalidate memory: ${putRequest.error?.message}`))
                } else {
                    resolve()
                }
            }

            getRequest.onerror = () => reject(new Error(`Failed to get memory: ${getRequest.error?.message}`))
        })
    }

    /**
     * Permanently delete a memory
     */
    async delete(id: string): Promise<void> {
        const db = await this.getDB()

        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readwrite')
            const store = transaction.objectStore(STORE_NAME)
            const request = store.delete(id)

            request.onsuccess = () => {
                // Remove from search index
                this.removeFromSearchIndex(id)
                resolve()
            }
            request.onerror = () => reject(new Error(`Failed to delete memory: ${request.error?.message}`))
        })
    }

    /**
     * Update memory content or importance
     */
    async update(id: string, updates: Partial<Pick<StoredMemory, 'content' | 'importance' | 'category' | 'isValid'>>): Promise<StoredMemory | null> {
        const db = await this.getDB()

        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readwrite')
            const store = transaction.objectStore(STORE_NAME)
            const getRequest = store.get(id)

            getRequest.onsuccess = () => {
                const memory = getRequest.result as StoredMemory | undefined
                if (memory) {
                    const contentChanged = updates.content !== undefined && updates.content !== memory.content

                    if (updates.content !== undefined) {
                        memory.content = updates.content
                        memory.keywords = this.extractKeywords(updates.content)
                    }
                    if (updates.importance !== undefined) {
                        memory.importance = Math.max(1, Math.min(10, updates.importance))
                    }
                    if (updates.category !== undefined) {
                        memory.category = updates.category
                    }
                    if (updates.isValid !== undefined) {
                        memory.isValid = updates.isValid
                    }

                    const putRequest = store.put(memory)
                    putRequest.onsuccess = () => {
                        // Update search index if content changed
                        if (contentChanged && this.searchIndex) {
                            this.searchIndex.remove(id)
                            if (memory.isValid === 1) {
                                this.searchIndex.add(id, memory.content)
                            }
                        }
                        // Update in-memory cache
                        if (memory.isValid === 1) {
                            this.indexedMemories.set(id, memory)
                        } else {
                            this.indexedMemories.delete(id)
                        }
                        resolve(memory)
                    }
                    putRequest.onerror = () => reject(new Error(`Failed to update memory: ${putRequest.error?.message}`))
                } else {
                    resolve(null)
                }
            }

            getRequest.onerror = () => reject(new Error(`Failed to get memory: ${getRequest.error?.message}`))
        })
    }

    /**
     * Get all valid memories count
     */
    async getCount(): Promise<number> {
        const db = await this.getDB()

        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readonly')
            const store = transaction.objectStore(STORE_NAME)
            const index = store.index('isValid')
            const request = index.count(IDBKeyRange.only(1)) // 1 = valid

            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(new Error(`Failed to count memories: ${request.error?.message}`))
        })
    }

    /**
     * Get a memory by ID
     */
    async getById(id: string): Promise<StoredMemory | null> {
        const db = await this.getDB()

        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readonly')
            const store = transaction.objectStore(STORE_NAME)
            const request = store.get(id)

            request.onsuccess = () => {
                const memory = request.result as StoredMemory | undefined
                resolve(memory ?? null)
            }

            request.onerror = () => reject(new Error(`Failed to get memory: ${request.error?.message}`))
        })
    }

    /**
     * Clear all memories (use with caution)
     */
    async clearAll(): Promise<void> {
        const db = await this.getDB()

        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readwrite')
            const store = transaction.objectStore(STORE_NAME)
            const request = store.clear()

            request.onsuccess = () => {
                // Clear search index
                this.searchIndex = createSearchIndex()
                this.indexedMemories.clear()
                resolve()
            }
            request.onerror = () => reject(new Error(`Failed to clear memories: ${request.error?.message}`))
        })
    }

    /**
     * Rebuild the search index from IndexedDB
     * Call this if the index seems out of sync
     */
    async rebuildSearchIndex(): Promise<void> {
        this.indexInitialized = false
        this.indexInitPromise = null
        this.searchIndex = null
        this.indexedMemories.clear()
        await this.initSearchIndex()
    }

    /**
     * Close the database connection
     */
    close(): void {
        if (this.db) {
            this.db.close()
            this.db = null
            this.dbPromise = null
        }
        this.searchIndex = null
        this.indexedMemories.clear()
        this.indexInitialized = false
        this.indexInitPromise = null
    }
}

// Export a singleton instance
export const memoryStore = new MemoryStore()
