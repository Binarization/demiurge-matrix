import { expect, test } from 'bun:test'
import * as THREE from 'three'
import { CompanionMotion, parseGesture } from '../src/avatar/utils/CompanionMotion'
import { SpeechTextFilter } from '../src/lib/voice/phrase-stream'

function rig() {
    const motion = new CompanionMotion()
    const head = new THREE.Object3D()
    const hand = new THREE.Object3D()
    const step = (state: 'idle' | 'speaking' = 'idle', reduced = false) => {
        motion.restore()
        motion.update(1 / 60, state, 0.6, name => name === 'head' ? head : name === 'rightHand' ? hand : null, reduced)
    }
    return { motion, head, hand, step }
}
test('only complete, allowlisted gesture tags run and never become speech', () => {
    expect(parseGesture('<emote happy=0.2 gesture="wave"/>你好')).toBe('wave')
    expect(parseGesture('<emote gesture="wave"')).toBeNull()
    expect(parseGesture('<emote gesture="execute"/>')).toBeNull()
    const filter = new SpeechTextFilter()
    expect(filter.push('<emote happy=0.2 gest')).toBe('')
    expect(filter.push('ure="wave"/>你好')).toBe('你好')
})
test('queued gestures wait for playback; interruption discards them', () => {
    const a = rig()
    a.motion.request('wave', true)
    for (let i = 0; i < 60; i++) a.step()
    expect(a.hand.quaternion.angleTo(new THREE.Quaternion())).toBeLessThan(1e-6)
    a.motion.startSpeech()
    for (let i = 0; i < 60; i++) a.step('speaking')
    expect(a.hand.quaternion.angleTo(new THREE.Quaternion())).toBeGreaterThan(0.01)
    a.motion.cancel()
    for (let i = 0; i < 180; i++) a.step()
    expect(a.hand.quaternion.angleTo(new THREE.Quaternion())).toBeLessThan(1e-5)
    const b = rig()
    b.motion.request('wave', true); b.motion.cancel(); b.motion.startSpeech()
    for (let i = 0; i < 60; i++) b.step('speaking')
    expect(b.hand.quaternion.angleTo(new THREE.Quaternion())).toBeLessThan(1e-6)
})
test('additive motion never accumulates on unkeyed bones and reduced motion settles', () => {
    const a = rig()
    for (let i = 0; i < 3600; i++) a.step('speaking')
    expect(a.head.quaternion.angleTo(new THREE.Quaternion())).toBeLessThan(0.06)
    a.motion.restore()
    expect(a.head.quaternion.angleTo(new THREE.Quaternion())).toBeLessThan(1e-5)
    a.motion.request('wave', false)
    for (let i = 0; i < 180; i++) a.step('speaking', true)
    expect(a.hand.quaternion.angleTo(new THREE.Quaternion())).toBeLessThan(1e-5)
    expect(a.head.quaternion.angleTo(new THREE.Quaternion())).toBeLessThan(1e-5)
})
test('idle fidgets start only after sustained quiet, settle back and stop when she is addressed', () => {
    let seed = 0
    const motion = new CompanionMotion(() => (seed = (seed * 9301 + 49297) % 233280) / 233280)
    const head = new THREE.Object3D()
    const step = (state: 'idle' | 'listening', reduced = false) => {
        motion.restore()
        motion.update(1 / 60, state, 0, name => name === 'head' ? head : null, reduced)
    }
    for (let i = 0; i < 60 * 10; i++) step('idle')
    expect(motion.currentFidget).toBeNull()
    let seen = new Set<string>()
    for (let i = 0; i < 60 * 240; i++) { step('idle'); if (motion.currentFidget) seen.add(motion.currentFidget) }
    expect(seen.size).toBeGreaterThan(1)
    for (let i = 0; i < 60 * 60 && !motion.currentFidget; i++) step('idle')
    expect(motion.currentFidget).not.toBeNull()
    step('listening')
    expect(motion.currentFidget).toBeNull()
    for (let i = 0; i < 60 * 5; i++) step('listening', true)
    expect(head.quaternion.angleTo(new THREE.Quaternion())).toBeLessThan(1e-3)
    for (let i = 0; i < 60 * 60; i++) step('idle', true)
    expect(motion.currentFidget).toBeNull()
})
