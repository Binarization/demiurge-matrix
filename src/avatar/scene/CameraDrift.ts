/**
 * A barely-there handheld drift on the idle camera so the frame breathes
 * instead of sitting dead still. The offset is added after the controls have
 * placed the camera and removed again before they run next frame, so orbit
 * state never absorbs it. It eases in and out rather than snapping.
 */
import * as THREE from 'three'

export const CAMERA_DRIFT = {
    /** Metres of sway; a centimetre at three metres is felt, not seen. */
    amplitude: [0.012, 0.008, 0.006] as const,
    /** Seconds per cycle per axis, deliberately incommensurate. */
    periods: [9.1, 6.3, 13.0] as const,
    /** Faster secondary tremor on x, much smaller. */
    tremor: { amplitude: 0.0025, period: 3.7 },
    /** Seconds to ease fully in or out. */
    ease: 1.5,
}

export class CameraDrift {
    private time = 0
    private amount = 0
    private readonly applied = new THREE.Vector3()
    constructor(private readonly camera: THREE.Object3D) {}

    /** Current ease level, 0 (off) to 1 (full drift). */
    get level() { return this.amount }

    /** Pure offset for a given time and ease level. */
    static offset(time: number, amount: number, out = new THREE.Vector3()): THREE.Vector3 {
        const { amplitude, periods, tremor } = CAMERA_DRIFT
        const wave = (i: 0 | 1 | 2) => Math.sin((2 * Math.PI * time) / periods[i]) * amplitude[i]
        return out.set(
            wave(0) + Math.sin((2 * Math.PI * time) / tremor.period) * tremor.amplitude,
            wave(1),
            wave(2)
        ).multiplyScalar(amount)
    }

    /** Remove last frame's offset. Call before the controls update. */
    restore() {
        this.camera.position.sub(this.applied)
        this.applied.set(0, 0, 0)
    }

    /** Add this frame's offset; `enabled` false eases the drift out. */
    apply(delta: number, enabled: boolean) {
        const dt = Math.min(Math.max(delta, 0), 0.05)
        this.time += dt
        this.amount += ((enabled ? 1 : 0) - this.amount) * (1 - Math.exp(-dt / (CAMERA_DRIFT.ease / 3)))
        if (this.amount < 1e-3) { this.amount = 0; return }
        CameraDrift.offset(this.time, this.amount, this.applied)
        this.camera.position.add(this.applied)
    }
}
