import { expect, test } from 'bun:test'
import * as THREE from 'three'
import { LocomotionController } from '../src/avatar/scene/LocomotionController'
import { canStand, FLOOR_Y, SEAT } from '../src/avatar/scene/layout'
function make() {
    return new LocomotionController(
        new THREE.Vector3(-1, 2.3658, 8),
        [0.05, -0.07],
        () => ({ height: FLOOR_Y, normal: new THREE.Vector3(0, 1, 0) }),
        p => canStand(p)
    )
}
function run(motor: LocomotionController, hz = 60, seconds = 25) {
    let maxSlide = 0,
        maxYawRate = 0,
        swings = 0
    for (let i = 0; i < hz * seconds && motor.active; i++) {
        const before = motor.feet.map(f => ({ p: f.position.clone(), planted: f.planted }))
        const yaw = motor.yaw
        motor.update(1 / hz)
        maxYawRate = Math.max(
            maxYawRate,
            Math.abs(Math.atan2(Math.sin(motor.yaw - yaw), Math.cos(motor.yaw - yaw))) * hz
        )
        motor.feet.forEach((foot, index) => {
            if (before[index]!.planted && foot.planted)
                maxSlide = Math.max(maxSlide, foot.position.distanceTo(before[index]!.p))
            if (before[index]!.planted && !foot.planted) swings++
            expect(foot.position.y).toBeGreaterThanOrEqual(FLOOR_Y + 0.0749)
        })
    }
    return { maxSlide, maxYawRate, swings }
}
test('velocity-driven walk plants feet in world space and brakes at its destination', () => {
    const motor = make(),
        goal = motor.position.clone().add(new THREE.Vector3(0, 0, 0.65))
    motor.navigate([goal])
    const result = run(motor)
    expect(motor.active).toBe(false)
    expect(motor.position.distanceTo(goal)).toBeLessThan(0.02)
    expect(result.maxSlide).toBe(0)
    expect(result.swings).toBeGreaterThan(2)
    expect(motor.speed).toBe(0)
})
test('return turns before translating backwards and finishes facing the companion', () => {
    const motor = make(),
        goal = motor.position.clone().add(new THREE.Vector3(0, 0, -0.3))
    motor.navigate([goal])
    motor.update(0.2)
    expect(motor.position.z).toBeCloseTo(8, 3)
    const result = run(motor)
    expect(motor.active).toBe(false)
    expect(motor.position.distanceTo(goal)).toBeLessThan(0.02)
    expect(Math.abs(motor.yaw)).toBeLessThan(0.02)
    expect(result.maxYawRate).toBeLessThanOrEqual(2.001)
    expect(result.maxSlide).toBe(0)
})
test('fixed ticks produce the same path at 30, 60 and 120 Hz', () => {
    const motors = [30, 60, 120].map(hz => {
        const motor = make()
        motor.navigate([
            new THREE.Vector3(-1, 2.3658, 8.6),
            new THREE.Vector3(SEAT.x, 2.3658, 8.6),
            new THREE.Vector3(SEAT.x, 2.3658, 8.46),
        ])
        for (let i = 0; i < hz * 5; i++) motor.update(1 / hz)
        return motor
    })
    for (const motor of motors.slice(1)) {
        expect(motor.position.distanceTo(motors[0]!.position)).toBeLessThan(1e-8)
        expect(Math.abs(motor.yaw - motors[0]!.yaw)).toBeLessThan(1e-8)
    }
    for (const motor of motors) {
        run(motor)
        expect(motor.active).toBe(false)
        expect(motor.blocked).toBe(false)
    }
})
test('interruption preserves a lifted foot and settles without resetting to the route start', () => {
    const motor = make()
    motor.navigate([motor.position.clone().add(new THREE.Vector3(0, 0, 0.65))])
    while (!motor.feet.some(f => !f.planted)) motor.update(1 / 60)
    const feet = motor.feet.map(f => f.position.clone()),
        root = motor.position.clone()
    motor.stop()
    motor.feet.forEach((f, i) => expect(f.position.distanceTo(feet[i]!)).toBe(0))
    run(motor)
    expect(motor.active).toBe(false)
    expect(motor.position.distanceTo(root)).toBeLessThan(0.12)
    expect(motor.feet.every(f => f.planted)).toBe(true)
})

test('blocked movement reports failure and releases the controller', () => {
    const motor = make()
    motor.navigate([new THREE.Vector3(-1, 2.3658, 7)])
    run(motor)
    expect(motor.active).toBe(false)
    expect(motor.blocked).toBe(true)
    expect(canStand(motor.position)).toBe(true)
})
