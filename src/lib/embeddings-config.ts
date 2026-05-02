/**
 * Configuration for the embeddings provider. Optional — when not configured,
 * the memory system falls back to lexical-only search + LLM rerank.
 *
 * The shape is OpenAI-compatible so any provider with a `/v1/embeddings`
 * endpoint can be plugged in (OpenAI, Together, Groq, local Ollama, etc).
 */

export const EMBEDDINGS_STORAGE_KEY = 'demiurge_embeddings_config'

export type StoredEmbeddingsConfig = {
    enabled: boolean
    baseUrl: string // e.g. https://api.openai.com/v1
    apiKey: string
    model: string // e.g. text-embedding-3-small
    dimensions?: number // optional truncation (text-embedding-3 supports this)
}

const isBrowser = () => typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'

export const DEFAULT_EMBEDDINGS_CONFIG: StoredEmbeddingsConfig = {
    enabled: false,
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'text-embedding-3-small',
    dimensions: 512,
}

export const loadEmbeddingsConfig = (): StoredEmbeddingsConfig => {
    if (!isBrowser()) return { ...DEFAULT_EMBEDDINGS_CONFIG }
    const raw = window.localStorage.getItem(EMBEDDINGS_STORAGE_KEY)
    if (!raw) return { ...DEFAULT_EMBEDDINGS_CONFIG }
    try {
        const parsed = JSON.parse(raw) as Partial<StoredEmbeddingsConfig>
        return { ...DEFAULT_EMBEDDINGS_CONFIG, ...parsed }
    } catch {
        return { ...DEFAULT_EMBEDDINGS_CONFIG }
    }
}

export const saveEmbeddingsConfig = (config: StoredEmbeddingsConfig) => {
    if (!isBrowser()) return
    window.localStorage.setItem(EMBEDDINGS_STORAGE_KEY, JSON.stringify(config))
}

export const clearEmbeddingsConfig = () => {
    if (!isBrowser()) return
    window.localStorage.removeItem(EMBEDDINGS_STORAGE_KEY)
}
