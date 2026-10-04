/**
 * What Cyrene does with her body when the partner has gone quiet: an
 * occasional stretch, a rest on the bench, getting up and wandering back.
 * Pure decision logic; Core.vue supplies the state and runs the action quietly.
 */
import type { BodyAction } from '../avatar/scene/BodyDirector'
import { effectiveStrength, type StoredMemory } from './memory-store'

const MIN = 60_000
export const IDLE_LIFE = {
    /** Silence before the first self-initiated body action. */
    firstAfterMs: 2.5 * MIN,
    /** Minimum gap between self-initiated actions. */
    cooldownMs: 3 * MIN,
    /** Silence before she may go and sit down. */
    sitAfterMs: 5 * MIN,
    /** Time seated before she may get up by herself. */
    standAfterSeatedMs: 6 * MIN,
    /** After standing up, walking back follows shortly. */
    returnAfterStandMs: 15_000,
}

export type IdleBodyState = {
    now: number
    lastActivityAt: number
    lastBodyAt: number
    lastBodyAction: BodyAction | null
    seated: boolean
    seatedSince: number | null
    distanceFromHome: number
    cameraView?: string
    reducedMotion: boolean
}

export function nextIdleBodyAction(state: IdleBodyState, random: () => number = Math.random): BodyAction | null {
    if (state.reducedMotion) return null
    const quietFor = state.now - state.lastActivityAt
    const sinceBody = state.now - state.lastBodyAt
    if (quietFor < IDLE_LIFE.firstAfterMs) return null
    if (state.lastBodyAction === 'stand' && !state.seated && state.distanceFromHome > 0.3)
        return sinceBody >= IDLE_LIFE.returnAfterStandMs ? 'return' : null
    if (sinceBody < IDLE_LIFE.cooldownMs) return null
    if (state.seated)
        return state.seatedSince !== null && state.now - state.seatedSince >= IDLE_LIFE.standAfterSeatedMs ? 'stand' : null
    if (state.distanceFromHome > 0.3) return 'return'
    // In the close-up she would walk out of frame; stay in place there.
    return quietFor >= IDLE_LIFE.sitAfterMs && state.cameraView !== 'close' && random() < 0.5 ? 'sit' : 'stretch'
}

/**
 * Rehearsal: while the partner is quiet she sometimes dwells on a memory.
 * The memory is really touched (access recorded) and a "自己想起了…" scene
 * event is logged, so anything she later brings up actually happened here.
 */
const HOUR = 60 * MIN
export const IDLE_RECALL = {
    /** Silence before she may drift off into a memory. */
    afterQuietMs: 4 * MIN,
    /** Minimum gap between two rehearsals. */
    cooldownMs: 9 * MIN,
    /** Keep a little distance from body actions so the two don't read as one beat. */
    bodyGapMs: 30_000,
    /** Only memories she hasn't touched for this long are worth dwelling on. */
    untouchedForMs: 12 * HOUR,
    /** Memories younger than this are still "today", not something to recall. */
    minAgeMs: 2 * HOUR,
}

export type IdleRecallState = {
    now: number
    lastActivityAt: number
    lastRecallAt: number
    lastBodyAt: number
    bodyBusy: boolean
}

export function shouldRecallMemory(state: IdleRecallState): boolean {
    if (state.bodyBusy) return false
    if (state.now - state.lastActivityAt < IDLE_RECALL.afterQuietMs) return false
    if (state.now - state.lastRecallAt < IDLE_RECALL.cooldownMs) return false
    return state.now - state.lastBodyAt >= IDLE_RECALL.bodyGapMs
}

type RecallCandidate = Pick<StoredMemory, 'id' | 'content' | 'subject' | 'category' | 'importance' | 'confidence' | 'createdAt' | 'lastAccessedAt' | 'accessCount' | 'isValid'> & Partial<Pick<StoredMemory, 'expiresAt'>>

/**
 * Pick something about the partner, the two of them or herself that she
 * hasn't thought about for a while; stronger memories are favoured but the
 * choice stays a little random so she doesn't dwell on the same thing.
 */
export function pickMemoryToRecall<T extends RecallCandidate>(memories: T[], now: number, random: () => number = Math.random): T | null {
    const candidates = memories
        .filter(m => m.isValid === 1 && ['user', 'relationship', 'character'].includes(m.subject) && m.importance >= 4)
        .filter(m => now - m.createdAt >= IDLE_RECALL.minAgeMs && now - m.lastAccessedAt >= IDLE_RECALL.untouchedForMs)
        .map(m => ({ m, weight: effectiveStrength(m as RecallCandidate as StoredMemory, now) + 0.1 }))
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 8)
    if (!candidates.length) return null
    const total = candidates.reduce((sum, item) => sum + item.weight, 0)
    let roll = random() * total
    for (const item of candidates) {
        roll -= item.weight
        if (roll <= 0) return item.m
    }
    return candidates[candidates.length - 1]!.m
}

/** Scene-event label for a rehearsal; keeps the transcript short and honest. */
export function recallEventLabel(content: string): string {
    const clean = content.replace(/\s+/g, ' ').trim()
    return `自己想起了：${clean.length > 40 ? clean.slice(0, 39) + '…' : clean}`
}
