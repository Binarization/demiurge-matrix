import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'

// World coordinates, after the splat's [2,2,2] scale. Calibrated against opaque
// splat centers and the front paving, not an inferred mesh of the whole scene.
export const FLOOR_Y = 2.38
export const HOME = new THREE.Vector3(-1, FLOOR_Y, 8)
export const SEAT = new THREE.Vector3(-2.05, FLOOR_Y + 0.41, 8)
export const WALK_AREA = { minX: -2.65, maxX: 0.25, minZ: 7.45, maxZ: 9.35 }
export const COLLIDERS = [
    { id: 'tree', min: [0.85, FLOOR_Y, 7.05], max: [2.2, 6.2, 8.05] },
    { id: 'stone-border', min: [0.65, FLOOR_Y, 8.1], max: [1.4, 3.2, 9.6] },
    { id: 'seat', min: [SEAT.x - 0.37, FLOOR_Y, SEAT.z - 0.23], max: [SEAT.x + 0.37, SEAT.y, SEAT.z + 0.23] },
] as const

export function canStand(position: THREE.Vector3, seatAccess = false, radius = 0.16) {
    if (![position.x, position.y, position.z].every(Number.isFinite)) return false
    if (position.x < WALK_AREA.minX + radius || position.x > WALK_AREA.maxX - radius ||
        position.z < WALK_AREA.minZ + radius || position.z > WALK_AREA.maxZ - radius) return false
    return !COLLIDERS.some(box => {
        if (box.id === 'seat' && seatAccess) return false
        const x = THREE.MathUtils.clamp(position.x, box.min[0], box.max[0])
        const z = THREE.MathUtils.clamp(position.z, box.min[2], box.max[2])
        return Math.hypot(position.x - x, position.z - z) < radius
    })
}
export function pathIsClear(from: THREE.Vector3, to: THREE.Vector3, seatAccess = false) {
    const count = Math.max(1, Math.ceil(from.distanceTo(to) / 0.04))
    for (let i = 0; i <= count; i++) if (!canStand(from.clone().lerp(to, i / count), seatAccess)) return false
    return true
}

export function createStageGeometry(debug = false) {
    const group = new THREE.Group()
    group.name = 'companion-stage'
    const pixels = new Uint8Array(64 * 64 * 4)
    for (let i = 0; i < 64 * 64; i++) {
        const grain = 190 + Math.floor((Math.sin(i * 127.1) * 43758.5453 % 1 + 1) * 22)
        pixels.set([grain, grain, grain, 255], i * 4)
    }
    const texture = new THREE.DataTexture(pixels, 64, 64)
    texture.colorSpace = THREE.SRGBColorSpace; texture.needsUpdate = true
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping
    const stone = new THREE.MeshStandardMaterial({ color: 0x8c7960, map: texture, vertexColors: true, roughness: 1 })
    const mesh = (size: number[], at: number[], material = stone) => {
        const geometry = new RoundedBoxGeometry(size[0], size[1], size[2], 2, 0.018)
        const normals = geometry.getAttribute('normal'), colors = new Float32Array(normals.count * 3)
        for (let i = 0; i < normals.count; i++) {
            const shade = 0.62 + normals.getY(i) * 0.21 + normals.getZ(i) * 0.09 + normals.getX(i) * 0.06
            colors.set([shade, shade, shade], i * 3)
        }
        geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
        const box = new THREE.Mesh(geometry, material)
        box.position.set(at[0]!, at[1]!, at[2]!); group.add(box)
    }
    // A visible seat: its dimensions are also the collision and sitting contract.
    mesh([0.74, 0.1, 0.46], [SEAT.x, SEAT.y - 0.05, SEAT.z])
    for (const dx of [-0.25, 0.25]) mesh([0.12, 0.31, 0.32], [SEAT.x + dx, FLOOR_Y + 0.155, SEAT.z])
    const shadowPixels = new Uint8Array(32 * 32 * 4)
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
        const radius = Math.hypot((x - 15.5) / 15.5, (y - 15.5) / 15.5)
        shadowPixels.set([30, 24, 29, Math.round(Math.max(0, 1 - radius) ** 2 * 115)], (y * 32 + x) * 4)
    }
    const shadowTexture = new THREE.DataTexture(shadowPixels, 32, 32)
    shadowTexture.needsUpdate = true
    const shadowMaterial = new THREE.MeshBasicMaterial({ map: shadowTexture, transparent: true, depthWrite: false })
    for (const [name, x, z, width, depth] of [['foot-contact', HOME.x, HOME.z + 0.06, 0.55, 0.4], ['seat-contact', SEAT.x, SEAT.z, 1, 0.65]] as const) {
        const shadow = new THREE.Mesh(new THREE.PlaneGeometry(width, depth), shadowMaterial)
        shadow.rotation.x = -Math.PI / 2
        shadow.position.set(x, FLOOR_Y + 0.006, z)
        shadow.name = name; group.add(shadow)
    }
    if (debug) {
        const floor = new THREE.GridHelper(4, 20, 0xb7e8ce, 0x85b5be)
        floor.position.set(-1, FLOOR_Y + 0.005, 8); group.add(floor)
        for (const box of COLLIDERS) {
            group.add(new THREE.Box3Helper(new THREE.Box3(new THREE.Vector3(...box.min), new THREE.Vector3(...box.max)), 0xeec89a))
        }
    }
    return group
}
export function disposeStage(group: THREE.Group) {
    group.traverse(object => {
        if (object instanceof THREE.Mesh || object instanceof THREE.LineSegments) {
            object.geometry.dispose()
            const materials = Array.isArray(object.material) ? object.material : [object.material]
            materials.forEach(material => {
                if ('map' in material) (material.map as THREE.Texture | null)?.dispose()
                material.dispose()
            })
        }
    })
    group.removeFromParent()
}
