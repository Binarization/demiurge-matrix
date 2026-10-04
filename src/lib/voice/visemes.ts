/**
 * Mouth shapes from the sound itself. Not phoneme alignment: the synthesized
 * PCM is split into three bands roughly following vowel formants, and the
 * share of energy in each picks the VRM viseme blend. Open vowels carry most
 * energy low, front vowels and fricatives push it high, rounded vowels sit in
 * the middle. Good enough to make "a", "i" and "u" look different; still not
 * exact lip reading, and the docs say so.
 */
export type VisemeWeights = { aa: number; ih: number; ou: number; ee: number; oh: number }
export type BandEnergies = { low: number; mid: number; high: number }

/** Hz ranges that roughly separate open, rounded and front vowels. */
export const VISEME_BANDS = { low: [90, 500], mid: [500, 1800], high: [1800, 5200] } as const

/** Speech below this level keeps the mouth closed instead of twitching on noise. */
export const VISEME_GATE = 0.05

export const silentVisemes = (): VisemeWeights => ({ aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 })

const clamp01 = (x: number) => Math.max(0, Math.min(1, x))

/**
 * Mean linear amplitude per band from an AnalyserNode spectrum in dB
 * (`getFloatFrequencyData`). `fftSize` is the analyser's fftSize, so the
 * spectrum has `fftSize / 2` bins of `sampleRate / fftSize` Hz each.
 */
export function bandEnergies(spectrumDb: ArrayLike<number>, sampleRate: number, fftSize: number): BandEnergies {
    const binHz = sampleRate / fftSize
    const mean = (range: readonly [number, number]) => {
        const from = Math.max(0, Math.floor(range[0] / binHz))
        const to = Math.min(spectrumDb.length - 1, Math.ceil(range[1] / binHz))
        if (to < from) return 0
        let sum = 0
        for (let i = from; i <= to; i++) {
            const db = spectrumDb[i]!
            sum += Number.isFinite(db) ? 10 ** (db / 20) : 0
        }
        return sum / (to - from + 1)
    }
    return { low: mean(VISEME_BANDS.low), mid: mean(VISEME_BANDS.mid), high: mean(VISEME_BANDS.high) }
}

/**
 * Blend weights for the five VRM visemes. `level` is the overall mouth
 * opening (0–1, from PCM energy); the band shares only decide the shape.
 * Weights sum to at most `level`; when the shares are inconclusive the mouth
 * simply opens on `aa`, which is what the old energy-only path did.
 */
export function visemesFromBands(bands: BandEnergies, level: number): VisemeWeights {
    const opening = clamp01(level)
    if (opening < VISEME_GATE) return silentVisemes()
    const total = bands.low + bands.mid + bands.high
    if (!(total > 0)) return { ...silentVisemes(), aa: opening }
    const low = bands.low / total, mid = bands.mid / total, high = bands.high / total
    const ih = clamp01((high - 0.2) / 0.4)
    const shape = {
        aa: clamp01((low - 0.25) / 0.45) * (1 - 0.6 * ih),
        ih,
        ou: clamp01((mid - 0.35) / 0.4) * (1 - ih),
        ee: clamp01(Math.min(mid, high) * 2.5 - 0.4),
        oh: clamp01(Math.min(low, mid) * 2.5 - 0.4) * (1 - ih),
    }
    const sum = shape.aa + shape.ih + shape.ou + shape.ee + shape.oh
    if (sum <= 0) return { ...silentVisemes(), aa: opening }
    const scale = opening / Math.max(1, sum)
    return { aa: shape.aa * scale, ih: shape.ih * scale, ou: shape.ou * scale, ee: shape.ee * scale, oh: shape.oh * scale }
}
