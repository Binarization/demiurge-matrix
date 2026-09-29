import { chromium } from 'playwright'
import assert from 'node:assert/strict'
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } })
    const errors = []
    page.on('pageerror', e => errors.push(e.message))
    await page.goto(process.env.UI_TEST_URL ?? 'http://127.0.0.1:5177/')
    await page.waitForFunction(() => {
        const seen = new Set()
        function find(component) {
            if (!component || seen.has(component)) return null
            seen.add(component)
            const controller = component.exposed?.getVrmController?.()
            if (controller?.hasVRM()) return controller
            function visit(vnode) {
                if (!vnode) return null
                const match = find(vnode.component)
                if (match) return match
                if (Array.isArray(vnode.children)) for (const child of vnode.children) {
                    const match = visit(child); if (match) return match
                }
                return null
            }
            return visit(component.subTree)
        }
        window.__motionController = find(document.querySelector('#app')?.__vue_app__?._instance)
        return !!window.__motionController
    }, { }, { timeout: 90000 })
    await page.getByRole('button', { name: '静静陪伴' }).click({ trial: true, timeout: 90000 })
    await page.waitForTimeout(1200)
    await page.screenshot({ path: '/tmp/cyrene-motion-idle.png' })
    await page.evaluate(() => {
        window.__motionController.queueGesture('wave')
    })
    await page.waitForTimeout(1000)
    await page.screenshot({ path: '/tmp/cyrene-motion-wave.png' })
    const result = await page.evaluate(async () => {
        const c = window.__motionController
        const bones = ['head', 'rightUpperArm', 'rightLowerArm', 'rightHand']
        const moving = c._motion.rotations.get('rightUpperArm')?.length() > 0.01
        const finite = bones.every(name => c._vrm.humanoid.getNormalizedBoneNode(name)?.quaternion.toArray().every(Number.isFinite))
        c.setInteractionState('interrupted')
        await new Promise(resolve => setTimeout(resolve, 1200))
        return { moving, finite, pending: c._motion.pending, gesture: c._motion.gesture }
    })
    assert.equal(result.moving, true)
    assert.equal(result.finite, true)
    assert.equal(result.pending, null)
    assert.equal(result.gesture, null)
    assert.deepEqual(errors, [])
    console.log('Real VRM: gesture playback, interruption, finite bones and no browser errors passed.')
} finally { await browser.close() }
