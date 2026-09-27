export const EMOTIONS = ['happy', 'angry', 'sad', 'relaxed', 'surprised'] as const
export type Mood = Record<typeof EMOTIONS[number], number>
export type InteractionState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'interrupted'
export const emptyMood = (): Mood => ({ happy: 0, angry: 0, sad: 0, relaxed: 0.15, surprised: 0 })
export function normalizeMood(value: unknown): Mood {
    const mood = emptyMood()
    if (!value || typeof value !== 'object') return mood
    for (const name of EMOTIONS) {
        const v = (value as Record<string, unknown>)[name]
        mood[name] = typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : mood[name]
    }
    return mood
}
export function advanceMood(previous: Mood, target: Partial<Mood>, elapsedMs: number): Mood {
    const retention = 0.45 * Math.exp(-Math.max(0, elapsedMs) / 3_600_000)
    const next = emptyMood()
    for (const name of EMOTIONS) next[name] = previous[name] * retention + (target[name] ?? 0) * (1 - retention)
    return normalizeMood(next)
}

export function restingMood(previous: Mood, elapsedMs: number): Mood {
    const retention = Math.exp(-Math.max(0, elapsedMs) / 3_600_000)
    const neutral = emptyMood()
    for (const name of EMOTIONS) neutral[name] = previous[name] * retention + neutral[name] * (1 - retention)
    return normalizeMood(neutral)
}
