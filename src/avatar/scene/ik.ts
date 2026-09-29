import * as THREE from 'three'
const world = (node: THREE.Object3D) => node.getWorldPosition(new THREE.Vector3())
function aim(node: THREE.Object3D, end: THREE.Object3D, target: THREE.Vector3) {
    node.updateWorldMatrix(true, true)
    const origin = world(node)
    const from = world(end).sub(origin).normalize()
    const to = target.clone().sub(origin).normalize()
    if (from.lengthSq() < 0.5 || to.lengthSq() < 0.5) return
    const q = new THREE.Quaternion().setFromUnitVectors(from, to)
        .multiply(node.getWorldQuaternion(new THREE.Quaternion()))
    const parent = node.parent?.getWorldQuaternion(new THREE.Quaternion()) ?? new THREE.Quaternion()
    node.quaternion.copy(parent.invert().multiply(q))
    node.updateWorldMatrix(false, true)
}
/** Analytic two-bone solve with a fixed bend pole; unreachable targets are clamped. */
export function solveLimb(upper: THREE.Object3D, lower: THREE.Object3D, end: THREE.Object3D,
    target: THREE.Vector3, pole: THREE.Vector3) {
    upper.updateWorldMatrix(true, true)
    const a = world(upper), b = world(lower), c = world(end)
    const l1 = a.distanceTo(b), l2 = b.distanceTo(c)
    if (l1 < 1e-5 || l2 < 1e-5 || !target.toArray().every(Number.isFinite)) return
    const direction = target.clone().sub(a)
    const distance = THREE.MathUtils.clamp(direction.length(), Math.abs(l1 - l2) + 0.001, l1 + l2 - 0.001)
    if (direction.lengthSq() < 1e-8) direction.set(0, -1, 0)
    direction.normalize()
    const bend = pole.clone().addScaledVector(direction, -pole.dot(direction))
    if (bend.lengthSq() < 1e-8) bend.set(1, 0, 0).addScaledVector(direction, -direction.x)
    bend.normalize()
    const along = (l1 * l1 - l2 * l2 + distance * distance) / (2 * distance)
    const midpoint = a.clone().addScaledVector(direction, along)
        .addScaledVector(bend, Math.sqrt(Math.max(0, l1 * l1 - along * along)))
    aim(upper, lower, midpoint)
    aim(lower, end, a.clone().addScaledVector(direction, distance))
}
