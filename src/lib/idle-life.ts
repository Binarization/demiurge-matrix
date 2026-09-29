/**
 * What Cyrene does with her body when the partner has gone quiet: an
 * occasional stretch, a rest on the bench, getting up and wandering back.
 * Pure decision logic; Core.vue supplies the state and runs the action quietly.
 */
import type { BodyAction } from '../avatar/scene/BodyDirector'

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
