import * as THREE from 'three'
import { VRM } from '@pixiv/three-vrm'
import {
    createVRMAnimationClip,
    VRMAnimation,
    VRMLookAtQuaternionProxy,
} from '@pixiv/three-vrm-animation'
import { VRMLookAtSmoother } from '@/avatar/libs/VRMLookAtSmootherLoaderPlugin/VRMLookAtSmoother'

export type EmotionName = 'happy' | 'angry' | 'sad' | 'relaxed' | 'surprised'
export const EMOTION_NAMES: EmotionName[] = ['happy', 'angry', 'sad', 'relaxed', 'surprised']

export class VrmController {
    private _vrm: VRM | null
    private _animationMixer: THREE.AnimationMixer | null
    private _animationLookAtTarget: THREE.Object3D | null
    private _actions: Map<string, THREE.AnimationAction>
    private _activeActionName: string | null
    private _fps: number = 0
    private _frameCount: number = 0
    private _fpsUpdateTime: number = 0
    private _autoBlinkEnabled: boolean = false
    private _blinkTimer: number = 0
    private _nextBlinkTime: number = 0
    private _isBlinking: boolean = false
    private _blinkProgress: number = 0
    private _blinkDuration: number = 0.15 // 眨眼持续时间（秒）
    private _blinkIntervalMin: number = 2.0 // 最小眨眼间隔（秒）
    private _blinkIntervalMax: number = 6.0 // 最大眨眼间隔（秒）
    // Track per-action mixer listeners so we can remove them on transition.
    // Without this, LoopRepeat clips never fire 'finished' and the 'loop'
    // listener stays bound forever — each playAction stacks more.
    private _activeOnLoop: ((event: any) => void) | null = null
    private _activeOnFinished: ((event: any) => void) | null = null

    // Emotion blending state. Targets come from applyEmotion(); current values
    // chase targets each frame for a smooth ramp. After _emotionDecayWindow
    // seconds with no new emotion command, all targets ease back to 0 so the
    // face doesn't stay stuck on the last emotion.
    private _emotionTargets: Record<EmotionName, number> = {
        happy: 0, angry: 0, sad: 0, relaxed: 0, surprised: 0,
    }
    private _emotionCurrent: Record<EmotionName, number> = {
        happy: 0, angry: 0, sad: 0, relaxed: 0, surprised: 0,
    }
    private _emotionLastSetAt: number = 0
    private _emotionSmoothing: number = 8.0
    private _emotionDecayWindow: number = 4.0

    /**
     * 创建一个VrmController模型管理器
     * @param vrm VRM模型
     */
    constructor(vrm: VRM | null = null) {
        this._vrm = null
        this._animationMixer = null
        this._animationLookAtTarget = null
        this._actions = new Map()
        this._activeActionName = null
        if (vrm) {
            this.setVRM(vrm)
        }
        this._resetBlinkTimer()
    }

    /**
     * 重置眨眼计时器
     */
    private _resetBlinkTimer() {
        this._nextBlinkTime =
            this._blinkIntervalMin +
            Math.random() * (this._blinkIntervalMax - this._blinkIntervalMin)
        this._blinkTimer = 0
    }

    /**
     * 启用自动眨眼
     */
    enableAutoBlink() {
        this._autoBlinkEnabled = true
        this._resetBlinkTimer()
    }

    /**
     * 禁用自动眨眼
     */
    disableAutoBlink() {
        this._autoBlinkEnabled = false
        this._isBlinking = false
        this._blinkProgress = 0
    }

    /**
     * 设置眨眼参数
     * @param duration 眨眼持续时间（秒）
     * @param intervalMin 最小眨眼间隔（秒）
     * @param intervalMax 最大眨眼间隔（秒）
     */
    setBlinkParams(duration: number, intervalMin: number, intervalMax: number) {
        this._blinkDuration = duration
        this._blinkIntervalMin = intervalMin
        this._blinkIntervalMax = intervalMax
    }

    /**
     * 当前是否绑定了VRM模型
     * @returns 是否绑定了VRM模型
     */
    hasVRM() {
        return !!this._vrm
    }

    /**
     * 绑定VRM模型
     * @param vrm VRM模型
     */
    setVRM(vrm: VRM) {
        this.clearVRM()
        this._vrm = vrm

        this._vrm.scene.traverse((e: any) => {
            e.frustumCulled = false // 避免被裁剪
        })

        if (this._vrm.springBoneManager) {
            this._vrm.springBoneManager.joints.forEach((joint: any) => {
                // 为了避免joint.center为null
                joint.center = joint.center || this._vrm!.scene
            })
        }

        const lookAt = this._vrm.lookAt
        if (lookAt) {
            const head = this._vrm.humanoid.getRawBoneNode('head')
            if (head && !lookAt.target) {
                const lookAtInvHeadWorld = new THREE.Object3D()
                lookAtInvHeadWorld.name = 'lookAtInvHeadWorld'
                head.updateWorldMatrix(true, false)
                lookAt.getLookAtWorldQuaternion(new THREE.Quaternion())
                lookAtInvHeadWorld.quaternion.copy(
                    new THREE.Quaternion().copy(new THREE.Quaternion()).invert()
                )
                head.add(lookAtInvHeadWorld)

                const lookAtTargetParent = new THREE.Object3D()
                lookAtTargetParent.name = 'lookAtTargetParent'
                lookAtInvHeadWorld.add(lookAtTargetParent)

                const lookAtTarget = new THREE.Object3D()
                lookAtTarget.name = 'lookAtTarget'
                lookAtTarget.position.set(0, 0, 1)
                lookAtTargetParent.add(lookAtTarget)

                lookAt.target = lookAtTarget
                lookAt.autoUpdate = true
            }
            this._animationLookAtTarget = lookAt.target || null

            // Add a look-at quaternion proxy to the VRM, which is required for playing look-at animations
            // ref: https://github.com/pixiv/three-vrm/blob/dev/packages/three-vrm-animation/examples/loader-plugin.html
            const lookAtQuatProxy = new VRMLookAtQuaternionProxy(lookAt)
            lookAtQuatProxy.name = 'lookAtQuaternionProxy'
            this._vrm.scene.add(lookAtQuatProxy)
        }

        this._animationMixer = new THREE.AnimationMixer(this._vrm.scene)
    }

    /**
     * 清除VRM模型
     */
    clearVRM() {
        this._detachActionListeners()
        this._vrm = null
        this._activeActionName = null
        this._animationMixer = null
    }

    /**
     * 检查是否存在指定名称的动作
     * @param name 动作名称
     * @returns 是否存在指定名称的动作
     */
    hasAction(name: string) {
        return !!this._actions.has(name)
    }

    /**
     * 播放指定名称的动作
     * @param name 动作名称
     * @param options 动作选项 { transition, loop, startTime, paused, resetSpringBones, onFinished, onLoop }
     */
    playAction(name: string, options: any = {}) {
        if (!this._vrm || !this._animationMixer) return

        // 检查是否存在指定名称的动作
        if (!this.hasAction(name)) {
            throw new Error(`Animation ${name} does not exist`)
        }

        // 检查是否为当前动作
        if (this._activeActionName === name) return

        const vrm = this._vrm
        const animationMixer = this._animationMixer

        const transition = options.transition !== undefined ? options.transition : 0.5

        // 打断当前动作
        if (this._activeActionName) {
            this._actions.get(this._activeActionName)?.fadeOut(transition)
        }

        // Detach previous action's listeners. For LoopRepeat clips 'finished'
        // never fires, so the 'loop' listener would stay bound and stack on
        // every transition.
        this._detachActionListeners()

        // 监听动画循环事件，每轮动画结束时调用callback
        const onLoop = () => {
            if (options.onLoop) {
                options.onLoop(vrm)
            }
        }

        const onFinished = () => {
            this._detachActionListeners()
            this.endAction()
            if (options.onFinished) {
                options.onFinished(vrm)
            }
        }

        animationMixer.addEventListener('finished', onFinished)
        animationMixer.addEventListener('loop', onLoop)
        this._activeOnFinished = onFinished
        this._activeOnLoop = onLoop

        // 播放新动作
        const action = this._actions.get(name)
        if (!action) return

        action.reset()
        action.setLoop(options.loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity)
        action.time = options.startTime || 0
        action.paused = options.paused || false
        action.play()
        action.fadeIn(transition)
        this._activeActionName = name
        if (options.resetSpringBones || transition === 0) {
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    if (vrm && vrm.springBoneManager) {
                        vrm.springBoneManager.reset()
                    }
                })
            })
        }
    }

    /**
     * 结束当前动作播放
     * @param options 动作选项 { transition }
     */
    endAction(options: any = {}) {
        if (!this._activeActionName) return

        const transition = options.transition !== undefined ? options.transition : 0.5
        this._actions.get(this._activeActionName)?.fadeOut(transition)
        this._activeActionName = null
        this._detachActionListeners()
    }

    private _detachActionListeners() {
        if (!this._animationMixer) return
        if (this._activeOnFinished) {
            this._animationMixer.removeEventListener('finished', this._activeOnFinished)
            this._activeOnFinished = null
        }
        if (this._activeOnLoop) {
            this._animationMixer.removeEventListener('loop', this._activeOnLoop)
            this._activeOnLoop = null
        }
    }

    /**
     * 暂停当前动作播放
     */
    pauseAction() {
        if (!this._activeActionName) return
        const action = this._actions.get(this._activeActionName)
        if (action) action.paused = true
    }

    /**
     * 恢复当前动作播放
     */
    resumeAction() {
        if (!this._activeActionName) return
        const action = this._actions.get(this._activeActionName)
        if (action) action.paused = false
    }

    /**
     * 注册VRM动画
     * @param name 动画名称
     * @param animation VRM动画数据
     */
    registerVRMAnimation(name: string, animation: VRMAnimation) {
        if (!this._vrm || !this._animationMixer) return

        // 检查是否存在指定名称的动作
        if (this._actions.has(name)) {
            // 删除已存在的动作
            this.unregisterVRMAnimation(name)
        }

        const animationClip = createVRMAnimationClip(animation, this._vrm)
        const animationAction = this._animationMixer.clipAction(animationClip)

        animationAction.clampWhenFinished = true
        this._actions.set(name, animationAction)
    }

    /**
     * 注销VRM动画
     * @param name 动画名称
     */
    unregisterVRMAnimation(name: string) {
        const action = this._actions.get(name)
        if (action) {
            action.stop()
            this._actions.delete(name)
        } else {
            throw new Error(`Animation ${name} does not exist`)
        }
    }

    /**
     * 注销所有动作
     */
    unregisterAllAction() {
        this._actions.forEach((_, name) => {
            this.unregisterVRMAnimation(name)
        })
    }

    /**
     * 设置描边可见性
     * @param visible 是否可见
     */
    setOutlineVisibility(visible: boolean) {
        if (!this._vrm) return

        this._vrm.scene.traverse((obj: any) => {
            if (obj.isMToonMaterial && obj.isOutline) {
                obj.visible = visible
            }
        })
    }

    /**
     * 获取当前FPS
     * @returns 当前FPS值
     */
    getFPS() {
        return Math.ceil(this._fps)
    }

    /**
     * 更新模型
     * @param delta 时间间隔
     */
    update(delta: number) {
        if (!this._vrm || !this._animationMixer) return

        // 更新FPS计数
        this._frameCount++
        this._fpsUpdateTime += delta
        if (this._fpsUpdateTime >= 1) {
            this._fps = this._frameCount / this._fpsUpdateTime
            this._frameCount = 0
            this._fpsUpdateTime -= 1 // 保留超出1秒的部分，保持计算连续性
        }

        if (this._activeActionName) {
            const action = this._actions.get(this._activeActionName)
            if (action && action.paused) {
                delta = 0
            }
        }

        // 更新自动眨眼
        if (this._autoBlinkEnabled) {
            this._updateAutoBlink(delta)
        }

        // Emotion tween + auto-decay. Must run before _updateBlendShapeNeutral
        // so neutral fills in correctly each frame.
        this._updateEmotions(delta)

        // 重置物理时间差阈值
        // 如果时间差过大，可能会导致物理效果出现较大抖动
        const resetSpringBoneDeltaThreshold = 0.5
        if (delta > resetSpringBoneDeltaThreshold) {
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    if (this._vrm?.springBoneManager) {
                        this._vrm.springBoneManager!.reset()
                    }
                })
            })
        }

        this._animationMixer.update(delta)
        this._updateBlendShapeNeutral()
        this._vrm.update(delta)
    }

    /**
     * 更新自动眨眼
     * @param delta 时间间隔
     */
    private _updateAutoBlink(delta: number) {
        if (!this._vrm || !this._vrm.expressionManager) return

        const expressionManager = this._vrm.expressionManager

        if (this._isBlinking) {
            // 正在眨眼
            this._blinkProgress += delta

            if (this._blinkProgress >= this._blinkDuration) {
                // 眨眼结束
                this._isBlinking = false
                this._blinkProgress = 0
                expressionManager.setValue('blink', 0)
                expressionManager.setValue('blinkLeft', 0)
                expressionManager.setValue('blinkRight', 0)
                this._resetBlinkTimer()
            } else {
                // 计算眨眼值（使用sin函数实现平滑的眨眼效果）
                const blinkValue = Math.sin((this._blinkProgress / this._blinkDuration) * Math.PI)
                expressionManager.setValue('blink', blinkValue)
                expressionManager.setValue('blinkLeft', blinkValue)
                expressionManager.setValue('blinkRight', blinkValue)
            }
        } else {
            // 等待下次眨眼
            this._blinkTimer += delta

            if (this._blinkTimer >= this._nextBlinkTime) {
                // 开始眨眼
                this._isBlinking = true
                this._blinkProgress = 0
            }
        }
    }

    /**
     * 设置表情
     * @param name 表情名称
     * @param value 表情值
     * @param isBinary 是否为二进制表情
     */
    setExpression(name: string, value: number, isBinary = false) {
        if (!this._vrm) return

        if (isBinary && value !== 0) {
            value = 1
        }

        const expressionManager = this._vrm.expressionManager
        if (!expressionManager) return

        expressionManager.setValue(name, value)
    }

    /**
     * 设置看向目标
     * @param x X坐标
     * @param y Y坐标
     * @param z Z坐标
     */
    setLookAt(x: number, y: number, z: number) {
        const lookAt = this._vrm?.lookAt
        if (lookAt) {
            lookAt.lookAt(new THREE.Vector3(x, y, z))
        }
    }

    /**
     * 设置看向目标（通过偏航和俯仰）
     * @param yaw 偏航角
     * @param pitch 俯仰角
     */
    setLookAtByYawPitch(yaw: number, pitch: number) {
        const lookAt = this._vrm?.lookAt
        if (lookAt) {
            lookAt.applier.applyYawPitch(yaw, pitch)
        }
    }

    /**
     * 设置看向参考物
     * @param target 目标
     */
    setLookAtReference(target: THREE.Object3D) {
        const lookAt = this._vrm?.lookAt
        if (lookAt) {
            lookAt.target = target
        }
    }

    /**
     * 清除看向参考物
     */
    clearLookAtReference() {
        const lookAt = this._vrm?.lookAt
        if (lookAt) {
            lookAt.target = this._animationLookAtTarget
        }
    }

    /**
     * 设置扫视
     * @param enable 是否启用扫视
     */
    setSaccade(enable: boolean) {
        const lookAt = this._vrm?.lookAt as VRMLookAtSmoother
        if (lookAt) {
            lookAt.enableSaccade = enable
        }
    }

    /**
     * 获取表情名称列表
     * @returns 表情名称列表
     */
    getExpressionNames() {
        if (this._vrm && this._vrm.expressionManager) {
            return this._vrm.expressionManager.expressions.map((e: any) => e.expressionName)
        }
    }

    /**
     * 获取表情值
     * @param name 表情名称
     * @returns 表情值
     */
    getExpressionValue(name: string) {
        const expressionManager = this._vrm?.expressionManager
        if (!expressionManager) return 0

        return expressionManager.getValue(name) || 0
    }

    /**
     * 是否为二进制表情
     * @param name 表情名称
     * @returns 是否为二进制表情
     */
    isBinaryExpression(name: string) {
        if (!this._vrm || !this._vrm.expressionManager) return

        const expression = this._vrm.expressionManager.getExpression(name)
        return expression?.isBinary
    }

    /**
     * 启用自动更新看向
     */
    enableAutoUpdateLookAt() {
        const lookAt = this._vrm?.lookAt
        if (lookAt) {
            lookAt.autoUpdate = true
        }
    }

    /**
     * 禁用自动更新看向
     */
    disableAutoUpdateLookAt() {
        const lookAt = this._vrm?.lookAt
        if (lookAt) {
            lookAt.autoUpdate = false
        }
    }

    /**
     * 启用表情动画
     */
    enableExpressionAnimation() {
        // 尚未实现
        // this._isEnabledExpression = true
        // this._refreshAnimation()
    }

    /**
     * 禁用表情动画
     */
    disableExpressionAnimation() {
        // 尚未实现
        // this._isEnabledExpression = false
        // this._refreshAnimation()
    }

    /**
     * 更新动画
     */
    private _refreshAnimation() {
        if (this._activeActionName) {
            const action = this._actions.get(this._activeActionName)
            const options = {
                loop: action?.loop === THREE.LoopRepeat,
                transition: 0,
                startTime: action?.time || 0,
                paused: action?.paused || false,
                resetSpringBones: false,
            }
            this.playAction(this._activeActionName, options)
        }
    }

    /**
     * 更新中性表情
     */
    private _updateBlendShapeNeutral() {
        if (!this._vrm) return
        const expressionManager = this._vrm.expressionManager
        if (!expressionManager || !expressionManager.expressionMap.neutral) return

        // VRM 1.0 preset names are lowercase. Earlier code read capitalized
        // names which silently returned 0 — neutral was always 1 and emotion
        // expressions visually had no effect.
        let sum = 0
        for (const name of EMOTION_NAMES) {
            sum += expressionManager.getValue(name) || 0
        }
        const neutral = Math.max(0, 1 - sum)
        expressionManager.setValue('neutral', neutral)
    }

    /**
     * Set the target emotion blend. Values not present default to 0, which
     * means "decay this back to neutral." Values are clamped to [0, 1].
     * Pass an empty object to reset to fully neutral.
     */
    applyEmotion(target: Partial<Record<EmotionName, number>>) {
        for (const name of EMOTION_NAMES) {
            const v = target[name]
            this._emotionTargets[name] = v === undefined ? 0 : Math.max(0, Math.min(1, v))
        }
        this._emotionLastSetAt = performance.now()
    }

    /**
     * Configure emotion tween responsiveness and how long after the last
     * applyEmotion() before the face decays back to neutral.
     */
    setEmotionDynamics(opts: { smoothing?: number; decayWindowSeconds?: number }) {
        if (opts.smoothing !== undefined) this._emotionSmoothing = opts.smoothing
        if (opts.decayWindowSeconds !== undefined) this._emotionDecayWindow = opts.decayWindowSeconds
    }

    private _updateEmotions(delta: number) {
        if (!this._vrm || !this._vrm.expressionManager) return
        const expressionManager = this._vrm.expressionManager

        // Auto-decay: after the idle window, ramp targets back to 0.
        if (this._emotionLastSetAt > 0) {
            const sinceLast = (performance.now() - this._emotionLastSetAt) / 1000
            if (sinceLast > this._emotionDecayWindow) {
                for (const name of EMOTION_NAMES) this._emotionTargets[name] = 0
            }
        }

        // Tween current → target with a frame-rate-independent smoothing factor.
        const k = 1 - Math.exp(-this._emotionSmoothing * delta)
        for (const name of EMOTION_NAMES) {
            const next = this._emotionCurrent[name] + (this._emotionTargets[name] - this._emotionCurrent[name]) * k
            this._emotionCurrent[name] = next
            // Only write if the model actually has the preset, to avoid spurious warnings.
            if (expressionManager.expressionMap[name]) {
                expressionManager.setValue(name, next)
            }
        }
    }
}
