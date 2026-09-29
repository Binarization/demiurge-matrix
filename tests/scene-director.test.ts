import { expect, test } from 'bun:test'
import * as THREE from 'three'
import { canStand, pathIsClear, FLOOR_Y, HOME, SEAT } from '../src/avatar/scene/layout'
import { solveLimb } from '../src/avatar/scene/ik'
import { parseSceneCue } from '../src/avatar/scene/commands'
import { CameraDirector } from '../src/avatar/scene/CameraDirector'

test('walk paths cannot cross seat, borders, or non-finite coordinates', () => {
    expect(canStand(HOME)).toBe(true)
    expect(canStand(SEAT)).toBe(false)
    expect(pathIsClear(HOME, SEAT)).toBe(false)
    expect(pathIsClear(HOME, SEAT, true)).toBe(true)
    expect(pathIsClear(HOME, new THREE.Vector3(-1, FLOOR_Y, 8.65))).toBe(true)
    expect(pathIsClear(HOME, new THREE.Vector3(10, FLOOR_Y, 8))).toBe(false)
    expect(canStand(new THREE.Vector3(NaN, 0, 0))).toBe(false)
})
test('two-bone IK reaches a target, preserves lengths, and clamps unreachable targets', () => {
    const root = new THREE.Object3D(), upper = new THREE.Object3D(), lower = new THREE.Object3D(), end = new THREE.Object3D()
    root.rotation.y = 0.4
    root.add(upper); upper.add(lower); lower.add(end)
    lower.position.y = -0.35; end.position.y = -0.38
    const target = new THREE.Vector3(0.1, -0.56, 0.2)
    solveLimb(upper, lower, end, target, new THREE.Vector3(0, 0, 1))
    expect(end.getWorldPosition(new THREE.Vector3()).distanceTo(target)).toBeLessThan(1e-5)
    expect(lower.position.length()).toBeCloseTo(0.35)
    expect(end.position.length()).toBeCloseTo(0.38)
    solveLimb(upper, lower, end, new THREE.Vector3(100, 100, 100), new THREE.Vector3(0, 0, 1))
    expect(end.getWorldPosition(new THREE.Vector3()).length()).toBeLessThanOrEqual(0.73)
    expect(upper.quaternion.toArray().every(Number.isFinite)).toBe(true)
})
test('scene commands are allowlisted and wait for the complete leading tag', () => {
    expect(parseSceneCue('<emote body="sit" camera="full"/>好')).toEqual({ body: 'sit', camera: 'full' })
    expect(parseSceneCue('<emote body="sit"')).toEqual({ body: undefined, camera: undefined })
    expect(parseSceneCue('<emote body="delete" camera="0,0,0"/>')).toEqual({ body: undefined, camera: undefined })
})
test('manual camera movement cancels automatic movement and pending return', () => {
    const camera = new THREE.PerspectiveCamera(30, 1.3, 0.1, 100)
    camera.position.set(0, 3, 11)
    const controls = { target: new THREE.Vector3(), update() {} }
    const director = new CameraDirector(camera, controls as any)
    director.beginAction(HOME, false); director.update(0.05)
    director.manual()
    const position = camera.position.clone()
    director.endAction(HOME, false); director.update(0.05)
    expect(camera.position.distanceTo(position)).toBe(0)
    director.select('full', HOME, true)
    expect(director.active).toBe(false)
    expect(camera.position.z).toBeCloseTo(HOME.z + 4.8)
})
