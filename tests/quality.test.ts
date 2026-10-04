import { expect, test } from 'bun:test'
import { backgroundSize, pixelRatioFor, QUALITY_LADDER, QUALITY_RULES, QualityGovernor, rememberedQualityLevel, rememberQualityLevel } from '../src/avatar/scene/quality'

test('pixel ratio is capped per tier and the background shrinks with it', () => {
    expect(pixelRatioFor(QUALITY_LADDER[0]!, 3)).toBe(2)
    expect(pixelRatioFor(QUALITY_LADDER[0]!, 1)).toBe(1)
    expect(pixelRatioFor(QUALITY_LADDER[3]!, 3)).toBe(1)
    expect(backgroundSize(QUALITY_LADDER[0]!, 1000, 500, 3)).toEqual({ width: 2000, height: 1000 })
    expect(backgroundSize(QUALITY_LADDER[2]!, 1000, 500, 2)).toEqual({ width: 750, height: 375 })
    expect(backgroundSize(QUALITY_LADDER[3]!, 1000, 500, 2)).toEqual({ width: 250, height: 125 })
})

test('quality steps down one tier after sustained slow seconds and climbs back only after a long stable hold', () => {
    const governor = new QualityGovernor()
    let t = 0
    const feed = (fps: number, seconds: number) => {
        const changes: number[] = []
        for (let i = 0; i < seconds; i++) { t += 1000; const level = governor.sample(fps, t); if (level !== null) changes.push(level) }
        return changes
    }
    expect(feed(30, QUALITY_RULES.slowSeconds - 1)).toEqual([])
    expect(feed(60, 1)).toEqual([]) // one good second resets the slow run
    expect(feed(30, QUALITY_RULES.slowSeconds)).toEqual([1])
    expect(feed(30, QUALITY_RULES.slowSeconds * 3)).toEqual([2, 3])
    expect(governor.tier.name).toBe('low')
    // Fast frames right after the drop don't raise quality during the hold.
    expect(feed(60, QUALITY_RULES.fastSeconds)).toEqual([])
    t += QUALITY_RULES.holdAfterDropMs
    expect(feed(60, QUALITY_RULES.fastSeconds)).toEqual([2])
    expect(feed(55, 5)).toEqual([]) // in-between frame rates neither drop nor raise
    expect(feed(60, QUALITY_RULES.fastSeconds)).toEqual([1])
})

test('the remembered level survives reload, honours the legacy flag and clears at full quality', () => {
    const map = new Map<string, string>()
    const storage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v) }, removeItem: (k: string) => { map.delete(k) } }
    rememberQualityLevel(storage, 'gpu-a', 2)
    expect(rememberedQualityLevel(storage, 'gpu-a')).toBe(2)
    expect(rememberedQualityLevel(storage, 'gpu-b')).toBe(0)
    rememberQualityLevel(storage, 'gpu-a', 0)
    expect(rememberedQualityLevel(storage, 'gpu-a')).toBe(0)
    map.set('low_performance_device', 'gpu-a')
    expect(rememberedQualityLevel(storage, 'gpu-a')).toBe(QUALITY_LADDER.length - 1)
    expect(rememberedQualityLevel(storage, null)).toBe(0)
})
