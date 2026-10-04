export const OPENROUTER_STORAGE_KEY = 'demiurge_openrouter_config'

export type StoredOpenRouterConfig = {
    apiKey: string
    model?: string
    /** Fast model for tool planning, memory rerank, reflection and summaries. */
    auxiliaryModel?: string
}

const isBrowser = () => typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'

// Fingerprint only, used to remove the shared credential persisted by older
// releases. This is a migration identifier, not a security/validation hash.
const isLegacySharedKey = (key: string): boolean => {
    let hash = 2166136261
    for (const char of key) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
    return key.length === 73 && (hash >>> 0) === 2331280947
}

export const loadStoredOpenRouterConfig = (): StoredOpenRouterConfig | null => {
    if (!isBrowser()) {
        return null
    }
    const raw = window.localStorage.getItem(OPENROUTER_STORAGE_KEY)
    if (!raw) {
        return null
    }
    try {
        const parsed = JSON.parse(raw) as StoredOpenRouterConfig
        if (!parsed || typeof parsed.apiKey !== 'string') return null
        if (isLegacySharedKey(parsed.apiKey)) {
            window.localStorage.removeItem(OPENROUTER_STORAGE_KEY)
            return null
        }
        return parsed
    } catch (error) {
        console.warn('Failed to parse OpenRouter config from storage', error)
        return null
    }
}

export const saveStoredOpenRouterConfig = (config: StoredOpenRouterConfig) => {
    if (!isBrowser()) {
        return
    }
    window.localStorage.setItem(OPENROUTER_STORAGE_KEY, JSON.stringify(config))
}

export const clearStoredOpenRouterConfig = () => {
    if (!isBrowser()) {
        return
    }
    window.localStorage.removeItem(OPENROUTER_STORAGE_KEY)
}
