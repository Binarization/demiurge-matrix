import { describe, expect, test } from 'bun:test'
import { expandBert, readStyle, normalizePcm } from '../src/lib/voice/data'

describe('local voice data contract', () => {
    test('aligns token features to channels-first phone frames', () => {
        const hidden = new Float32Array(2048)
        hidden.fill(2, 0, 1024)
        hidden.fill(7, 1024)
        const expanded = expandBert(hidden, [2, 1], 3)
        expect(Array.from(expanded.slice(0, 6))).toEqual([2, 2, 7, 2, 2, 7])
        expect(() => expandBert(hidden, [1, 1], 3)).toThrow()
    })
    test('rejects invalid audio before playback', () => {
        expect(() => normalizePcm(new Float32Array([NaN]))).toThrow()
        expect(() => normalizePcm(new Float32Array())).toThrow()
        expect(Array.from(normalizePcm(new Float32Array([0, 0])))).toEqual([0, 0])
    })
    test('requires a single finite little-endian float style', () => {
        expect(() => readStyle(new ArrayBuffer(20))).toThrow()
    })
})
