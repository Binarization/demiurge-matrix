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
    const info = await page.evaluate(() => {
        const c = window.__motionController, v = c._vrm
        const bones = {}
        for (const name of ['hips','head','leftUpperArm','rightUpperArm','leftLowerArm','rightLowerArm','leftHand','rightHand','leftUpperLeg','leftLowerLeg','leftFoot','leftToes','rightFoot']) {
            const n = v.humanoid.getNormalizedBoneNode(name), raw = v.humanoid.getRawBoneNode(name)
            bones[name] = { position: n.position.toArray(), quaternion:n.quaternion.toArray(), world: n.getWorldPosition(n.position.clone()).toArray(),rawWorld:raw.getWorldPosition(raw.position.clone()).toArray() }
        }
        return { root:v.scene.position.toArray(), bones }
    })
    assert.deepEqual(errors, [])
    console.log(JSON.stringify(info,null,2))
    await page.screenshot({ path:'/tmp/cyrene-scene-before.png' })

} finally { await browser.close() }
