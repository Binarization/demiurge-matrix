import * as THREE from 'three'
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm'
import { FLOOR_Y, HOME, SEAT, pathIsClear, canStand } from './layout'
import { LocomotionController } from './LocomotionController'
import { solveLimb } from './ik'

export const BODY_ACTIONS = ['approach', 'return', 'stretch', 'wave', 'offer_hand', 'headpat', 'sit', 'stand'] as const
export type BodyAction = typeof BODY_ACTIONS[number]
/** `quiet`: self-initiated while nobody was talking; no camera cut or on-screen notice. */
export type SceneEvent = { action: BodyAction; phase: 'start' | 'complete' | 'cancel'; label: string; quiet?: boolean }
export const ACTION_LABELS: Record<BodyAction, string> = {
    approach: '走近一点', return: '回到原处', stretch: '伸个懒腰', wave: '挥挥手',
    offer_hand: '伸手回应', headpat: '轻轻摸头', sit: '坐一会儿', stand: '站起来',
}
type Angles = [number, number, number]
type Pose = Partial<Record<VRMHumanBoneName, Angles>>
type Key = { at: number; pose: Pose }
const KEYS: Partial<Record<BodyAction, Key[]>> = {
    stretch: [
        { at: 0, pose: {} },
        { at: 0.3, pose: { leftUpperArm: [-0.2, 0, 0.65], rightUpperArm: [-0.2, 0, -0.65], leftLowerArm: [0, -0.15, -0.3], rightLowerArm: [0, 0.15, 0.3], chest: [-0.08, 0, 0], head: [-0.08, 0, 0] } },
        { at: 0.62, pose: { leftUpperArm: [-0.1, 0, 0.85], rightUpperArm: [-0.1, 0, -0.85], chest: [-0.09, 0, 0.025], head: [-0.06, 0, 0] } },
        { at: 1, pose: {} },
    ],
    wave: [
        { at: 0, pose: {} },
        { at: 0.25, pose: { rightUpperArm: [0, 0, 0.5], rightLowerArm: [0, 0, -1.7], rightHand: [0, 0, 0.18], head: [0, -0.07, -0.035] } },
        { at: 0.7, pose: { rightUpperArm: [0, 0, 0.5], rightLowerArm: [0, 0, -1.7], rightHand: [0, 0, -0.18], head: [0, 0, -0.035] } },
        { at: 1, pose: {} },
    ],
    headpat: [
        { at: 0, pose: {} },
        { at: 0.35, pose: { head: [0.11, 0, 0.1], chest: [0.025, 0, 0.035], leftUpperArm: [0, 0, -1.2], rightUpperArm: [0, 0, 1.2] } },
        { at: 0.7, pose: { head: [0.08, 0, -0.035], chest: [0.025, 0, 0] } },
        { at: 1, pose: {} },
    ],
}
const BONES: VRMHumanBoneName[] = ['hips', 'spine', 'chest', 'neck', 'head', 'leftShoulder', 'rightShoulder',
    'leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm', 'leftHand', 'rightHand',
    'leftUpperLeg', 'rightUpperLeg', 'leftLowerLeg', 'rightLowerLeg', 'leftFoot', 'rightFoot', 'leftToes', 'rightToes']
const neutral: Pose = { leftUpperArm: [0, 0, -1.32], rightUpperArm: [0, 0, 1.32], leftLowerArm: [0, -0.12, 0], rightLowerArm: [0, 0.12, 0] }
const smooth = (v: number) => { const x = THREE.MathUtils.clamp(v, 0, 1); return x * x * (3 - 2 * x) }
const quaternion = (v: Angles = [0, 0, 0]) => new THREE.Quaternion().setFromEuler(new THREE.Euler(...v))

export class BodyDirector {
    private saved = new Map<THREE.Object3D, { q: THREE.Quaternion; p: THREE.Vector3 }>()
    private hipsRest: THREE.Vector3
    private footHeight: number
    private feetX: number[]
    private weight = 0
    private seatAmount = 0
    private locomotionBlend = 0
    readonly locomotion: LocomotionController
    private active: { name: BodyAction; elapsed: number; duration: number; from: THREE.Vector3; to: THREE.Vector3; walkDuration: number; path: THREE.Vector3[]; distance: number; phase: 'move' | 'pose'; poseElapsed: number; poseDuration: number } | null = null
    seated = false
    private handTarget: THREE.Vector3 | null = null
    constructor(private vrm: VRM, private emit: (event: SceneEvent) => void) {
        this.hipsRest = this.bone('hips')!.position.clone()
        vrm.scene.updateWorldMatrix(true, true)
        const feet = ['leftFoot', 'rightFoot'].map(name => this.bone(name as VRMHumanBoneName)!.getWorldPosition(new THREE.Vector3()))
        this.footHeight = Math.min(...feet.map(p => p.y - vrm.scene.position.y))
        this.feetX = feet.map(p => p.x - vrm.scene.position.x)
        vrm.scene.position.y = FLOOR_Y + 0.075 - this.footHeight
        this.locomotion = new LocomotionController(vrm.scene.position, this.feetX,
            () => ({ height: FLOOR_Y, normal: new THREE.Vector3(0, 1, 0) }), point => canStand(point))
    }
    private bone(name: VRMHumanBoneName) { return this.vrm.humanoid.getNormalizedBoneNode(name) }
    get busy() { return this.active !== null || this.locomotion.active }
    get ownsPose() { return this.weight > 0.001 || this.seated }
    get currentAction() { return this.active?.name ?? null }
    get position() { return this.vrm.scene.position.clone() }
    play(name: BodyAction, target?: THREE.Vector3): boolean {
        if (!BODY_ACTIONS.includes(name) || this.busy) return false
        if (this.seated && !['stand', 'wave', 'headpat', 'offer_hand'].includes(name)) return false
        if (!this.seated && name === 'stand') return false
        const from = this.position, to = from.clone()
        if (name === 'approach') to.set(HOME.x, from.y, HOME.z + 0.65)
        if (name === 'return') to.set(HOME.x, from.y, HOME.z)
        if (name === 'sit') to.set(SEAT.x, from.y, SEAT.z + 0.46)
        let path = name === 'sit' ? [from, new THREE.Vector3(from.x, from.y, SEAT.z + 0.6), new THREE.Vector3(SEAT.x, from.y, SEAT.z + 0.6), to] : [from, to]
        if (!this.seated && !path.slice(1).every((point, i) => pathIsClear(path[i]!, point))) {
            path = [from, new THREE.Vector3(from.x, from.y, SEAT.z + 0.75), new THREE.Vector3(to.x, to.y, SEAT.z + 0.75), to]
        }
        if (!path.slice(1).every((point, i) => pathIsClear(path[i]!, point, this.seated))) return false
        const distance = path.slice(1).reduce((sum, point, i) => sum + point.distanceTo(path[i]!), 0)
        const walkDuration = distance > 0.02 ? Math.max(1.5, distance / 0.38) : 0
        const poseDuration = (name === 'sit' || name === 'stand' ? 1.5 : name === 'stretch' ? 4.8 : name === 'wave' ? 3.2 : name === 'headpat' ? 2.6 : name === 'offer_hand' ? 3.2 : 0.6)
        if (walkDuration) {
            this.vrm.scene.updateWorldMatrix(true, true)
            const feet = ['leftFoot', 'rightFoot'].map(name => this.bone(name as VRMHumanBoneName)!.getWorldPosition(new THREE.Vector3()))
            this.locomotion.reset(from, this.vrm.scene.rotation.y, feet)
            this.locomotion.navigate(path, 0)
        }
        this.handTarget = target?.clone() ?? null
        this.active = { name, elapsed: 0, duration: walkDuration + poseDuration, from, to, walkDuration, path, distance,
            phase: walkDuration ? 'move' : 'pose', poseElapsed: 0, poseDuration }
        this.emit({ action: name, phase: 'start', label: ACTION_LABELS[name] })
        return true
    }
    cancel() {
        if (this.active) {
            const { name } = this.active
            // Keep partially seated bodies on the seat; stand is an explicit transition.
            if (name === 'sit' && this.active.phase === 'pose') this.seated = true
            this.emit({ action: name, phase: 'cancel', label: ACTION_LABELS[name] })
        }
        this.active = null; this.handTarget = null
        this.locomotion.stop()
    }
    restore() {
        for (const [node, saved] of this.saved) { node.quaternion.copy(saved.q); node.position.copy(saved.p) }
        this.saved.clear()
    }
    dispose() { this.restore(); this.active = null; this.locomotion.stop() }
    update(delta: number) {
        const dt = Math.min(Math.max(delta, 0), 0.05)
        let a = this.active
        const wasLocomoting = this.locomotion.active || a?.phase === 'move'
        if (wasLocomoting) {
            // The motor owns displacement, heading, acceleration and foot contacts.
            this.locomotion.update(dt)
            this.vrm.scene.position.copy(this.locomotion.position)
            this.vrm.scene.rotation.y = this.locomotion.yaw
            if (!this.locomotion.active && a?.phase === 'move') {
                if (this.locomotion.blocked) { this.cancel(); a = null }
                else { a.phase = 'pose'; a.poseElapsed = 0 }
            }
        }
        if (a) {
            a.elapsed += dt
            if (a.phase === 'pose') a.poseElapsed = Math.min(a.poseDuration, a.poseElapsed + dt)
        }
        const desiredWeight = a || this.seated || this.locomotion.active ? 1 : 0
        this.weight = THREE.MathUtils.damp(this.weight, desiredWeight, 9, dt)
        if (this.weight < 0.0001 && !a && !this.seated && !this.locomotion.active) return
        for (const name of BONES) {
            const node = this.bone(name)
            if (node) this.saved.set(node, { q: node.quaternion.clone(), p: node.position.clone() })
        }
        const pose: Pose = { ...neutral }
        if (a) {
            const keys = KEYS[a.name]
            if (keys) {
                const p = a.poseElapsed / a.poseDuration
                const right = keys.findIndex(key => key.at >= p)
                const to = keys[Math.max(1, right)]!, from = keys[Math.max(1, right) - 1]!
                const k = smooth((p - from.at) / (to.at - from.at))
                for (const name of BONES) {
                    const x = from.pose[name] ?? neutral[name] ?? [0, 0, 0]
                    const y = to.pose[name] ?? neutral[name] ?? [0, 0, 0]
                    pose[name] = x.map((v, i) => THREE.MathUtils.lerp(v, y[i]!, k)) as Angles
                }
            }
            if (a.name === 'wave') pose.rightHand = [0, 0, Math.sin(a.poseElapsed * 8) * 0.18 * Math.sin(Math.PI * a.poseElapsed / a.poseDuration)]
        }
        let seatTarget = this.seated ? 1 : 0
        if (a?.name === 'sit') seatTarget = a.phase === 'pose' ? smooth(a.poseElapsed / 1.25) : 0
        if (a?.name === 'stand') seatTarget = 1 - smooth(a.poseElapsed / 1.25)
        this.seatAmount = THREE.MathUtils.damp(this.seatAmount, seatTarget, 12, dt)
        if (a?.name === 'sit' && a.phase === 'pose') this.vrm.scene.position.z = THREE.MathUtils.lerp(SEAT.z + 0.46, SEAT.z + 0.06, seatTarget)
        if (a?.name === 'stand') this.vrm.scene.position.z = THREE.MathUtils.lerp(SEAT.z + 0.46, SEAT.z + 0.06, seatTarget)
        if (this.seated && !a) this.vrm.scene.position.z = THREE.MathUtils.damp(this.vrm.scene.position.z, SEAT.z + 0.06, 12, dt)
        const walking = wasLocomoting || this.locomotion.active
        this.locomotionBlend = THREE.MathUtils.damp(this.locomotionBlend, walking ? 1 : 0, 10, dt)
        const gait = this.locomotion.poseWeight
        const cadence = this.locomotion.travelled / 0.30 * Math.PI * 2
        if (walking) {
            const swing = Math.sin(cadence) * 0.18 * gait
            pose.leftUpperArm = [swing, 0, -1.32]
            pose.rightUpperArm = [-swing, 0, 1.32]
            pose.chest = [-0.035 * gait, -Math.sin(cadence) * 0.025 * gait, 0]
            pose.hips = [0, Math.sin(cadence) * 0.018 * gait, 0]
        }
        for (const name of BONES) {
            const node = this.bone(name)
            if (node) node.quaternion.slerp(quaternion(pose[name]), this.weight)
        }
        const hips = this.bone('hips')!
        const hipsTarget = this.hipsRest.clone()
        hipsTarget.y -= 0.38 * this.seatAmount
        if (this.locomotionBlend > 0.001) {
            hipsTarget.y -= (0.036 + Math.sin(cadence * 2) * 0.006 * gait) * this.locomotionBlend
            const support = this.locomotion.supportSide
            if (support >= 0) hipsTarget.x += (support === 0 ? 1 : -1) * Math.sin(Math.PI * this.locomotion.swingPhase) * 0.008
        }
        hips.position.lerp(hipsTarget, this.weight)
        this.vrm.scene.updateWorldMatrix(true, true)
        for (const [index, side] of ['left', 'right'].entries()) {
            const target = this.position
            target.x += this.feetX[index]!
            target.y = FLOOR_Y + 0.075
            target.z += 0.025
            if (this.seatAmount > 0.001) target.z = THREE.MathUtils.lerp(target.z, SEAT.z + 0.485, Math.min(1, this.seatAmount * 12))
            if (walking) target.copy(this.locomotion.feet[index]!.position)
            const upper = this.bone(`${side}UpperLeg` as VRMHumanBoneName)!, lower = this.bone(`${side}LowerLeg` as VRMHumanBoneName)!, foot = this.bone(`${side}Foot` as VRMHumanBoneName)!
            // Solve from the blended pose, then blend the IK result during entry/exit.
            const upperQ = upper.quaternion.clone(), lowerQ = lower.quaternion.clone(), footQ = foot.quaternion.clone()
            solveLimb(upper, lower, foot, target, walking ? this.locomotion.forward : new THREE.Vector3(0, 0, 1))
            upper.quaternion.slerpQuaternions(upperQ, upper.quaternion.clone(), this.weight)
            lower.quaternion.slerpQuaternions(lowerQ, lower.quaternion.clone(), this.weight)
            lower.updateWorldMatrix(true, true)
            foot.quaternion.copy(lower.getWorldQuaternion(new THREE.Quaternion()).invert()
                .multiply(walking ? this.locomotion.footRotation(index) : new THREE.Quaternion()))
            foot.quaternion.slerpQuaternions(footQ, foot.quaternion.clone(), this.weight)
        }
        if (this.seatAmount > 0.01) {
            for (const side of ['left', 'right'] as const) {
                if (side === 'right' && (a?.name === 'wave' || a?.name === 'offer_hand')) continue
                const upper = this.bone(`${side}UpperArm`)!, lower = this.bone(`${side}LowerArm`)!, hand = this.bone(`${side}Hand`)!
                const q1 = upper.quaternion.clone(), q2 = lower.quaternion.clone()
                const sign = side === 'left' ? 1 : -1
                solveLimb(upper, lower, hand, this.position.add(new THREE.Vector3(sign * 0.13, 0.49, 0.18)), new THREE.Vector3(sign, -0.3, 0))
                upper.quaternion.slerpQuaternions(q1, upper.quaternion.clone(), this.seatAmount)
                lower.quaternion.slerpQuaternions(q2, lower.quaternion.clone(), this.seatAmount)
                lower.updateWorldMatrix(true, true)
                const palm = lower.getWorldQuaternion(new THREE.Quaternion()).invert()
                    .multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -sign * Math.PI / 2, 0)))
                hand.quaternion.slerp(palm, this.seatAmount)
            }
        }
        if (a?.name === 'offer_hand') {
            const upper = this.bone('rightUpperArm')!, lower = this.bone('rightLowerArm')!, hand = this.bone('rightHand')!
            const target = this.handTarget ?? this.position.add(new THREE.Vector3(-0.18, 0.92 - this.seatAmount * 0.38, 0.42))
            const k = Math.sin(Math.PI * a.poseElapsed / a.poseDuration) ** 2 * this.weight
            const q1 = upper.quaternion.clone(), q2 = lower.quaternion.clone()
            solveLimb(upper, lower, hand, target, new THREE.Vector3(-1, -0.3, 0))
            upper.quaternion.slerpQuaternions(q1, upper.quaternion.clone(), k)
            lower.quaternion.slerpQuaternions(q2, lower.quaternion.clone(), k)
        }
        if (a && a.phase === 'pose' && a.poseElapsed >= a.poseDuration) {
            if (a.name === 'sit') this.seated = true
            if (a.name === 'stand') this.seated = false
            this.active = null
            this.emit({ action: a.name, phase: 'complete', label: ACTION_LABELS[a.name] })
        }
    }
}
