export const OPENROUTER_STORAGE_KEY = 'demiurge_openrouter_config'

export type StoredOpenRouterConfig = {
    apiKey: string
    model?: string
}

const isBrowser = () => typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'

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
        return parsed && typeof parsed.apiKey === 'string' ? parsed : null
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
