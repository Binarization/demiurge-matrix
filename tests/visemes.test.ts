import { expect, test } from 'bun:test'
import { bandEnergies, silentVisemes, visemesFromBands, VISEME_GATE } from '../src/lib/voice/visemes'

const dominant = (w: Record<string, number>) => Object.entries(w).sort((a, b) => b[1] - a[1])[0]![0]

test('band shares pick the shape: open low, rounded mid, spread high, closed when quiet', () => {
    expect(dominant(visemesFromBands({ low: 0.7, mid: 0.2, high: 0.1 }, 0.6))).toBe('aa')
    expect(dominant(visemesFromBands({ low: 0.15, mid: 0.7, high: 0.15 }, 0.6))).toBe('ou')
    expect(dominant(visemesFromBands({ low: 0.1, mid: 0.2, high: 0.7 }, 0.6))).toBe('ih')
    const rounded = visemesFromBands({ low: 0.45, mid: 0.45, high: 0.1 }, 0.6)
    expect(rounded.oh).toBeGreaterThan(0.1)
    expect(rounded.ih).toBe(0)
    expect(visemesFromBands({ low: 1, mid: 0, high: 0 }, VISEME_GATE / 2)).toEqual(silentVisemes())
    expect(visemesFromBands({ low: 0, mid: 0, high: 0 }, 0.5)).toEqual({ ...silentVisemes(), aa: 0.5 })
})

test('weights never exceed the opening level, so loudness still rules how far the mouth opens', () => {
    for (const bands of [{ low: 1, mid: 1, high: 1 }, { low: 3, mid: 1, high: 0.2 }, { low: 0.2, mid: 1, high: 3 }]) {
        const w = visemesFromBands(bands, 0.7)
        expect(w.aa + w.ih + w.ou + w.ee + w.oh).toBeLessThanOrEqual(0.7 + 1e-9)
        expect(Math.max(w.aa, w.ih, w.ou, w.ee, w.oh)).toBeGreaterThan(0.2)
    }
})

test('band energies come from the right spectrum bins and ignore silent bins', () => {
    const sampleRate = 44100, fftSize = 1024, binHz = sampleRate / fftSize
    const spectrum = new Float32Array(fftSize / 2).fill(-Infinity)
    spectrum[Math.round(300 / binHz)] = 0 // 0 dB = amplitude 1 in the low band
    spectrum[Math.round(3000 / binHz)] = -20 // 0.1 in the high band
    const bands = bandEnergies(spectrum, sampleRate, fftSize)
    expect(bands.low).toBeGreaterThan(bands.high)
    expect(bands.high).toBeGreaterThan(0)
    expect(bands.mid).toBe(0)
})
