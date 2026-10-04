/**
 * Stage lighting for the character. The Gaussian splat is a baked sunset:
 * the sun sits behind and to the left of her, so the sky side is bright and
 * the ground throws back a cooler bounce. The rig below is what that scene
 * would do to a figure standing in it: a warm key from the camera side so the
 * face reads, a hot back light where the sun actually is, hemisphere bounce,
 * and a low ambient floor. Only the character scene is lit; splats are unlit.
 */
import * as THREE from 'three'
import type { VRM } from '@pixiv/three-vrm'
import { HOME } from './layout'

export const STAGE_LIGHT = {
    ambient: { color: 0xf3dcc8, intensity: 1.6 },
    hemisphere: { sky: 0xffc9a0, ground: 0x4b4d68, intensity: 0.6 },
    /** Camera-side warm key, offset toward the bright sky on her left. */
    key: { color: 0xffd9b4, intensity: 0.9, offset: [-1.6, 2.1, 2.4] as const },
    /** The sun itself: behind her, high, slightly right of the key so the two edges differ. */
    back: { color: 0xffa36b, intensity: 0.5, offset: [1.1, 2.6, -2.2] as const },
    /** Parametric rim applied to MToon materials that ship without one. */
    rim: { color: [0.2, 0.11, 0.05] as const, fresnelPower: 7, lift: 0, lightingMix: 1 },
}

export type StageLightRig = {
    group: THREE.Group
    key: THREE.DirectionalLight
    back: THREE.DirectionalLight
}

export function createStageLighting(origin: THREE.Vector3 = HOME): StageLightRig {
    const group = new THREE.Group()
    group.name = 'stage-lighting'

    const ambient = new THREE.AmbientLight(STAGE_LIGHT.ambient.color, STAGE_LIGHT.ambient.intensity)
    ambient.name = 'ambient'
    group.add(ambient)

    const hemisphere = new THREE.HemisphereLight(STAGE_LIGHT.hemisphere.sky, STAGE_LIGHT.hemisphere.ground, STAGE_LIGHT.hemisphere.intensity)
    hemisphere.name = 'hemisphere'
    hemisphere.position.set(0, 1, 0)
    group.add(hemisphere)

    const directional = (name: 'key' | 'back') => {
        const spec = STAGE_LIGHT[name]
        const light = new THREE.DirectionalLight(spec.color, spec.intensity)
        light.name = name
        light.position.set(origin.x + spec.offset[0], origin.y + spec.offset[1], origin.z + spec.offset[2])
        light.target.position.copy(origin)
        light.target.name = `${name}-target`
        group.add(light, light.target)
        return light
    }
    return { group, key: directional('key'), back: directional('back') }
}

/** World-space unit vector from the light's target toward the light. */
export function lightDirection(light: THREE.DirectionalLight): THREE.Vector3 {
    return light.position.clone().sub(light.target.position).normalize()
}

type RimMaterial = THREE.Material & {
    isMToonMaterial?: boolean
    isOutline?: boolean
    parametricRimColorFactor: THREE.Color
    parametricRimFresnelPowerFactor: number
    parametricRimLiftFactor: number
    rimLightingMixFactor: number
}

/**
 * Give MToon surfaces that have no rim of their own a warm fresnel edge so the
 * back light reads as a sun behind her. Materials that already define a rim
 * are left alone; outlines are never touched. Returns how many were changed.
 */
export function applyStageRim(vrm: Pick<VRM, 'scene'>): number {
    const seen = new Set<THREE.Material>()
    let changed = 0
    vrm.scene.traverse(object => {
        const mesh = object as THREE.Mesh
        if (!mesh.isMesh) return
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        for (const material of materials as RimMaterial[]) {
            if (!material?.isMToonMaterial || material.isOutline || seen.has(material)) continue
            seen.add(material)
            const rim = material.parametricRimColorFactor
            if (!rim || rim.r > 0.01 || rim.g > 0.01 || rim.b > 0.01) continue
            rim.setRGB(...STAGE_LIGHT.rim.color)
            material.parametricRimFresnelPowerFactor = STAGE_LIGHT.rim.fresnelPower
            material.parametricRimLiftFactor = STAGE_LIGHT.rim.lift
            material.rimLightingMixFactor = STAGE_LIGHT.rim.lightingMix
            material.needsUpdate = true
            changed++
        }
    })
    return changed
}
