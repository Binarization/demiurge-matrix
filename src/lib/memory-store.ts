/**
 * IndexedDB-based long-term memory storage for the Agent
 *
 * Features:
 * - Full-text search across memory content
 * - Memory categories (fact, preference, event, correction)
 * - Importance scoring for selective recall
 * - Automatic cleanup of stale/incorrect memories
 */

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

class MemoryStore {
    private db: IDBDatabase | null = null
    private dbPromise: Promise<IDBDatabase> | null = null

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
                    // We'll handle this by iterating through records after upgrade
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
        // Simple keyword extraction: split by common delimiters and filter
        const words = content
            .toLowerCase()
            .replace(/[^\u4e00-\u9fa5a-zA-Z0-9\s]/g, ' ') // Keep Chinese, alphanumeric
            .split(/\s+/)
            .filter(word => word.length >= 2)

        // Remove duplicates and return
        return [...new Set(words)]
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

            request.onsuccess = () => resolve(memory)
            request.onerror = () => reject(new Error(`Failed to store memory: ${request.error?.message}`))
        })
    }

    /**
     * Full-text search across memories
     */
    async search(query: string, limit: number = 10): Promise<MemorySearchResult[]> {
        const db = await this.getDB()
        const queryKeywords = this.extractKeywords(query)
        const queryLower = query.toLowerCase()

        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readonly')
            const store = transaction.objectStore(STORE_NAME)
            const index = store.index('isValid')
            const request = index.openCursor(IDBKeyRange.only(1)) // 1 = valid

            const results: MemorySearchResult[] = []

            request.onsuccess = event => {
                const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result

                if (cursor) {
                    const memory = cursor.value as StoredMemory

                    // Calculate relevance score
                    let relevanceScore = 0
                    const contentLower = memory.content.toLowerCase()

                    // Direct substring match (highest weight)
                    if (contentLower.includes(queryLower)) {
                        relevanceScore += 50
                    }

                    // Keyword overlap
                    const matchingKeywords = queryKeywords.filter(kw =>
                        memory.keywords.some(mk => mk.includes(kw) || kw.includes(mk))
                    )
                    relevanceScore += matchingKeywords.length * 10

                    // Importance factor
                    relevanceScore += memory.importance * 2

                    // Recency factor (memories accessed recently get a small boost)
                    const daysSinceAccess = (Date.now() - memory.lastAccessedAt) / (1000 * 60 * 60 * 24)
                    if (daysSinceAccess < 7) {
                        relevanceScore += Math.floor(7 - daysSinceAccess)
                    }

                    if (relevanceScore > 0) {
                        results.push({ ...memory, relevanceScore })
                    }

                    cursor.continue()
                } else {
                    // Sort by relevance and return top results
                    results.sort((a, b) => b.relevanceScore - a.relevanceScore)
                    resolve(results.slice(0, limit))
                }
            }

            request.onerror = () => reject(new Error(`Search failed: ${request.error?.message}`))
        })
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
                    putRequest.onsuccess = () => resolve()
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
                    putRequest.onsuccess = () => resolve()
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

            request.onsuccess = () => resolve()
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
                    putRequest.onsuccess = () => resolve(memory)
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

            request.onsuccess = () => resolve()
            request.onerror = () => reject(new Error(`Failed to clear memories: ${request.error?.message}`))
        })
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
    }
}

// Export a singleton instance
export const memoryStore = new MemoryStore()
