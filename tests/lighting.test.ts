import { expect, test } from 'bun:test'
import * as THREE from 'three'
import { applyStageRim, createStageLighting, lightDirection } from '../src/avatar/scene/lighting'
import { HOME } from '../src/avatar/scene/layout'

test('the key lights her from the camera side and the back light from where the sun is', () => {
    const rig = createStageLighting()
    const key = lightDirection(rig.key)
    const back = lightDirection(rig.back)
    // Camera sits at +z looking toward -z; she faces the camera.
    expect(key.z).toBeGreaterThan(0.4)
    expect(key.y).toBeGreaterThan(0.4)
    expect(back.z).toBeLessThan(-0.4)
    expect(back.y).toBeGreaterThan(0.4)
    expect(key.dot(back)).toBeLessThan(0.5)
    expect(rig.key.target.position.distanceTo(HOME)).toBe(0)
    const names = rig.group.children.map(child => child.name)
    expect(names).toEqual(expect.arrayContaining(['ambient', 'hemisphere', 'key', 'back']))
    expect(rig.group.getObjectByName('ambient')).toBeInstanceOf(THREE.AmbientLight)
})

test('the stage rim only fills in MToon materials that ship without one, never outlines', () => {
    const mtoon = (overrides: Record<string, unknown> = {}) => Object.assign(new THREE.MeshBasicMaterial(), {
        isMToonMaterial: true, parametricRimColorFactor: new THREE.Color(0, 0, 0),
        parametricRimFresnelPowerFactor: 1, parametricRimLiftFactor: 0, rimLightingMixFactor: 0, ...overrides,
    })
    const bare = mtoon()
    const authored = mtoon({ parametricRimColorFactor: new THREE.Color(0.2, 0.2, 0.5) })
    const outline = mtoon({ isOutline: true })
    const plain = new THREE.MeshStandardMaterial()
    const scene = new THREE.Scene()
    const geometry = new THREE.BufferGeometry()
    scene.add(new THREE.Mesh(geometry, [bare, authored]), new THREE.Mesh(geometry, outline), new THREE.Mesh(geometry, plain), new THREE.Mesh(geometry, bare))
    expect(applyStageRim({ scene })).toBe(1)
    expect(bare.parametricRimColorFactor.r).toBeCloseTo(0.2)
    expect(bare.parametricRimFresnelPowerFactor).toBe(6)
    expect(authored.parametricRimColorFactor.b).toBe(0.5)
    expect(outline.parametricRimColorFactor.r).toBe(0)
})
