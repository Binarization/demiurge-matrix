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
    }, { }, { timeout: 90000 })
    await page.getByRole('button', { name: '静静陪伴' }).click({ trial: true, timeout: 90000 })
    await page.waitForTimeout(1200)
    const state = () => page.evaluate(() => window.__avatar.getSceneState())
    await page.getByRole('button', { name:'打开互动' }).click()
    await page.waitForTimeout(400)
    await page.screenshot({path:'/tmp/cyrene-stage-panel.png'})
    await page.getByRole('button', {name:'看看全身', exact:true}).click()
    await page.waitForTimeout(1600)
    await page.screenshot({path:'/tmp/cyrene-stage-full.png'})
    for (const [action, label, sample] of [['stretch','伸个懒腰',2], ['wave','挥挥手',1.3], ['approach','走近一点',1], ['return','回到原处',1], ['sit','坐一会儿',4], ['stand','站起来',0.7], ['return','回到原处',1]]) {
        await page.getByRole('button', {name:'打开互动'}).click()
        await page.getByRole('button', {name:label,exact:true}).click()
        await page.waitForFunction(({action,sample}) => {
            const a = window.__motionController.bodyDirector.active
            return a?.name === action && a.elapsed >= Math.min(sample,a.duration * 0.8)
        }, {action,sample}, {timeout:20000})
        await page.screenshot({path:'/tmp/cyrene-stage-'+action+'.png'})
        await page.waitForFunction(() => !window.__motionController.bodyDirector.busy, {}, {timeout:20000})
        console.log(action, await state())
        const footHeights = await page.evaluate(() => {
            const v = window.__motionController._vrm
            return ['leftFoot','rightFoot'].map(name => { const n = v.humanoid.getNormalizedBoneNode(name); return n.getWorldPosition(n.position.clone()).y })
        })
        assert(footHeights.every(y=>Number.isFinite(y) && y > 2.37 && y < 2.58), 'feet near floor: '+footHeights)
        if (action==='sit') {
            assert.equal((await state()).seated,true)
            await page.waitForTimeout(1600)
            await page.screenshot({path:'/tmp/cyrene-stage-seated.png'})
        }
    }
    // Actual head drag and hand tap use projected live bones, not a test-only action hook.
    const point = async (name, up = 0) => page.evaluate(({name,up}) => {
        const avatar = window.__avatar, bone = avatar.getVrmModel().humanoid.getNormalizedBoneNode(name)
        const p = bone.getWorldPosition(bone.position.clone()); p.y += up; p.project(avatar.getCamera())
        return { x:(p.x+1)/2*innerWidth, y:(1-p.y)/2*innerHeight }
    }, {name,up})
    await page.waitForTimeout(1700)
    const head = await point('head',0.08)
    await page.mouse.move(head.x-15,head.y); await page.mouse.down()
    await page.mouse.move(head.x+15,head.y,{steps:8}); await page.mouse.up()
    await page.waitForFunction(()=>window.__motionController.bodyDirector.currentAction==='headpat')
    await page.getByRole('button',{name:'停止动作'}).click()
    assert.equal((await state()).action,null)
    await page.waitForTimeout(1900)
    const hand = await point('rightHand')
    await page.mouse.click(hand.x,hand.y)
    await page.waitForFunction(()=>window.__motionController.bodyDirector.currentAction==='offer_hand')
    await page.waitForTimeout(1600)
    await page.screenshot({path:'/tmp/cyrene-stage-hand.png'})
    await page.waitForFunction(()=>!window.__motionController.bodyDirector.busy)
    const events = await page.evaluate(()=>JSON.parse(localStorage.getItem('demiurge_conversation_v1')).sceneEvents)
    assert(events.some(event=>event.action==='轻轻摸头'&&event.outcome==='cancel'))
    assert(events.some(event=>event.action==='伸手回应'&&event.outcome==='complete'))
    // Manual orbit input during an automatic shot must prevent the later reset.
    await page.evaluate(()=>window.__avatar.playBodyAction('stretch'))
    await page.waitForTimeout(500)
    await page.mouse.move(1050,450); await page.mouse.down()
    await page.mouse.move(1080,460,{steps:6}); await page.mouse.up()
    const manualCamera = await page.evaluate(()=>window.__avatar.getCamera().position.toArray())
    await page.evaluate(()=>window.__avatar.stopBodyAction())
    await page.waitForTimeout(1500)
    const afterCancel = await page.evaluate(()=>window.__avatar.getCamera().position.toArray())
    assert(Math.hypot(...afterCancel.map((v,i)=>v-manualCamera[i]))<0.001, 'manual orbit must own camera after cancellation')
    await page.setViewportSize({width:390,height:844})
    await page.getByRole('button',{name:'打开互动'}).click()
    await page.waitForTimeout(400)
    await page.screenshot({path:'/tmp/cyrene-stage-mobile-panel.png'})
    await page.getByRole('button',{name:'看看全身',exact:true}).click()
    await page.waitForTimeout(1700)
    await page.screenshot({path:'/tmp/cyrene-stage-mobile.png'})
    assert(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth))
    assert.deepEqual(errors, [])
    console.log('Full-body scene and UI passed')

} finally { await browser.close() }
