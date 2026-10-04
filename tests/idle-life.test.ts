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

import { IDLE_RECALL, pickMemoryToRecall, recallEventLabel, shouldRecallMemory } from '../src/lib/idle-life'

const HOUR = 60 * MIN
const recallState = (patch = {}) => ({ now: 60 * MIN, lastActivityAt: 50 * MIN, lastRecallAt: 0, lastBodyAt: 0, bodyBusy: false, ...patch })
const memory = (id: string, patch: any = {}) => ({
    id, content: `记忆${id}`, subject: 'user', importance: 6, createdAt: 0, lastAccessedAt: 0, isValid: 1, accessCount: 0, category: 'fact', confidence: 7, ...patch,
})

test('she drifts into a memory only after a quiet spell, spaced out from other beats', () => {
    expect(shouldRecallMemory(recallState())).toBe(true)
    expect(shouldRecallMemory(recallState({ lastActivityAt: 58 * MIN }))).toBe(false)
    expect(shouldRecallMemory(recallState({ lastRecallAt: 55 * MIN }))).toBe(false)
    expect(shouldRecallMemory(recallState({ lastRecallAt: 60 * MIN - IDLE_RECALL.cooldownMs }))).toBe(true)
    expect(shouldRecallMemory(recallState({ lastBodyAt: 60 * MIN - 10_000 }))).toBe(false)
    expect(shouldRecallMemory(recallState({ bodyBusy: true }))).toBe(false)
})

test('she recalls things about the partner or herself that she has not touched for a while', () => {
    const now = 3 * 24 * HOUR
    const memories = [
        memory('fresh', { lastAccessedAt: now - HOUR }),
        memory('today', { createdAt: now - HOUR }),
        memory('world', { subject: 'world' }),
        memory('trivial', { importance: 2 }),
        memory('gone', { isValid: 0 }),
        memory('ok', { subject: 'relationship' }),
        memory('own', { subject: 'character', importance: 5 }),
    ]
    const picked = new Set<string>()
    for (let i = 0; i < 40; i++) picked.add(pickMemoryToRecall(memories, now, () => i / 40)!.id)
    expect([...picked].sort()).toEqual(['ok', 'own'])
    expect(pickMemoryToRecall([memory('fresh', { lastAccessedAt: now - HOUR })], now)).toBeNull()
    expect(recallEventLabel('  伙伴 喜欢  星星 ')).toBe('自己想起了：伙伴 喜欢 星星')
    expect(recallEventLabel('一'.repeat(50))).toHaveLength(46)
})
