import * as THREE from 'three'

export type GroundSample = { height: number; normal: THREE.Vector3 }
export type FootState = { position: THREE.Vector3; yaw: number; planted: boolean }
type Swing = {
    index: number
    from: THREE.Vector3
    to: THREE.Vector3
    fromYaw: number
    toYaw: number
    elapsed: number
    duration: number
    lift: number
}
const UP = new THREE.Vector3(0, 1, 0)
const clamp = THREE.MathUtils.clamp
const angle = (value: number) => Math.atan2(Math.sin(value), Math.cos(value))
const smooth = (value: number) => value * value * (3 - 2 * value)

/** Kinematic character motor + alternating world-space foot contacts.
 * Navigation supplies goals, never timestamps. Fixed ticks couple acceleration,
 * facing, collision and stance reach to gait; grounded feet are never translated.
 */
export class LocomotionController {
    readonly position: THREE.Vector3
    readonly velocity = new THREE.Vector3()
    readonly feet: [FootState, FootState]
    yaw = 0
    angularVelocity = 0
    travelled = 0
    phase: 'idle' | 'turning' | 'walking' | 'braking' | 'settling' = 'idle'
    blocked = false
    private path: THREE.Vector3[] = []
    private finalYaw = 0
    private swing: Swing | null = null
    private nextFoot = 0
    private supportTime = 0
    private accumulator = 0
    private enabled = false
    private readonly tick = 1 / 120
    readonly maxSpeed = 0.43
    private readonly acceleration = 0.85
    private readonly braking = 1.35
    private readonly maxTurnSpeed = 2.0
    constructor(
        position: THREE.Vector3,
        private offsets: number[],
        private ground: (x: number, z: number) => GroundSample,
        private walkable: (position: THREE.Vector3) => boolean,
        private ankleHeight = 0.075
    ) {
        this.position = position.clone()
        this.feet = [0, 1].map(index => ({
            position: this.restFoot(index),
            yaw: 0,
            planted: true,
        })) as [FootState, FootState]
    }
    get active() {
        return this.enabled
    }
    get speed() {
        return this.velocity.length()
    }
    get swingPhase() {
        return this.swing ? this.swing.elapsed / this.swing.duration : 0
    }
    get supportSide() {
        return this.swing ? 1 - this.swing.index : -1
    }
    get forward() {
        return new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw))
    }
    get poseWeight() {
        return clamp(this.speed / this.maxSpeed, 0, 1)
    }
    reset(position: THREE.Vector3, yaw: number, feet?: THREE.Vector3[]) {
        this.position.copy(position)
        this.yaw = yaw
        this.finalYaw = yaw
        this.velocity.set(0, 0, 0)
        this.angularVelocity = 0
        this.path = []
        this.swing = null
        this.enabled = false
        this.phase = 'idle'
        this.accumulator = 0
        this.supportTime = 0
        this.blocked = false
        this.travelled = 0
        for (const [index, foot] of this.feet.entries()) {
            foot.position.copy(feet?.[index] ?? this.restFoot(index))
            foot.position.y =
                this.ground(foot.position.x, foot.position.z).height + this.ankleHeight
            foot.yaw = yaw
            foot.planted = true
        }
    }
    navigate(points: THREE.Vector3[], finalYaw = 0) {
        if (!points.length || points.some(point => !point.toArray().every(Number.isFinite)))
            return false
        this.path = points.map(point => point.clone())
        while (this.path.length && this.position.distanceTo(this.path[0]!) < 0.015)
            this.path.shift()
        this.finalYaw = finalYaw
        this.enabled = true
        this.blocked = false
        return true
    }
    stop() {
        this.path = []
        this.finalYaw = 0
        // Complete the lifted foot's landing; do not reset foot positions or phase.
        if (this.enabled) this.phase = 'braking'
    }
    update(delta: number) {
        if (!this.enabled || !Number.isFinite(delta)) return
        this.accumulator += clamp(delta, 0, 0.2)
        while (this.accumulator + 1e-10 >= this.tick && this.enabled) {
            this.step(this.tick)
            this.accumulator -= this.tick
        }
    }
    private restFoot(index: number, yaw = this.yaw, position = this.position) {
        const target = new THREE.Vector3(this.offsets[index]!, 0, 0.025)
            .applyAxisAngle(UP, yaw)
            .add(position)
        target.y = this.ground(target.x, target.z).height + this.ankleHeight
        return target
    }
    private step(dt: number) {
        let goal = this.path[0]
        let distance = goal ? this.position.distanceTo(goal) : 0
        if (goal && distance < 0.014) {
            // Only the last millimetres are snapped, with both velocity and gait braking.
            this.position.copy(goal)
            this.path.shift()
            goal = this.path[0]
            distance = goal ? this.position.distanceTo(goal) : 0
        }
        const direction = goal ? goal.clone().sub(this.position).setY(0).normalize() : this.forward
        const desiredYaw = goal ? Math.atan2(direction.x, direction.z) : this.finalYaw
        const yawError = angle(desiredYaw - this.yaw)
        const turnSpeed = clamp(yawError * 5, -this.maxTurnSpeed, this.maxTurnSpeed)
        this.angularVelocity += clamp(turnSpeed - this.angularVelocity, -8 * dt, 8 * dt)
        this.yaw = angle(this.yaw + this.angularVelocity * dt)
        const facing = Math.max(0, Math.cos(yawError)) ** 3
        const desiredSpeed = goal
            ? Math.min(
                  this.maxSpeed,
                  Math.sqrt(2 * this.braking * Math.max(0, distance - 0.01)),
                  distance * 3.2
              ) * facing
            : 0
        const desiredVelocity = direction.multiplyScalar(desiredSpeed)
        const change = desiredVelocity.sub(this.velocity)
        change.clampLength(0, (desiredSpeed < this.speed ? this.braking : this.acceleration) * dt)
        this.velocity.add(change)
        const proposed = this.position.clone().addScaledVector(this.velocity, dt)
        // A capsule sweep is split by fixed ticks. Also keep each stance leg reachable.
        const supported = this.feet.every(
            (foot, i) =>
                !foot.planted ||
                foot.position
                    .clone()
                    .setY(0)
                    .distanceTo(this.restFoot(i, this.yaw, proposed).setY(0)) < 0.22
        )
        if (supported && this.walkable(proposed)) {
            this.travelled += proposed.distanceTo(this.position)
            this.position.copy(proposed)
        } else {
            this.velocity.set(0, 0, 0)
            if (!this.walkable(proposed)) {
                this.blocked = true
                this.path = []
                this.finalYaw = this.yaw
            }
        }
        this.updateFeet(dt)
        const settled = this.feet.every(
            (foot, index) =>
                foot.position.distanceTo(this.restFoot(index)) < 0.022 &&
                Math.abs(angle(foot.yaw - this.yaw)) < 0.18
        )
        if (
            !this.path.length &&
            this.speed < 0.002 &&
            Math.abs(angle(this.finalYaw - this.yaw)) < 0.015 &&
            !this.swing &&
            (settled || this.blocked)
        ) {
            this.velocity.set(0, 0, 0)
            this.angularVelocity = 0
            this.enabled = false
            this.phase = 'idle'
        } else
            this.phase =
                this.speed > 0.03
                    ? 'walking'
                    : Math.abs(yawError) > 0.12
                      ? 'turning'
                      : this.path.length
                        ? 'braking'
                        : 'settling'
    }
    private updateFeet(dt: number) {
        const swing = this.swing
        if (swing) {
            swing.elapsed = Math.min(swing.duration, swing.elapsed + dt)
            const p = swing.elapsed / swing.duration,
                eased = smooth(p)
            const foot = this.feet[swing.index]!
            foot.position.lerpVectors(swing.from, swing.to, eased)
            foot.position.y += Math.sin(Math.PI * p) * swing.lift
            foot.yaw = swing.fromYaw + angle(swing.toYaw - swing.fromYaw) * eased
            if (p >= 1) {
                foot.position.copy(swing.to)
                foot.yaw = swing.toYaw
                foot.planted = true
                this.swing = null
                this.nextFoot = 1 - swing.index
                this.supportTime = 0.055
            }
            return
        }
        this.supportTime = Math.max(0, this.supportTime - dt)
        if (this.supportTime > 0) return
        const moving = this.speed > 0.025 && this.path.length > 0
        const duration = clamp(0.36 - this.speed * 0.15, 0.27, 0.36)
        const predicted = this.position.clone().addScaledVector(this.velocity, duration * 0.65)
        const nextYaw = this.yaw + clamp(this.angularVelocity * duration * 0.4, -0.25, 0.25)
        for (const index of [this.nextFoot, 1 - this.nextFoot]) {
            const foot = this.feet[index]!
            const to = this.restFoot(index, nextYaw, moving ? predicted : this.position)
            const error = foot.position.distanceTo(to)
            const yawError = Math.abs(angle(foot.yaw - nextYaw))
            if (error < (moving ? 0.065 : 0.022) && yawError < 0.2) continue
            // Foot placement must respect obstacles too, rather than only testing the root.
            if (!this.walkable(to)) continue
            to.sub(foot.position).clampLength(0, 0.29).add(foot.position)
            to.y = this.ground(to.x, to.z).height + this.ankleHeight
            foot.planted = false
            this.swing = {
                index,
                from: foot.position.clone(),
                to,
                fromYaw: foot.yaw,
                toYaw: nextYaw,
                elapsed: 0,
                duration,
                lift: moving ? 0.045 : 0.025,
            }
            return
        }
    }
    footRotation(index: number) {
        const foot = this.feet[index]!
        const normal = this.ground(foot.position.x, foot.position.z).normal.clone().normalize()
        return new THREE.Quaternion()
            .setFromUnitVectors(UP, normal)
            .multiply(new THREE.Quaternion().setFromAxisAngle(UP, foot.yaw))
    }
}
