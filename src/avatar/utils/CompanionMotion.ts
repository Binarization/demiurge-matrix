import * as THREE from 'three'
import type { VRMHumanBoneName } from '@pixiv/three-vrm'
import type { InteractionState } from '../../lib/interaction'

export const GESTURES = ['small_nod', 'head_shake', 'open_hand', 'wave'] as const
export type Gesture = typeof GESTURES[number]
export function parseGesture(raw: string): Gesture | null {
    const tag = raw.match(/^\s*<emote\b([^>]*)>/i)?.[1]
    const value = tag?.match(/\bgesture\s*=\s*["']?([a-z_]+)["']?/i)?.[1]
    return GESTURES.includes(value as Gesture) ? value as Gesture : null
}

/** Small self-directed movements while nobody is talking: glancing at the scenery, the sky, musing. */
export const IDLE_FIDGETS = ['look_around', 'look_up', 'tilt', 'sigh'] as const
export type IdleFidget = typeof IDLE_FIDGETS[number]
const FIDGET_SECONDS: Record<IdleFidget, number> = { look_around: 5, look_up: 4.5, tilt: 3, sigh: 3.2 }
/** Rise, hold, then settle back: 0 → 1 → 0 over p ∈ [0, 1]. */
const hold = (p: number) => {
    const edge = (x: number) => x * x * (3 - 2 * x)
    return p < 0.25 ? edge(p / 0.25) : p > 0.75 ? edge((1 - p) / 0.25) : 1
}

/** Additive rotations are removed before the animation mixer samples its next frame. */
export class CompanionMotion {
    private offsets = new Map<THREE.Object3D, THREE.Quaternion>()
    private rotations = new Map<VRMHumanBoneName, THREE.Vector3>()
    private time = 0
    private started = -100
    private lastGesture = -100
    private gesture: Gesture | null = null
    private pending: Gesture | null = null
    private pendingAt = 0
    private level = 0
    private idleFor = 0
    private nextFidgetAt = 0
    private fidget: { name: IdleFidget; started: number; side: number } | null = null

    constructor(private readonly random: () => number = Math.random) { this.nextFidgetAt = 14 + random() * 10 }
    get currentFidget() { return this.fidget?.name ?? null }

    request(gesture: Gesture, waitForAudio: boolean) {
        if (this.time - this.lastGesture < 5) return
        if (waitForAudio) { this.pending = gesture; this.pendingAt = this.time }
        else { this.gesture = gesture; this.started = this.time; this.lastGesture = this.time }
    }
    startSpeech() {
        if (this.pending && this.time - this.pendingAt < 30) this.request(this.pending, false)
        this.pending = null
    }
    cancel() { this.pending = null; this.gesture = null; this.fidget = null }
    restore() {
        for (const [node, offset] of this.offsets) node.quaternion.multiply(offset.clone().invert())
        this.offsets.clear()
    }
    reset() { this.restore(); this.cancel(); this.rotations.clear(); this.level = 0 }

    update(delta: number, state: InteractionState, speechLevel: number,
        bone: (name: VRMHumanBoneName) => THREE.Object3D | null, reduced = false) {
        const dt = Math.min(Math.max(delta, 0), 0.05)
        this.time += dt
        if (this.pending && this.time - this.pendingAt >= 30) this.pending = null
        const targets = new Map<VRMHumanBoneName, THREE.Vector3>()
        const add = (name: VRMHumanBoneName, x = 0, y = 0, z = 0) => {
            const v = targets.get(name) ?? new THREE.Vector3()
            v.add(new THREE.Vector3(x, y, z)); targets.set(name, v)
        }
        const t = this.time
        this.level += ((state === 'speaking' ? speechLevel : 0) - this.level) * (1 - Math.exp(-dt * 12))
        if (!reduced) {
            add('chest', Math.sin(t * 1.35) * 0.008)
            add('spine', 0, 0, Math.sin(t * 0.39) * 0.009)
            add('head', this.level * Math.sin(t * 3.2) * 0.035,
                state === 'idle' ? Math.sin(t * 0.31) * 0.025 : 0,
                state === 'listening' ? 0.035 : state === 'thinking' ? -0.035 : 0)
            const age = t - this.started
            const duration = this.gesture === 'wave' ? 2.8 : 2
            if (this.gesture && age < duration) {
                const p = age / duration
                const envelope = Math.sin(Math.PI * p) ** 2
                if (this.gesture === 'small_nod') add('head', Math.sin(p * Math.PI * 2) * envelope * 0.13)
                if (this.gesture === 'head_shake') add('head', 0, Math.sin(p * Math.PI * 4) * envelope * 0.13)
                if (this.gesture === 'open_hand') {
                    add('rightUpperArm', -0.08 * envelope, 0, -0.08 * envelope)
                    add('rightLowerArm', -0.16 * envelope, 0.1 * envelope)
                    add('rightHand', 0, 0, -0.15 * envelope)
                }
                if (this.gesture === 'wave') {
                    add('rightUpperArm', -0.08 * envelope, 0, -0.12 * envelope)
                    add('rightLowerArm', -0.18 * envelope)
                    add('rightHand', 0, Math.sin(age * 9) * envelope * 0.2)
                }
            } else this.gesture = null
            this.updateFidget(dt, state, add)
        } else this.fidget = null

        for (const name of new Set([...targets.keys(), ...this.rotations.keys()])) {
            const value = this.rotations.get(name) ?? new THREE.Vector3()
            value.lerp(targets.get(name) ?? new THREE.Vector3(), 1 - Math.exp(-dt * 9))
            this.rotations.set(name, value)
            const node = bone(name)
            if (!node) continue
            const offset = new THREE.Quaternion().setFromEuler(new THREE.Euler(value.x, value.y, value.z))
            node.quaternion.multiply(offset)
            this.offsets.set(node, offset)
        }
    }

    private updateFidget(dt: number, state: InteractionState, add: (name: VRMHumanBoneName, x?: number, y?: number, z?: number) => void) {
        if (state !== 'idle' || this.gesture) {
            this.fidget = null
            this.idleFor = 0
            this.nextFidgetAt = 14 + this.random() * 10
            return
        }
        this.idleFor += dt
        if (!this.fidget && this.idleFor >= this.nextFidgetAt) {
            const name = IDLE_FIDGETS[Math.floor(this.random() * IDLE_FIDGETS.length)]!
            this.fidget = { name, started: this.time, side: this.random() < 0.5 ? -1 : 1 }
            this.nextFidgetAt = this.idleFor + FIDGET_SECONDS[name] + 16 + this.random() * 26
        }
        const f = this.fidget
        if (!f) return
        const p = (this.time - f.started) / FIDGET_SECONDS[f.name]
        if (p >= 1) { this.fidget = null; return }
        const e = hold(p)
        if (f.name === 'look_around') {
            add('head', 0.02 * e, f.side * 0.3 * e)
            add('neck', 0, f.side * 0.16 * e)
            add('spine', 0, f.side * 0.05 * e)
        } else if (f.name === 'look_up') {
            add('head', -0.2 * e)
            add('neck', -0.08 * e)
        } else if (f.name === 'tilt') {
            add('head', 0, f.side * 0.05 * e, f.side * 0.13 * e)
        } else {
            const breath = Math.sin(Math.PI * p)
            add('chest', -0.05 * breath)
            add('spine', -0.02 * breath)
            add('head', p > 0.5 ? 0.05 * Math.sin(Math.PI * (p - 0.5) * 2) : 0)
        }
    }
}
