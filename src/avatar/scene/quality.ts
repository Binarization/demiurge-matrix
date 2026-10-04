/**
 * Render quality ladder. The background (splat + sky) is drawn into a render
 * target only when the camera moves, so its resolution is the cheap knob; the
 * device pixel ratio is the expensive one. Instead of one hard jump to a
 * quarter-resolution background, quality steps down a tier at a time when the
 * frame rate stays low, and climbs back slowly once it has been stable.
 */
export type QualityTier = {
    name: 'full' | 'high' | 'medium' | 'low'
    /** Upper bound on the device pixel ratio passed to the renderer. */
    pixelRatioCap: number
    /** Background render target size relative to the capped full resolution. */
    backgroundScale: number
}

export const QUALITY_LADDER: readonly QualityTier[] = [
    { name: 'full', pixelRatioCap: 2, backgroundScale: 1 },
    { name: 'high', pixelRatioCap: 1.5, backgroundScale: 0.75 },
    { name: 'medium', pixelRatioCap: 1.5, backgroundScale: 0.5 },
    { name: 'low', pixelRatioCap: 1, backgroundScale: 0.25 },
]

export const QUALITY_RULES = {
    /** Frame rate below this counts as a slow second. */
    slowFps: 50,
    /** Consecutive slow seconds before stepping down. */
    slowSeconds: 5,
    /** Frame rate at or above this counts as a comfortable second. */
    fastFps: 58,
    /** Consecutive comfortable seconds before stepping back up. */
    fastSeconds: 20,
    /** After a step down, no step up for this long. */
    holdAfterDropMs: 30_000,
}

export function pixelRatioFor(tier: QualityTier, devicePixelRatio: number): number {
    return Math.max(0.5, Math.min(devicePixelRatio || 1, tier.pixelRatioCap))
}

export function backgroundSize(tier: QualityTier, width: number, height: number, devicePixelRatio: number): { width: number; height: number } {
    const ratio = pixelRatioFor(tier, devicePixelRatio) * tier.backgroundScale
    return { width: Math.max(1, Math.floor(width * ratio)), height: Math.max(1, Math.floor(height * ratio)) }
}

/** Feeds once-per-second frame rates; returns the new level when it changes. */
export class QualityGovernor {
    private slowRun = 0
    private fastRun = 0
    private droppedAt = -Infinity
    constructor(public level = 0) {
        this.level = Math.max(0, Math.min(QUALITY_LADDER.length - 1, Math.floor(level)))
    }
    get tier(): QualityTier { return QUALITY_LADDER[this.level]! }
    sample(fps: number, now: number): number | null {
        if (fps < QUALITY_RULES.slowFps) {
            this.slowRun++
            this.fastRun = 0
            if (this.slowRun >= QUALITY_RULES.slowSeconds && this.level < QUALITY_LADDER.length - 1) {
                this.level++
                this.slowRun = 0
                this.droppedAt = now
                return this.level
            }
            return null
        }
        this.slowRun = 0
        if (fps >= QUALITY_RULES.fastFps) {
            this.fastRun++
            if (this.fastRun >= QUALITY_RULES.fastSeconds && this.level > 0 && now - this.droppedAt >= QUALITY_RULES.holdAfterDropMs) {
                this.level--
                this.fastRun = 0
                return this.level
            }
        } else this.fastRun = 0
        return null
    }
}

const STORAGE_KEY = 'low_performance_device'

/** Level to start at for this GPU; the legacy flag (bare renderer string) maps to the lowest tier. */
export function rememberedQualityLevel(storage: Pick<Storage, 'getItem'>, rendererInfo: string | null): number {
    if (!rendererInfo) return 0
    try {
        const raw = storage.getItem(STORAGE_KEY)
        if (!raw) return 0
        if (raw === rendererInfo) return QUALITY_LADDER.length - 1
        const parsed = JSON.parse(raw) as { renderer?: unknown; level?: unknown }
        if (parsed?.renderer !== rendererInfo || typeof parsed.level !== 'number') return 0
        return Math.max(0, Math.min(QUALITY_LADDER.length - 1, Math.floor(parsed.level)))
    } catch {
        return 0
    }
}

export function rememberQualityLevel(storage: Pick<Storage, 'setItem' | 'removeItem'>, rendererInfo: string | null, level: number): void {
    if (!rendererInfo) return
    try {
        if (level <= 0) storage.removeItem(STORAGE_KEY)
        else storage.setItem(STORAGE_KEY, JSON.stringify({ renderer: rendererInfo, level }))
    } catch {
        // Private mode or quota: the next visit just re-measures.
    }
}
