import * as THREE from 'three'
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js'
export type CameraView = 'companion' | 'full' | 'close'
export class CameraDirector {
    private tween: { from: THREE.Vector3; fromTarget: THREE.Vector3; to: THREE.Vector3; target: THREE.Vector3; time: number } | null = null
    private revision = 0
    private restoreView: { view: CameraView; revision: number } | null = null
    view: CameraView = 'companion'
    constructor(private camera: THREE.PerspectiveCamera, private controls: OrbitControls) {}
    get active() { return this.tween !== null }
    manual() { this.tween = null; this.restoreView = null; this.revision++ }
    select(view: CameraView, origin: THREE.Vector3, reduced = false, user = true) {
        if (user) { this.revision++; this.restoreView = null }
        this.view = view
        const target = origin.clone().add(new THREE.Vector3(0, view === 'close' ? 1.16 : view === 'full' ? 0.6 : 1.0, 0))
        const distance = view === 'full' ? 4.8 : view === 'close' ? 2.05 : 3.05
        const fit = Math.max(1, 0.75 / this.camera.aspect)
        const to = target.clone().add(new THREE.Vector3(0.12, 0.04, distance * fit))
        if (reduced) {
            this.camera.position.copy(to); this.controls.target.copy(target); this.controls.update(); this.tween = null
        } else this.tween = { from: this.camera.position.clone(), fromTarget: this.controls.target.clone(), to, target, time: 0 }
    }
    beginAction(origin: THREE.Vector3, reduced: boolean) {
        if (!this.restoreView) this.restoreView = { view: this.view, revision: this.revision }
        this.select('full', origin, reduced, false)
    }
    /** Remember the view without reframing; endAction then recenters gently unless the user took over. */
    holdView() {
        if (!this.restoreView) this.restoreView = { view: this.view, revision: this.revision }
    }
    endAction(origin: THREE.Vector3, reduced: boolean) {
        const restore = this.restoreView; this.restoreView = null
        if (restore && restore.revision === this.revision) this.select(restore.view, origin, reduced, false)
    }
    update(delta: number) {
        const t = this.tween
        if (!t) return
        t.time += Math.min(delta, 0.05)
        const x = Math.min(1, t.time / 1.25), k = x * x * (3 - 2 * x)
        this.camera.position.lerpVectors(t.from, t.to, k)
        this.controls.target.lerpVectors(t.fromTarget, t.target, k)
        this.controls.update()
        if (x === 1) this.tween = null
    }
}
