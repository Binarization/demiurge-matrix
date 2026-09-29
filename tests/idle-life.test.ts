import { expect, test } from 'bun:test'
import { IDLE_LIFE, nextIdleBodyAction, type IdleBodyState } from '../src/lib/idle-life'

const MIN = 60_000
const base = (patch: Partial<IdleBodyState> = {}): IdleBodyState => ({
    now: 60 * MIN, lastActivityAt: 60 * MIN, lastBodyAt: 0, lastBodyAction: null, seated: false,
    seatedSince: null, distanceFromHome: 0, cameraView: 'companion', reducedMotion: false, ...patch,
})
const always = () => 0

test('she keeps still while the partner is active, then stretches after a quiet spell', () => {
    expect(nextIdleBodyAction(base({ lastActivityAt: 59 * MIN }), always)).toBeNull()
    expect(nextIdleBodyAction(base({ lastActivityAt: 57 * MIN }), always)).toBe('stretch')
    expect(nextIdleBodyAction(base({ lastActivityAt: 57 * MIN, lastBodyAt: 58 * MIN }), always)).toBeNull()
    expect(nextIdleBodyAction(base({ lastActivityAt: 50 * MIN, reducedMotion: true }), always)).toBeNull()
})

test('longer quiet leads to the bench, then standing up and walking back home', () => {
    expect(nextIdleBodyAction(base({ lastActivityAt: 50 * MIN }), always)).toBe('sit')
    expect(nextIdleBodyAction(base({ lastActivityAt: 50 * MIN }), () => 0.9)).toBe('stretch')
    expect(nextIdleBodyAction(base({ lastActivityAt: 50 * MIN, cameraView: 'close' }), always)).toBe('stretch')
    const seated = base({ lastActivityAt: 40 * MIN, seated: true, seatedSince: 57 * MIN, lastBodyAt: 50 * MIN })
    expect(nextIdleBodyAction(seated, always)).toBeNull()
    expect(nextIdleBodyAction({ ...seated, seatedSince: 50 * MIN }, always)).toBe('stand')
    const stood = base({ lastActivityAt: 40 * MIN, lastBodyAction: 'stand', distanceFromHome: 1.05, lastBodyAt: 60 * MIN - 5_000 })
    expect(nextIdleBodyAction(stood, always)).toBeNull()
    expect(nextIdleBodyAction({ ...stood, lastBodyAt: 60 * MIN - IDLE_LIFE.returnAfterStandMs }, always)).toBe('return')
    expect(nextIdleBodyAction(base({ lastActivityAt: 50 * MIN, distanceFromHome: 0.8 }), always)).toBe('return')
})
