import { expect, test } from 'bun:test'
import * as THREE from 'three'
import { BodyDirector } from '../src/avatar/scene/BodyDirector'

// The actual avatar's measured normalized leg lengths / hip and ankle offsets.
function rig() {
    const scene = new THREE.Group()
    scene.position.set(-1, 2.5, 8)
    const bones = new Map<string, THREE.Object3D>()
    const add = (name: string, parent: string | null, p: number[]) => {
        const node = new THREE.Object3D()
        node.position.set(p[0]!, p[1]!, p[2]!)
        bones.set(name, node)
        ;(parent ? bones.get(parent)! : scene).add(node)
    }
    add('hips', null, [-0.012139, 0.876495, -0.003836])
    add('spine', 'hips', [0, 0.1, 0])
    add('chest', 'spine', [0, 0.12, 0])
    add('neck', 'chest', [0, 0.05, 0])
    add('head', 'neck', [0, 0.056, 0.008])
    for (const [side, sign] of [
        ['left', 1],
        ['right', -1],
    ] as const) {
        add(side + 'UpperLeg', 'hips', [sign * 0.05914, -0.09563, -0.00275])
        add(side + 'LowerLeg', side + 'UpperLeg', [sign * 0.00188, -0.32809, -0.01325])
        add(side + 'Foot', side + 'LowerLeg', [sign * 0.00175, -0.36357, -0.02563])
        add(side + 'Toes', side + 'Foot', [-sign * 0.00294, -0.04806, 0.0876])
        add(side + 'Shoulder', 'chest', [sign * 0.01, 0.01, 0])
        add(side + 'UpperArm', side + 'Shoulder', [sign * 0.072, -0.01, 0])
        add(side + 'LowerArm', side + 'UpperArm', [sign * 0.197, -0.01, 0])
        add(side + 'Hand', side + 'LowerArm', [sign * 0.184, -0.01, 0])
    }
    const events: any[] = []
    const body = new BodyDirector(
        {
            scene,
            humanoid: { getNormalizedBoneNode: (name: string) => bones.get(name) ?? null },
        } as any,
        event => events.push(event)
    )
    const update = () => {
        body.restore()
        body.update(1 / 60)
        scene.updateWorldMatrix(true, true)
    }
    return { body, bones, scene, update, events }
}
test('real-size leg IK follows grounded contacts during approach, return and seated routing', () => {
    const { body, bones, update, events } = rig()
    let maxError = 0
    for (const action of ['approach', 'return', 'sit', 'stand', 'return'] as const) {
        expect(body.play(action)).toBe(true)
        let count = 0
        while (body.busy && count++ < 2400) {
            update()
            if (body.locomotion.active && count > 40)
                body.locomotion.feet.forEach((foot, index) => {
                    if (!foot.planted) return
                    const actual = bones
                        .get(index === 0 ? 'leftFoot' : 'rightFoot')!
                        .getWorldPosition(new THREE.Vector3())
                    maxError = Math.max(maxError, actual.distanceTo(foot.position))
                })
        }
        expect(body.busy).toBe(false)
        expect(events.at(-1).phase).toBe('complete')
        for (let i = 0; i < 60; i++) update()
    }
    expect(maxError).toBeLessThan(0.025)
})
