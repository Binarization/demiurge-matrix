import { chromium } from 'playwright'
import assert from 'node:assert/strict'
// Idle life on the real model: fidgets, quiet self-initiated body actions and yielding to the partner.
// Shifting Date.now makes the partner look quiet for minutes without waiting.
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
            if (controller?.hasVRM()) { window.__avatar = component.exposed; return controller }
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
    }, {}, { timeout: 90000 })
    await page.getByRole('button', { name: '静静陪伴' }).click({ trial: true, timeout: 90000 })
    await page.evaluate(() => (document.activeElement)?.blur?.())
    await page.waitForTimeout(1000)
    const director = () => page.evaluate(() => {
        const d = window.__motionController.bodyDirector
        return { action: d.currentAction, busy: d.busy, seated: d.seated }
    })
    const camera = () => page.evaluate(() => window.__avatar.getCamera().position.toArray())
    const quietFor = ms => page.evaluate(ms => {
        const real = window.__realNow ??= Date.now.bind(Date)
        window.__shift = (window.__shift ?? 0) + ms
        Date.now = () => real() + window.__shift
    }, ms)
    const feedbackVisible = () => page.locator('.scene-feedback').isVisible()
    const sceneEvents = () => page.evaluate(() => JSON.parse(localStorage.getItem('demiurge_conversation_v1')).sceneEvents ?? [])

    // 1. Fidgets run on their own while idle.
    await page.evaluate(() => { const m = window.__motionController._motion; m.nextFidgetAt = m.idleFor + 0.5 })
    await page.waitForFunction(() => window.__motionController._motion.currentFidget, {}, { timeout: 5000 })
    await page.waitForTimeout(1500)
    const fidget = await page.evaluate(() => window.__motionController._motion.currentFidget)
    console.log('fidget', fidget)
    await page.screenshot({ path: '/tmp/cyrene-idle-fidget.png' })
    await page.waitForFunction(() => !window.__motionController._motion.currentFidget, {}, { timeout: 8000 })
    await page.waitForTimeout(800)
    await page.screenshot({ path: '/tmp/cyrene-idle-rest.png' })
    for (const name of ['look_around', 'look_up']) {
        await page.evaluate(name => {
            const m = window.__motionController._motion
            m.fidget = { name, started: m.time, side: 1 }
        }, name)
        await page.waitForTimeout(2000)
        await page.screenshot({ path: `/tmp/cyrene-idle-${name}.png`, clip: { x: 440, y: 260, width: 400, height: 360 } })
    }

    // 2. After a quiet spell she moves by herself: no notice, no camera cut, logged as her own.
    const before = await camera()
    await quietFor(3 * 60_000)
    await page.waitForFunction(() => window.__motionController.bodyDirector.busy, {}, { timeout: 15000 })
    const first = await director()
    console.log('idle action', first)
    await page.waitForTimeout(1000)
    assert.equal(await feedbackVisible(), false, 'quiet action must not show the action bar')
    const during = await camera()
    assert(Math.hypot(...during.map((v, i) => v - before[i])) < 0.01, 'quiet action must not cut the camera')
    await page.screenshot({ path: `/tmp/cyrene-idle-${first.action}.png` })
    await page.waitForFunction(() => !window.__motionController.bodyDirector.busy, {}, { timeout: 20000 })
    assert((await sceneEvents()).some(e => e.action.startsWith('自己') && e.outcome === 'complete'), 'own actions are logged as 自己…')

    // 3. Longer quiet: bench, stand up, walk home.
    for (let i = 0; i < 10 && !(await director()).seated; i++) {
        await quietFor(3.5 * 60_000)
        await page.waitForTimeout(5500)
        await page.waitForFunction(() => !window.__motionController.bodyDirector.busy, {}, { timeout: 25000 })
    }
    assert.equal((await director()).seated, true, 'she eventually rests on the bench')
    await page.waitForTimeout(1500)
    await page.screenshot({ path: '/tmp/cyrene-idle-seated.png' })
    await quietFor(7 * 60_000)
    await page.waitForFunction(() => window.__motionController.bodyDirector.currentAction === 'stand', {}, { timeout: 12000 })
    await page.waitForFunction(() => !window.__motionController.bodyDirector.busy, {}, { timeout: 20000 })
    await quietFor(20_000)
    await page.waitForFunction(() => window.__motionController.bodyDirector.currentAction === 'return', {}, { timeout: 12000 })
    await page.waitForFunction(() => !window.__motionController.bodyDirector.busy, {}, { timeout: 25000 })
    const home = await page.evaluate(() => window.__avatar.getSceneState())
    assert(Math.hypot(home.position[0] - home.home[0], home.position[2] - home.home[2]) < 0.3, 'walked back home')
    await page.waitForTimeout(1600)
    const framed = await camera()
    assert(Math.abs(framed[0] - (home.home[0] + 0.12)) < 0.2, 'camera recenters on her after she walks home: ' + framed)
    await page.screenshot({ path: '/tmp/cyrene-idle-home.png' })

    // 4. Anything the partner asks for takes over her own movement.
    await quietFor(4 * 60_000)
    await page.waitForFunction(() => window.__motionController.bodyDirector.busy, {}, { timeout: 15000 })
    console.log('own action before request', await director(), await page.evaluate(() => window.__avatar.getSceneState()))
    await page.getByRole('button', { name: '打开互动' }).click()
    await page.getByRole('button', { name: '挥挥手', exact: true }).click()
    await page.waitForTimeout(300)
    console.log('after request', await director(), await page.evaluate(() => window.__avatar.getSceneState()))
    await page.waitForFunction(() => window.__motionController.bodyDirector.currentAction === 'wave', {}, { timeout: 5000 })
    assert.equal(await feedbackVisible(), true, 'requested action shows its status')
    await page.waitForFunction(() => !window.__motionController.bodyDirector.busy, {}, { timeout: 20000 })
    const events = await sceneEvents()
    assert(!events.some(e => e.action.startsWith('自己') && e.outcome === 'cancel'), 'interrupted own actions are not logged')
    console.log('scene events', events.map(e => `${e.action}:${e.outcome}`).join(' | '))
    assert.deepEqual(errors, [])
    console.log('idle life ok')
} finally {
    await browser.close()
}
