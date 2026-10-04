import { expect, test } from 'bun:test'
import * as THREE from 'three'
import { CAMERA_DRIFT, CameraDrift } from '../src/avatar/scene/CameraDrift'

test('the drift is tiny, zero-mean and fully removed by restore', () => {
    const camera = new THREE.Object3D()
    camera.position.set(0, 3, 11)
    const drift = new CameraDrift(camera)
    const mean = new THREE.Vector3()
    let maxOffset = 0
    for (let i = 0; i < 60 * 60; i++) {
        drift.restore()
        expect(camera.position.x).toBe(0)
        expect(camera.position.y).toBe(3)
        drift.apply(1 / 60, true)
        const offset = camera.position.clone().sub(new THREE.Vector3(0, 3, 11))
        maxOffset = Math.max(maxOffset, offset.length())
        if (i > 60 * 5) mean.add(offset)
    }
    expect(drift.level).toBeGreaterThan(0.99)
    expect(maxOffset).toBeLessThan(0.03)
    expect(maxOffset).toBeGreaterThan(0.01)
    expect(mean.divideScalar(60 * 55).length()).toBeLessThan(0.002)
})

test('disabling eases the drift out within a couple of seconds and leaves the camera untouched', () => {
    const camera = new THREE.Object3D()
    const drift = new CameraDrift(camera)
    for (let i = 0; i < 60 * 4; i++) { drift.restore(); drift.apply(1 / 60, true) }
    for (let i = 0; i < 60 * 3; i++) { drift.restore(); drift.apply(1 / 60, false) }
    expect(drift.level).toBe(0)
    expect(camera.position.length()).toBe(0)
    expect(CameraDrift.offset(0, 1).length()).toBe(0)
    expect(CameraDrift.offset(CAMERA_DRIFT.periods[0] / 4, 1).x).toBeGreaterThan(0.005)
})
