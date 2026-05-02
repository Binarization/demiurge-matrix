/**
 * IndexedDB-based long-term memory storage for the Agent
 *
 * v3 schema:
 *   - Hybrid retrieval-ready: stores optional embedding vectors alongside content
 *   - Continuous decay: effectiveStrength() replaces brittle cleanup heuristics
 *   - Two-dimensional taxonomy: category (type) + subject (about whom)
 *   - Soft contradictions: supersededBy + confidence rather than hard delete
 *   - Time-bound memories: expiresAt for promises/plans
 */

import { Index } from 'flexsearch'

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
export type MemorySubject = 'user' | 'character' | 'world' | 'relationship' | 'other'
export type MemorySource = 'user_explicit' | 'inferred' | 'agent_reflection'

export type StoredMemory = {
    id: string
    content: string
    category: MemoryCategory
    subject: MemorySubject
    source: MemorySource
    importance: number // 1-10
    confidence: number // 1-10 (separate from importance: how sure we are)
    createdAt: number
    lastAccessedAt: number
    accessCount: number
    isValid: number // 1 = valid, 0 = invalid
    date: string // yyyy-mm-dd
    embedding?: number[] // optional dense vector
    supersededBy?: string // id of memory that replaced this
    relatedIds?: string[] // soft links
    expiresAt?: number // unix ms; memory inert past this
    metadata?: Record<string, unknown>
}

export type MemorySearchResult = StoredMemory & {
    relevanceScore: number
    lexicalScore?: number
    vectorScore?: number
    strength?: number
}

const DB_NAME = 'demiurge_memory'
const DB_VERSION = 3
const STORE_NAME = 'memories'
const DAY_MS = 24 * 60 * 60 * 1000

// Category-specific half-life in days. Facts decay slowly; context decays fast.
const HALF_LIFE_DAYS: Record<MemoryCategory, number> = {
    fact: 365,
    preference: 180,
    event: 90,
    correction: 365,
    context: 30,
}

/**
 * Continuous decay scoring. Replaces brittle cleanup heuristics.
 * Higher = stronger memory; ranking + cleanup both consume this.
 */
export function effectiveStrength(memory: StoredMemory, now: number = Date.now()): number {
    if (memory.expiresAt !== undefined && memory.expiresAt < now) return 0
    if (memory.isValid !== 1) return 0

    const halfLife = HALF_LIFE_DAYS[memory.category] ?? 90
    const ageDays = (now - memory.createdAt) / DAY_MS
    const sinceAccessDays = (now - memory.lastAccessedAt) / DAY_MS

    // base decay from age
    const baseStrength = memory.importance * Math.exp(-ageDays / halfLife)
    // spaced-repetition style recall boost
    const recallBoost = Math.log(1 + memory.accessCount) * 2
    // recently accessed memories resist decay
    const accessRecency = 3 * Math.exp(-sinceAccessDays / halfLife)
    // confidence: 0.5x at 1, 1.0x at 10
    const confidenceFactor = 0.5 + (memory.confidence / 10) * 0.5

    return (baseStrength + recallBoost + accessRecency) * confidenceFactor
}

function chineseTokenizer(text: string): string[] {
    const tokens: string[] = []

    if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
        const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' })
        const segments = segmenter.segment(text)

        for (const segment of segments) {
            const word = segment.segment.trim().toLowerCase()
            if (word.length >= 1 && /[一-龥a-zA-Z0-9]/.test(word)) {
                const isChinese = /[一-龥]/.test(word)
                if (isChinese || word.length >= 2) {
                    tokens.push(word)
                }
            }
        }
    } else {
        let englishBuffer = ''
        for (const char of text) {
            if (/[一-龥]/.test(char)) {
                if (englishBuffer.length >= 2) tokens.push(englishBuffer.toLowerCase())
                englishBuffer = ''
                tokens.push(char)
            } else if (/[a-zA-Z0-9]/.test(char)) {
                englishBuffer += char
            } else {
                if (englishBuffer.length >= 2) tokens.push(englishBuffer.toLowerCase())
                englishBuffer = ''
            }
        }
        if (englishBuffer.length >= 2) tokens.push(englishBuffer.toLowerCase())
    }

    return [...new Set(tokens)]
}

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
                const transaction = (event.target as IDBOpenDBRequest).transaction
                const oldVersion = event.oldVersion

                let store: IDBObjectStore
                if (oldVersion < 1) {
                    store = db.createObjectStore(STORE_NAME, { keyPath: 'id' })
                } else if (transaction) {
                    store = transaction.objectStore(STORE_NAME)
                } else {
                    return
                }

                // Clean up indexes that may exist from older versions
                for (const name of Array.from(store.indexNames)) {
                    store.deleteIndex(name)
                }

                // Compound indexes: filter on isValid first, no JS-side filtering
                store.createIndex('valid_importance', ['isValid', 'importance'], { unique: false })
                store.createIndex('valid_createdAt', ['isValid', 'createdAt'], { unique: false })
                store.createIndex('valid_category', ['isValid', 'category'], { unique: false })
                store.createIndex('valid_subject', ['isValid', 'subject'], { unique: false })
                store.createIndex('valid_lastAccessed', ['isValid', 'lastAccessedAt'], { unique: false })
                store.createIndex('isValid', 'isValid', { unique: false })

                // Migrate existing rows: backfill new fields
                if (oldVersion > 0 && oldVersion < 3 && transaction) {
                    const cursorRequest = store.openCursor()
                    cursorRequest.onsuccess = e => {
                        const cursor = (e.target as IDBRequest<IDBCursorWithValue>).result
                        if (!cursor) return
                        const record = cursor.value as StoredMemory & { keywords?: unknown }
                        let touched = false
                        if (typeof record.isValid === 'boolean') {
                            record.isValid = (record as any).isValid ? 1 : 0
                            touched = true
                        }
                        if (record.confidence === undefined) {
                            record.confidence = record.importance ?? 5
                            touched = true
                        }
                        if (record.subject === undefined) {
                            record.subject = inferSubjectFromCategory(record.category)
                            touched = true
                        }
                        if (record.source === undefined) {
                            record.source = 'user_explicit'
                            touched = true
                        }
                        // drop unused keywords
                        if (record.keywords !== undefined) {
                            delete record.keywords
                            touched = true
                        }
                        if (touched) cursor.update(record)
                        cursor.continue()
                    }
                }
            }
        })

        return this.dbPromise
    }

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
                const request = index.openCursor(IDBKeyRange.only(1))

                request.onsuccess = event => {
                    const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result
                    if (cursor) {
                        const memory = cursor.value as StoredMemory
                        this.searchIndex!.add(memory.id, memory.content)
                        this.indexedMemories.set(memory.id, memory)
                        cursor.continue()
                    } else {
                        this.indexInitialized = true
                        resolve()
                    }
                }
                request.onerror = () => reject(new Error(`Failed to init search index: ${request.error?.message}`))
            })
        })()

        return this.indexInitPromise
    }

    private addToSearchIndex(memory: StoredMemory): void {
        if (this.searchIndex && memory.isValid === 1) {
            this.searchIndex.add(memory.id, memory.content)
            this.indexedMemories.set(memory.id, memory)
        }
    }

    private removeFromSearchIndex(id: string): void {
        if (this.searchIndex) {
            this.searchIndex.remove(id)
            this.indexedMemories.delete(id)
        }
    }

    private generateId(): string {
        const timestamp = Date.now().toString(36)
        const random = Math.random().toString(36).slice(2, 8)
        return `mem_${timestamp}_${random}`
    }

    /**
     * Snapshot of all live memories — useful for hybrid retrieval that needs
     * to score the entire pool against a query embedding.
     */
    async getAllValid(): Promise<StoredMemory[]> {
        await this.initSearchIndex()
        return Array.from(this.indexedMemories.values())
    }

    /**
     * Lookup straight from the in-memory cache. Avoids an IDB round trip.
     */
    getCachedById(id: string): StoredMemory | undefined {
        return this.indexedMemories.get(id)
    }

    async store(
        content: string,
        category: MemoryCategory,
        importance: number = 5,
        options: {
            subject?: MemorySubject
            source?: MemorySource
            confidence?: number
            embedding?: number[]
            expiresAt?: number
            relatedIds?: string[]
            metadata?: Record<string, unknown>
        } = {}
    ): Promise<StoredMemory> {
        const db = await this.getDB()
        await this.initSearchIndex()

        const now = new Date()
        const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`

        const memory: StoredMemory = {
            id: this.generateId(),
            content,
            category,
            subject: options.subject ?? inferSubjectFromCategory(category),
            source: options.source ?? 'user_explicit',
            importance: clamp(importance, 1, 10),
            confidence: clamp(options.confidence ?? importance, 1, 10),
            createdAt: Date.now(),
            lastAccessedAt: Date.now(),
            accessCount: 0,
            isValid: 1,
            date,
            embedding: options.embedding,
            relatedIds: options.relatedIds,
            expiresAt: options.expiresAt,
            metadata: options.metadata,
        }

        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readwrite')
            const store = transaction.objectStore(STORE_NAME)
            const request = store.add(memory)
            request.onsuccess = () => {
                this.addToSearchIndex(memory)
                resolve(memory)
            }
            request.onerror = () => reject(new Error(`Failed to store memory: ${request.error?.message}`))
        })
    }

    /**
     * Lexical search via Flexsearch. The embedding-aware variant lives in
     * memory-search.ts, which composes this with vector cosine.
     */
    async search(query: string, limit: number = 10): Promise<MemorySearchResult[]> {
        await this.initSearchIndex()
        if (!this.searchIndex || !query.trim()) return []

        const searchResults = this.searchIndex.search(query, { limit: limit * 2 })
        const results: MemorySearchResult[] = []
        const queryLower = query.toLowerCase()
        const now = Date.now()

        for (let i = 0; i < searchResults.length; i++) {
            const memoryId = String(searchResults[i])
            const memory = this.indexedMemories.get(memoryId)
            if (!memory || memory.isValid !== 1) continue

            let lexicalScore = 100 - i * 5
            if (memory.content.toLowerCase().includes(queryLower)) lexicalScore += 30

            const strength = effectiveStrength(memory, now)
            const relevanceScore = lexicalScore + strength * 2

            results.push({ ...memory, relevanceScore, lexicalScore, strength })
        }

        results.sort((a, b) => b.relevanceScore - a.relevanceScore)
        return results.slice(0, limit)
    }

    async getByCategory(category: MemoryCategory, limit: number = 20): Promise<StoredMemory[]> {
        const db = await this.getDB()
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readonly')
            const store = transaction.objectStore(STORE_NAME)
            const index = store.index('valid_category')
            const range = IDBKeyRange.only([1, category])
            const request = index.openCursor(range, 'prev')
            const results: StoredMemory[] = []
            request.onsuccess = event => {
                const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result
                if (cursor && results.length < limit) {
                    results.push(cursor.value as StoredMemory)
                    cursor.continue()
                } else {
                    resolve(results)
                }
            }
            request.onerror = () => reject(new Error(`Failed to get memories: ${request.error?.message}`))
        })
    }

    async getBySubject(subject: MemorySubject, limit: number = 20): Promise<StoredMemory[]> {
        const db = await this.getDB()
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readonly')
            const store = transaction.objectStore(STORE_NAME)
            const index = store.index('valid_subject')
            const range = IDBKeyRange.only([1, subject])
            const request = index.openCursor(range, 'prev')
            const results: StoredMemory[] = []
            request.onsuccess = event => {
                const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result
                if (cursor && results.length < limit) {
                    results.push(cursor.value as StoredMemory)
                    cursor.continue()
                } else {
                    resolve(results)
                }
            }
            request.onerror = () => reject(new Error(`Failed to get memories: ${request.error?.message}`))
        })
    }

    async getMostImportant(limit: number = 10): Promise<StoredMemory[]> {
        const db = await this.getDB()
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readonly')
            const store = transaction.objectStore(STORE_NAME)
            const index = store.index('valid_importance')
            const range = IDBKeyRange.bound([1, 1], [1, 10])
            const request = index.openCursor(range, 'prev')
            const results: StoredMemory[] = []
            request.onsuccess = event => {
                const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result
                if (cursor && results.length < limit) {
                    results.push(cursor.value as StoredMemory)
                    cursor.continue()
                } else {
                    resolve(results)
                }
            }
            request.onerror = () => reject(new Error(`Failed to get memories: ${request.error?.message}`))
        })
    }

    /**
     * Top-N by effective strength rather than raw importance. The right
     * default for "what should the agent always have available."
     */
    async getStrongest(limit: number = 10): Promise<StoredMemory[]> {
        const all = await this.getAllValid()
        const now = Date.now()
        return all
            .map(m => ({ m, s: effectiveStrength(m, now) }))
            .sort((a, b) => b.s - a.s)
            .slice(0, limit)
            .map(x => x.m)
    }

    async getRecent(limit: number = 10): Promise<StoredMemory[]> {
        const db = await this.getDB()
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readonly')
            const store = transaction.objectStore(STORE_NAME)
            const index = store.index('valid_createdAt')
            const range = IDBKeyRange.bound([1, 0], [1, Number.MAX_SAFE_INTEGER])
            const request = index.openCursor(range, 'prev')
            const results: StoredMemory[] = []
            request.onsuccess = event => {
                const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result
                if (cursor && results.length < limit) {
                    results.push(cursor.value as StoredMemory)
                    cursor.continue()
                } else {
                    resolve(results)
                }
            }
            request.onerror = () => reject(new Error(`Failed to get memories: ${request.error?.message}`))
        })
    }

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
                        if (this.indexedMemories.has(id)) this.indexedMemories.set(id, memory)
                        resolve()
                    }
                    putRequest.onerror = () => reject(new Error(`Failed to update memory: ${putRequest.error?.message}`))
                } else {
                    resolve()
                }
            }
            getRequest.onerror = () => reject(new Error(`Failed to get memory: ${getRequest.error?.message}`))
        })
    }

    async delete(id: string): Promise<void> {
        const db = await this.getDB()
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readwrite')
            const store = transaction.objectStore(STORE_NAME)
            const request = store.delete(id)
            request.onsuccess = () => {
                this.removeFromSearchIndex(id)
                resolve()
            }
            request.onerror = () => reject(new Error(`Failed to delete memory: ${request.error?.message}`))
        })
    }

    async invalidate(id: string): Promise<void> {
        return this.delete(id)
    }

    /**
     * Soft-supersede: keep the original memory but mark it superseded. The
     * replacement memory id is stored on the old record. Old memory becomes
     * invalid for retrieval but is retained for audit/history.
     */
    async supersede(oldId: string, newId: string): Promise<void> {
        await this.update(oldId, { isValid: 0, supersededBy: newId })
    }

    async update(
        id: string,
        updates: Partial<Pick<StoredMemory, 'content' | 'importance' | 'confidence' | 'category' | 'subject' | 'isValid' | 'supersededBy' | 'embedding' | 'expiresAt' | 'relatedIds'>>
    ): Promise<StoredMemory | null> {
        const db = await this.getDB()
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readwrite')
            const store = transaction.objectStore(STORE_NAME)
            const getRequest = store.get(id)
            getRequest.onsuccess = () => {
                const memory = getRequest.result as StoredMemory | undefined
                if (!memory) return resolve(null)

                const contentChanged = updates.content !== undefined && updates.content !== memory.content

                if (updates.content !== undefined) memory.content = updates.content
                if (updates.importance !== undefined) memory.importance = clamp(updates.importance, 1, 10)
                if (updates.confidence !== undefined) memory.confidence = clamp(updates.confidence, 1, 10)
                if (updates.category !== undefined) memory.category = updates.category
                if (updates.subject !== undefined) memory.subject = updates.subject
                if (updates.isValid !== undefined) memory.isValid = updates.isValid
                if (updates.supersededBy !== undefined) memory.supersededBy = updates.supersededBy
                if (updates.embedding !== undefined) memory.embedding = updates.embedding
                if (updates.expiresAt !== undefined) memory.expiresAt = updates.expiresAt
                if (updates.relatedIds !== undefined) memory.relatedIds = updates.relatedIds

                const putRequest = store.put(memory)
                putRequest.onsuccess = () => {
                    if (contentChanged && this.searchIndex) {
                        this.searchIndex.remove(id)
                        if (memory.isValid === 1) this.searchIndex.add(id, memory.content)
                    }
                    if (memory.isValid === 1) this.indexedMemories.set(id, memory)
                    else this.indexedMemories.delete(id)
                    resolve(memory)
                }
                putRequest.onerror = () => reject(new Error(`Failed to update memory: ${putRequest.error?.message}`))
            }
            getRequest.onerror = () => reject(new Error(`Failed to get memory: ${getRequest.error?.message}`))
        })
    }

    async getCount(): Promise<number> {
        const db = await this.getDB()
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readonly')
            const store = transaction.objectStore(STORE_NAME)
            const index = store.index('isValid')
            const request = index.count(IDBKeyRange.only(1))
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(new Error(`Failed to count memories: ${request.error?.message}`))
        })
    }

    async getById(id: string): Promise<StoredMemory | null> {
        const db = await this.getDB()
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readonly')
            const store = transaction.objectStore(STORE_NAME)
            const request = store.get(id)
            request.onsuccess = () => resolve((request.result as StoredMemory | undefined) ?? null)
            request.onerror = () => reject(new Error(`Failed to get memory: ${request.error?.message}`))
        })
    }

    async clearAll(): Promise<void> {
        const db = await this.getDB()
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readwrite')
            const store = transaction.objectStore(STORE_NAME)
            const request = store.clear()
            request.onsuccess = () => {
                this.searchIndex = createSearchIndex()
                this.indexedMemories.clear()
                resolve()
            }
            request.onerror = () => reject(new Error(`Failed to clear memories: ${request.error?.message}`))
        })
    }

    async rebuildSearchIndex(): Promise<void> {
        this.indexInitialized = false
        this.indexInitPromise = null
        this.searchIndex = null
        this.indexedMemories.clear()
        await this.initSearchIndex()
    }

    /**
     * Continuous-decay cleanup. Anything below `threshold` strength is
     * permanently dropped. Returns ids that were removed.
     */
    async pruneDecayed(threshold: number = 0.5, dryRun: boolean = false): Promise<{ id: string; content: string; strength: number }[]> {
        const all = await this.getAllValid()
        const now = Date.now()
        const decayed: { id: string; content: string; strength: number }[] = []
        for (const m of all) {
            const s = effectiveStrength(m, now)
            if (s < threshold) decayed.push({ id: m.id, content: m.content, strength: s })
        }
        if (!dryRun) {
            for (const d of decayed) await this.delete(d.id)
        }
        return decayed
    }

    /**
     * Bulk export for backup or transfer.
     */
    async exportAll(): Promise<StoredMemory[]> {
        const db = await this.getDB()
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readonly')
            const store = transaction.objectStore(STORE_NAME)
            const request = store.getAll()
            request.onsuccess = () => resolve((request.result as StoredMemory[]) ?? [])
            request.onerror = () => reject(new Error(`Failed to export: ${request.error?.message}`))
        })
    }

    /**
     * Bulk import. Merges by id; existing rows are overwritten.
     */
    async importMany(memories: StoredMemory[]): Promise<number> {
        const db = await this.getDB()
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readwrite')
            const store = transaction.objectStore(STORE_NAME)
            let count = 0
            for (const m of memories) {
                const req = store.put(m)
                req.onsuccess = () => {
                    count += 1
                }
            }
            transaction.oncomplete = () => {
                this.rebuildSearchIndex().finally(() => resolve(count))
            }
            transaction.onerror = () => reject(new Error(`Import failed: ${transaction.error?.message}`))
        })
    }

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

function clamp(n: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, n))
}

function inferSubjectFromCategory(category: MemoryCategory): MemorySubject {
    if (category === 'fact' || category === 'preference') return 'user'
    if (category === 'event') return 'relationship'
    return 'other'
}

export { chineseTokenizer }
export const memoryStore = new MemoryStore()
