<script setup lang="ts">
/**
 * Avatar Component - 可复用的 GaussianSplat + VRM 虚拟人物组件
 *
 * 特性:
 * 1. VRM 和 GaussianSplat3D 共享同一个 THREE.Scene 和 WebGLRenderer
 * 2. VRM 每帧更新（保持动画流畅）
 * 3. GaussianSplat3D 只在相机移动时更新（减少 GPU 计算）
 * 4. 使用 VrmController 管理 VRM 动画和状态
 * 5. 支持通过 Props 配置模型、动画、场景等
 *
 * 注意:
 * - GaussianSplats3D 库不支持 WebGPU，必须使用 WebGL 渲染器
 * - 天空球使用自定义 ShaderMaterial 实现渐变效果
 */
import { ref, onMounted, onUnmounted, watch } from 'vue'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { VRMUtils } from '@pixiv/three-vrm'
import { VRMAnimationLoaderPlugin } from '@pixiv/three-vrm-animation'
import { VRMLookAtSmootherLoaderPlugin } from '@/avatar/libs/VRMLookAtSmootherLoaderPlugin/VRMLookAtSmootherLoaderPlugin'
import { Preloader, PreloadResource, PreloaderEvent } from '@/avatar/utils/Preloader'
import { VrmController } from '@/avatar/utils/VrmController'
// @ts-ignore - GaussianSplats3D doesn't have type definitions
import * as GaussianSplats3D from '@/avatar/libs/GaussianSplats3D'

// Props 定义
interface Props {
    // VRM 模型配置
    modelUrl?: string
    animationUrl?: string
    vrmPosition?: { x: number; y: number; z: number }
    vrmRotation?: { x: number; y: number; z: number }
    vrmScale?: number

    // GaussianSplat 场景配置
    splatScenePath?: string
    splatScale?: [number, number, number]
    splatPosition?: [number, number, number]
    splatAlphaRemovalThreshold?: number

    // 相机配置
    cameraPosition?: { x: number; y: number; z: number }
    cameraFov?: number
    cameraOffset?: number

    // 控制器配置
    enableOrbitControls?: boolean
    enablePan?: boolean
    enableRotate?: boolean
    enableZoom?: boolean
    minDistance?: number
    maxDistance?: number
    minPolarAngle?: number
    maxPolarAngle?: number
    minAzimuthAngle?: number
    maxAzimuthAngle?: number

    // 渲染配置
    showFps?: boolean
    showLoadingProgress?: boolean
    antialias?: boolean

    // 天空球颜色配置
    skyColors?: {
        bottom?: number
        color1?: number
        color2?: number
        color3?: number
        top?: number
    }
}

const props = withDefaults(defineProps<Props>(), {
    // VRM 默认配置
    modelUrl: '/models/philia.vrm',
    animationUrl: '/animations/philia/等待.vrma',
    vrmPosition: () => ({ x: -1, y: 2.5, z: 8 }),
    vrmRotation: () => ({ x: 0, y: 0, z: 0 }),
    vrmScale: 1,

    // GaussianSplat 默认配置
    splatScenePath: '/scenes/aedes_elysiae.splat',
    splatScale: () => [2, 2, 2] as [number, number, number],
    splatPosition: () => [0, 0, 0] as [number, number, number],
    splatAlphaRemovalThreshold: 60,

    // 相机默认配置
    cameraPosition: () => ({ x: -0.82, y: 3.6, z: 11 }),
    cameraFov: 30,
    cameraOffset: 1,

    // 控制器默认配置
    enableOrbitControls: true,
    enablePan: false,
    enableRotate: true,
    enableZoom: true,
    minDistance: 2.0,
    maxDistance: 3.01,
    minPolarAngle: Math.PI * 0.45,
    maxPolarAngle: Math.PI * 0.55,
    minAzimuthAngle: -Math.PI * 0.5,
    maxAzimuthAngle: Math.PI * 0.5,

    // 渲染默认配置
    showFps: false,
    showLoadingProgress: true,
    antialias: true,

    // 天空球默认颜色
    skyColors: () => ({
        bottom: 0x5a829b,
        color1: 0xf3c5b2,
        color2: 0xf6dbb1,
        color3: 0x96c9f1,
        top: 0x477cad,
    }),
})

// Emits 定义
interface Emits {
    (e: 'loading', progress: number): void
    (e: 'loaded'): void
    (e: 'error', error: Error): void
    (e: 'vrmLoaded', vrm: any): void
    (e: 'splatLoaded'): void
    (e: 'ready'): void
}

const emit = defineEmits<Emits>()

const main = ref<HTMLElement | null>(null)
const canvas = ref<HTMLCanvasElement | null>(null)
const fps = ref(0)
const isLoading = ref(true)
const errorMessage = ref('')
const preloadProgress = ref(0)

// 相机动画配置
const cameraAnimationConfig = ref({
    startPosition: { x: -0.54, y: 3.5768, z: 16.6193 },
    startRotation: { x: -0.0089, y: 0.0534, z: 0.000475 },
    endPosition: { x: -0.8195507580535983, y: 3.5069401320954166, z: 11.004578157686609 },
    endRotation: { x: -0.00230984830095552, y: 0.059985882390363364, z: 0.00013847545300307393 },
    duration: 1400,
})

// VRM 位置控制（使用响应式引用）
const vrmPosition = ref({ ...props.vrmPosition })
const vrmRotation = ref({ ...props.vrmRotation })
const vrmScale = ref(props.vrmScale)

// 缓存上一次的 VRM 变换参数，用于检测是否真正改变
let lastVrmPosition = { ...props.vrmPosition }
let lastVrmRotation = { ...props.vrmRotation }
let lastVrmScale = props.vrmScale

let viewer: any = null
let animationId: number | null = null
let renderer: any = null
let camera: THREE.PerspectiveCamera | null = null
let controls: OrbitControls | null = null
let skysphere: THREE.Mesh | null = null
let isPaused = false // 是否暂停渲染

// 背景渲染相关
const INITIAL_RENDER_FRAME_COUNT = 60 // 初始强制渲染帧数
const LOW_PERFORMANCE_FPS_THRESHOLD = 50
const LOW_PERFORMANCE_FPS_COUNTER_THRESHOLD = 5
const LOW_RESOLUTION_SCALE_FACTOR = 0.25
let backgroundScene: THREE.Scene | null = null // 背景场景（GaussianSplat + 天空球）
let vrmScene: THREE.Scene | null = null // VRM 场景
let backgroundRenderTarget: THREE.WebGLRenderTarget | null = null // 背景渲染目标
let backgroundPlane: THREE.Mesh | null = null // 用于显示背景纹理的平面
let needUpdateBackground = true // 是否需要更新背景
let initialRenderFrames = 0 // 初始渲染帧数计数器
let gaussianSplatReady = false // GaussianSplat3D 是否已准备好（从 viewer.viewer.splatRenderReady 同步）
let lowResolutionMode = false // 是否处于低分辨率模式
let lowPerformanceFpsCounter = 0 // 低性能 FPS 计数器

// 材质缓存
let skyMaterial: THREE.ShaderMaterial | null = null
let backgroundMaterial: THREE.ShaderMaterial | null = null

// VRM 引用
let vrmModel: any = null

// VRM 相关
const loader = new GLTFLoader()
loader.crossOrigin = 'anonymous'

// 注册VRMA加载插件
loader.register(parser => {
    return new VRMAnimationLoaderPlugin(parser)
})

// VRM控制器
const vrmController = new VrmController()

// 预加载器（使用 Worker 版本）
const preloader = new Preloader()
preloader.bindGLTFLoader(loader)

// 总体加载进度管理
const RESOURCE_LOADING_WEIGHT = 0.9 // 资源加载占90%
const SCENE_RENDERING_WEIGHT = 0.05 // 场景渲染占5%
const FORCE_WAIT_WEIGHT = 0.05 // 强制等待占5%

let resourceProgress = 0 // 资源加载进度 (0-100)
let sceneRenderingProgress = 0 // 场景渲染进度 (0-100)
let forceWaitProgress = 0 // 强制等待进度 (0-100)

// 计算总体加载进度
function calculateTotalProgress(): number {
    const calculated = Math.floor(
        resourceProgress * RESOURCE_LOADING_WEIGHT +
            sceneRenderingProgress * SCENE_RENDERING_WEIGHT +
            forceWaitProgress * FORCE_WAIT_WEIGHT
    )
    // 确保进度只增不减
    return Math.max(preloadProgress.value, calculated)
}

// 更新总体进度并触发事件
function updateTotalProgress() {
    const totalProgress = calculateTotalProgress()

    // 只在进度真正增加时才更新
    if (totalProgress > preloadProgress.value) {
        preloadProgress.value = totalProgress
        emit('loading', totalProgress)
    }

    if (totalProgress >= 100) {
        // 所有加载完成
        isLoading.value = false
        preloadProgress.value = 100

        emit('loaded')
        emit('ready')
    }
}

// 监听资源进度
preloader.on(PreloaderEvent.PROGRESS, (progress: any) => {
    resourceProgress = progress
    updateTotalProgress()
    
    // 性能优化：在资源加载阶段暂停3D渲染以减少GPU负载
    if (resourceProgress < 100) {
        isPaused = true
    }
})

function startForceWait() {
    const updateWaitProgress = () => {
        forceWaitProgress = Math.min(100, (initialRenderFrames / INITIAL_RENDER_FRAME_COUNT) * 100)
        updateTotalProgress()

        if (forceWaitProgress < 100) {
            requestAnimationFrame(updateWaitProgress)
        }
    }

    updateWaitProgress()
}

// 监听资源加载完成
preloader.on(PreloaderEvent.COMPLETED, (resources: any) => {
    // 资源加载完成，恢复渲染
    isPaused = false

    requestAnimationFrame(async () => {
        const model = resources.getByName('model').data
        const modelVrm = model.userData.vrm
        const idleAnimation = resources.getByName('idle_animation').data.userData.vrmAnimations[0]

        // 优化模型
        VRMUtils.removeUnnecessaryVertices(modelVrm.scene)
        VRMUtils.combineSkeletons(modelVrm.scene)

        // VRM 0.x 用的是左手坐标系,需要旋转
        if (modelVrm.meta.metaVersion == '0') {
            VRMUtils.rotateVRM0(modelVrm)
        }

        // 使用VrmController设置VRM模型
        vrmController.setVRM(modelVrm)

        // 保存VRM引用，用于位置控制
        vrmModel = modelVrm

        // 初始化 VRM 位置（只设置一次）
        vrmModel.scene.position.set(vrmPosition.value.x, vrmPosition.value.y, vrmPosition.value.z)
        vrmModel.scene.rotation.set(
            (vrmRotation.value.x * Math.PI) / 180,
            (vrmRotation.value.y * Math.PI) / 180,
            (vrmRotation.value.z * Math.PI) / 180
        )
        vrmModel.scene.scale.setScalar(vrmScale.value)

        // 注册并播放动画
        vrmController.registerVRMAnimation('idle', idleAnimation)
        vrmController.playAction('idle', {
            loop: true,
            resetSpringBones: false,
        })

        // Gaussian Splat 场景加载阶段
        try {
            // 获取预加载的 splat 数据
            const splatResource = resources.getByName('splat_scene')
            const splatData = splatResource.getData()

            // 将 ArrayBuffer 转为 Blob，然后创建 blob URL
            const blob = new Blob([splatData], { type: 'application/octet-stream' })
            const blobUrl = URL.createObjectURL(blob)

            // 使用 blob URL 加载场景，显式指定格式（.splat）
            await viewer.addSplatScenes(
                [
                    {
                        path: blobUrl,
                        format: GaussianSplats3D.SceneFormat.Splat, // 显式指定格式
                        splatAlphaRemovalThreshold: props.splatAlphaRemovalThreshold,
                        scale: props.splatScale,
                        position: props.splatPosition,
                    },
                ],
                false // 设置为 false 禁用 GaussianSplats3D 的内置加载UI
            )

            // 使用完 blob URL 后释放
            URL.revokeObjectURL(blobUrl)

            // 添加VRM到场景
            vrmScene?.add(modelVrm.scene)
            sceneRenderingProgress = 50
            emit('vrmLoaded', modelVrm)

            // 将viewer添加到背景场景中
            if (backgroundScene) {
                backgroundScene.add(viewer)
            }

            // 初始渲染一次背景
            needUpdateBackground = true

            // 开始动画循环
            animate()

            emit('splatLoaded')

            sceneRenderingProgress = 100

            startForceWait()
        } catch (error: any) {
            console.error('Failed to load Gaussian Splat scene:', error)
            isLoading.value = false
            errorMessage.value = `加载失败: ${error.message}`
            emit('error', error)
        }
    })
})

// 添加预加载资源
preloader.add(new PreloadResource('/fonts/ark-pixel-12px-monospaced-zh_cn.ttf.woff2', 'font'))
preloader.add(new PreloadResource(props.modelUrl, 'model'))
preloader.add(new PreloadResource(props.animationUrl, 'idle_animation'))
preloader.add(new PreloadResource(props.splatScenePath, 'splat_scene'))

// 创建一个时钟
const clock = new THREE.Clock()
clock.start()

// FPS 计算
const fpsUpdateInterval = 1
let frameCount = 0
let fpsUpdateTime = 0

// 相机移动检测
const cameraState = {
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
}
const cameraMoveThreshold = 0.001 // 位置阈值
const cameraRotateThreshold = 0.01 // 旋转阈值（弧度）

// 标记是否正在执行相机动画
let isCameraAnimating = false

/**
 * 检测相机是否移动
 */
function hasCameraMoved(): boolean {
    if (!camera) return false

    const positionMoved = camera.position.distanceTo(cameraState.position) > cameraMoveThreshold
    const rotationMoved = camera.quaternion.angleTo(cameraState.quaternion) > cameraRotateThreshold

    if (positionMoved || rotationMoved) {
        // 更新缓存状态
        cameraState.position.copy(camera.position)
        cameraState.quaternion.copy(camera.quaternion)
        needUpdateBackground = true // 标记需要更新背景
        return true
    }

    return false
}

/**
 * 更新 VRM 位置
 */
function updateVRMTransform() {
    if (vrmModel && vrmModel.scene) {
        // 检测 VRM 变换参数是否真正改变
        const positionChanged =
            vrmPosition.value.x !== lastVrmPosition.x ||
            vrmPosition.value.y !== lastVrmPosition.y ||
            vrmPosition.value.z !== lastVrmPosition.z

        const rotationChanged =
            vrmRotation.value.x !== lastVrmRotation.x ||
            vrmRotation.value.y !== lastVrmRotation.y ||
            vrmRotation.value.z !== lastVrmRotation.z

        const scaleChanged = vrmScale.value !== lastVrmScale

        // 只有在变换参数真正改变时才更新
        const hasChanged = positionChanged || rotationChanged || scaleChanged

        if (hasChanged) {
            vrmModel.scene.position.set(
                vrmPosition.value.x,
                vrmPosition.value.y,
                vrmPosition.value.z
            )
            vrmModel.scene.rotation.set(
                (vrmRotation.value.x * Math.PI) / 180,
                (vrmRotation.value.y * Math.PI) / 180,
                (vrmRotation.value.z * Math.PI) / 180
            )
            vrmModel.scene.scale.setScalar(vrmScale.value)

            // 更新 OrbitControls 的旋转中心为 VRM 模型中心（头部/胸部位置）
            if (controls) {
                const vrmCenterY = vrmPosition.value.y + props.cameraOffset * vrmScale.value // 根据缩放调整
                controls.target.set(vrmPosition.value.x, vrmCenterY, vrmPosition.value.z)
                controls.update()
            }

            // 更新缓存的变换参数
            lastVrmPosition = { ...vrmPosition.value }
            lastVrmRotation = { ...vrmRotation.value }
            lastVrmScale = vrmScale.value
        }
    }
}

/**
 * 低性能优化
 */

function createRenderTarget(w: number, h: number) {
    return new THREE.WebGLRenderTarget(
        w,
        h,
        {
            minFilter: THREE.LinearFilter,
            magFilter: THREE.LinearFilter,
            format: THREE.RGBAFormat,
        }
    )
}

function checkLowFPS(currentFps: number) {
    // 在高斯泼溅渲染阶段过半后再检测低帧率
    if (initialRenderFrames >= INITIAL_RENDER_FRAME_COUNT && !lowResolutionMode && currentFps < LOW_PERFORMANCE_FPS_THRESHOLD) {
        lowPerformanceFpsCounter++

        if (lowPerformanceFpsCounter >= LOW_PERFORMANCE_FPS_COUNTER_THRESHOLD) {
            // 切换到低分辨率模式
            lowResolutionMode = true
            setLowResolutionRenderTarget()
            initialRenderFrames = 0 // 重置初始渲染帧数计数器
            console.log('[Avatar] Low FPS detected: ', currentFps)

            // 记录设备低性能标记
            try {
                const rendererInfo = getRendererInfo()

                if (rendererInfo) {
                    localStorage.setItem('low_performance_device', rendererInfo)
                }
            } catch (e) {
                // ignore localStorage errors (e.g. private mode)
            }
        }
    }
}

function getRendererInfo(): string | null {
    if (!renderer) return 'unknown'

    const gl = renderer.getContext()
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info')
    if (debugInfo) {
        const vendor = gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL)
        const rendererInfo = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
        return `${vendor} - ${rendererInfo}`
    } else {
        return null
    }
}

const updateBackgroundTexture = () => {
    if (!backgroundPlane || !backgroundRenderTarget) {
        return
    }

    const material = backgroundPlane.material as THREE.ShaderMaterial | undefined

    if (material && material.uniforms?.tBackground) {
        material.uniforms.tBackground.value = backgroundRenderTarget.texture
        material.uniformsNeedUpdate = true
        needUpdateBackground = true
    }
}

function getLowResolutionDimensions() {
    if (!renderer) return { width: 0, height: 0 }

    const w = Math.floor(window.innerWidth * window.devicePixelRatio * LOW_RESOLUTION_SCALE_FACTOR)
    const h = Math.floor(window.innerHeight * window.devicePixelRatio * LOW_RESOLUTION_SCALE_FACTOR)

    return { width: w, height: h }
}

function setLowResolutionRenderTarget() {
    if (!renderer) return

    const { width: w, height: h } = getLowResolutionDimensions()

    if (backgroundRenderTarget) {
        backgroundRenderTarget.dispose()
    }

    backgroundRenderTarget = createRenderTarget(w, h)
    updateBackgroundTexture()
}

/**
 * 动画循环
 */
function animate() {
    animationId = requestAnimationFrame(animate)

    // 如果暂停则不渲染，同时不获取 delta 时间（避免累积）
    if (isPaused) {
        return
    }

    if (renderer && camera && vrmScene && backgroundScene && backgroundRenderTarget) {
        // 只有在渲染时才获取 delta，这样暂停期间不会累积时间
        const delta = clock.getDelta()

        // 更新 FPS
        frameCount++
        fpsUpdateTime += delta
        if (fpsUpdateTime >= fpsUpdateInterval) {
            fps.value = Math.ceil(frameCount / fpsUpdateTime)
            frameCount = 0
            fpsUpdateTime -= fpsUpdateInterval // 保留超出间隔的部分，保持计算连续性

            // 性能检测
            checkLowFPS(fps.value)
        }

        // 更新控制器（动画期间跳过，避免控制器干扰相机位置）
        if (controls && !isCameraAnimating) {
            controls.update()
        }

        // 检测相机是否移动
        hasCameraMoved()

        // 同步 GaussianSplat3D 的渲染就绪状态
        if (viewer && viewer.viewer && viewer.viewer.splatRenderReady && !gaussianSplatReady) {
            gaussianSplatReady = true
        }

        // 初始加载时强制渲染若干帧，确保 GaussianSplat3D 完整显示
        // 只有当 GaussianSplat3D 准备好后才开始计数
        const forceInitialRender =
            gaussianSplatReady && initialRenderFrames < INITIAL_RENDER_FRAME_COUNT
        if (forceInitialRender) {
            initialRenderFrames++
            needUpdateBackground = true
        }

        // 只在相机移动时或初始加载时更新背景（GaussianSplat3D + 天空球）
        if (needUpdateBackground) {
            // 渲染背景场景到 RenderTarget
            renderer.setRenderTarget(backgroundRenderTarget)
            renderer.render(backgroundScene, camera)
            renderer.setRenderTarget(null)

            if (!forceInitialRender) {
                needUpdateBackground = false
            } else if (initialRenderFrames === INITIAL_RENDER_FRAME_COUNT) {
                needUpdateBackground = false
            }
        }

        // 更新VRM（每帧都更新）
        if (vrmController.hasVRM()) {
            vrmController.update(delta)
            updateVRMTransform()
        }

        // 渲染 VRM 场景（包含背景纹理平面）
        renderer.render(vrmScene, camera)
    }
}

/**
 * 窗口大小变化处理
 */
function onWindowResize() {
    if (camera && renderer && backgroundRenderTarget && canvas.value) {
        // 使用 window 尺寸而不是 canvas.clientWidth/Height
        // 因为 canvas 的 CSS 尺寸可能还没有更新
        const width = window.innerWidth
        const height = window.innerHeight

        camera.aspect = width / height
        camera.updateProjectionMatrix()
        renderer.setSize(width, height)

        // 更新 RenderTarget 尺寸
        if (lowResolutionMode) {
            backgroundRenderTarget.setSize(
                Math.floor(width * window.devicePixelRatio * LOW_RESOLUTION_SCALE_FACTOR),
                Math.floor(height * window.devicePixelRatio * LOW_RESOLUTION_SCALE_FACTOR)
            )
        } else {
            backgroundRenderTarget.setSize(
                width * window.devicePixelRatio,
                height * window.devicePixelRatio
            )
        }

        // 标记需要更新背景
        needUpdateBackground = true
    }
}

/**
 * 页面可见性变化处理
 */
function onVisibilityChange() {
    if (document.hidden) {
        isPaused = true
    } else {
        // 页面回到前台，恢复渲染
        isPaused = false
        clock.getDelta()
        needUpdateBackground = true
    }
}

// 监听 Props 变化
watch(
    () => props.vrmPosition,
    newVal => {
        vrmPosition.value = { ...newVal }
    },
    { deep: true }
)

watch(
    () => props.vrmRotation,
    newVal => {
        vrmRotation.value = { ...newVal }
    },
    { deep: true }
)

watch(
    () => props.vrmScale,
    newVal => {
        vrmScale.value = newVal
    }
)

onMounted(async () => {
    try {
        // 1. 创建渲染器
        // 注意: GaussianSplats3D 不支持 WebGPU，必须使用 WebGL 渲染器
        if (!canvas.value) {
            throw new Error('Canvas element not found')
        }

        renderer = new THREE.WebGLRenderer({
            canvas: canvas.value,
            antialias: props.antialias,
        })

        // 禁用WebGLRenderer的checkShaderErrors以提升性能
        renderer.debug.checkShaderErrors = false

        // 使用 window 尺寸确保准确性
        const width = window.innerWidth
        const height = window.innerHeight
        renderer.setSize(width, height)
        renderer.setPixelRatio(window.devicePixelRatio)

        // 2. 创建 RenderTarget 用于背景渲染
        const rendererInfo = getRendererInfo()
        if (rendererInfo) {
            // 检查 localStorage 中是否有低性能设备标记
            const lowPerfFlag = localStorage.getItem('low_performance_device')
            if (lowPerfFlag && rendererInfo === lowPerfFlag) {
                lowResolutionMode = true
            }
        }

        if (lowResolutionMode) {
            const { width: w, height: h } = getLowResolutionDimensions()
            backgroundRenderTarget = createRenderTarget(w, h)
        } else {
            backgroundRenderTarget = createRenderTarget(
                width * window.devicePixelRatio,
                height * window.devicePixelRatio
            )
        }

        // 3. 创建背景场景（GaussianSplat + 天空球）
        backgroundScene = new THREE.Scene()

        // 创建天空球（半径调整为80，在远裁剪平面内）
        const skyGeometry = new THREE.SphereGeometry(80, 64, 64)

        // 复用或创建天空球材质
        if (!skyMaterial) {
            // 创建渐变材质的顶点着色器
            const skyVertexShader = `
                varying vec3 vWorldPosition;
                void main() {
                    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
                    vWorldPosition = worldPosition.xyz;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `

            // 创建渐变材质的片段着色器
            const skyFragmentShader = `
                uniform vec3 bottomColor;
                uniform vec3 color1;
                uniform vec3 color2;
                uniform vec3 color3;
                uniform vec3 topColor;
                varying vec3 vWorldPosition;
                
                void main() {
                    // 归一化y坐标 (-1 到 1)
                    float h = normalize(vWorldPosition).y;
                    
                    vec3 color;
                    
                    if (h < -0.2) {
                        // 底部50%: 纯色 5a829b
                        color = bottomColor;
                    } else if (h < 0.14) {
                        // 0% - 7%: fff2c5 到 eec6ad
                        float t = h / 0.14;
                        color = mix(color1, color2, t);
                    } else if (h < 0.5) {
                        // 7% - 25%: eec6ad 到 8c9f9e
                        float t = (h - 0.14) / 0.36;
                        color = mix(color2, color3, t);
                    } else if (h < 1.0) {
                        // 25% - 50%: 8c9f9e 到 53768a
                        float t = (h - 0.5) / 0.5;
                        color = mix(color3, topColor, t);
                    } else {
                        color = topColor;
                    }
                    
                    gl_FragColor = vec4(color, 1.0);
                }
            `

            skyMaterial = new THREE.ShaderMaterial({
                vertexShader: skyVertexShader,
                fragmentShader: skyFragmentShader,
                uniforms: {
                    bottomColor: { value: new THREE.Color(props.skyColors.bottom) },
                    color1: { value: new THREE.Color(props.skyColors.color1) },
                    color2: { value: new THREE.Color(props.skyColors.color2) },
                    color3: { value: new THREE.Color(props.skyColors.color3) },
                    topColor: { value: new THREE.Color(props.skyColors.top) },
                },
                side: THREE.BackSide, // 从内部看
                depthWrite: false,
            })
        }

        skysphere = new THREE.Mesh(skyGeometry, skyMaterial)
        skysphere.renderOrder = -1 // 最先渲染（背景）
        skysphere.frustumCulled = false
        backgroundScene.add(skysphere)

        // 添加环境光到背景场景
        const ambientLight = new THREE.AmbientLight(0xffffff, 4)
        backgroundScene.add(ambientLight)

        // 4. 创建 VRM 场景
        vrmScene = new THREE.Scene()

        // 复用或创建背景平面材质
        if (!backgroundMaterial) {
            backgroundMaterial = new THREE.ShaderMaterial({
                uniforms: {
                    tBackground: { value: backgroundRenderTarget.texture },
                },
                vertexShader: `
                    varying vec2 vUv;
                    void main() {
                        vUv = uv;
                        gl_Position = vec4(position, 1.0);
                    }
                `,
                fragmentShader: `
                    uniform sampler2D tBackground;
                    varying vec2 vUv;
                    void main() {
                        gl_FragColor = texture2D(tBackground, vUv);
                    }
                `,
                depthTest: false,
                depthWrite: false,
            })
        }

        // 创建一个全屏平面来显示背景纹理
        const backgroundGeometry = new THREE.PlaneGeometry(2, 2)
        backgroundPlane = new THREE.Mesh(backgroundGeometry, backgroundMaterial)
        backgroundPlane.renderOrder = -1000 // 最先渲染
        backgroundPlane.frustumCulled = false
        vrmScene.add(backgroundPlane)
        updateBackgroundTexture()

        // 添加环境光到 VRM 场景
        const vrmAmbientLight = new THREE.AmbientLight(0xffffff, 4)
        vrmScene.add(vrmAmbientLight)

        // 5. 创建相机
        camera = new THREE.PerspectiveCamera(
            props.cameraFov,
            width / height,
            0.1,
            100 // 缩短远裁剪平面，降低渲染距离
        )
        // 设置初始摄像头位置和旋转（等待推进动画）
        camera.position.set(
            cameraAnimationConfig.value.startPosition.x,
            cameraAnimationConfig.value.startPosition.y,
            cameraAnimationConfig.value.startPosition.z
        )
        camera.rotation.set(
            cameraAnimationConfig.value.startRotation.x,
            cameraAnimationConfig.value.startRotation.y,
            cameraAnimationConfig.value.startRotation.z
        )

        // 初始化相机状态缓存
        cameraState.position.copy(camera.position)
        cameraState.quaternion.copy(camera.quaternion)

        // 6. 创建控制器
        if (props.enableOrbitControls) {
            controls = new OrbitControls(camera, renderer.domElement)
            // 旋转中心设置为 VRM 模型的头部/胸部位置
            const vrmCenterY = vrmPosition.value.y + props.cameraOffset
            controls.target.set(vrmPosition.value.x, vrmCenterY, vrmPosition.value.z)

            // 控制器配置
            controls.enablePan = props.enablePan
            controls.enableRotate = props.enableRotate
            controls.enableZoom = props.enableZoom

            // 相机旋转限制
            controls.minPolarAngle = props.minPolarAngle
            controls.maxPolarAngle = props.maxPolarAngle
            controls.minAzimuthAngle = props.minAzimuthAngle
            controls.maxAzimuthAngle = props.maxAzimuthAngle

            // 缩放限制
            controls.minDistance = props.minDistance
            controls.maxDistance = props.maxDistance

            controls.update()
        }

        // 7. 预先导入VRM相关模块并注册插件（必须在 preloader.load() 之前）
        const { VRMLoaderPlugin } = await import('@pixiv/three-vrm')

        // 注册VRM加载插件（WebGL模式，使用默认材质）
        loader.register(parser => {
            const options: any = {
                lookAtPlugin: new VRMLookAtSmootherLoaderPlugin(parser),
            }

            return new VRMLoaderPlugin(parser, options)
        })

        // 8. 开始预加载VRM资源（插件已注册）
        preloader.load()

        // 9. 使用 DropInViewer 方式创建 GaussianSplats3D Viewer
        viewer = new GaussianSplats3D.DropInViewer({
            // Worker 配置
            sharedMemoryForWorkers: false, // 不使用 SharedArrayBuffer（避免安全限制）
            
            // 渲染质量优化
            sphericalHarmonicsDegree: 0,
            halfPrecisionCovariancesOnGPU: true, // 使用半精度浮点（减少 GPU 内存和带宽）
            
            // 排序优化
            integerBasedSort: true, // 使用整数排序
            
            // 场景优化
            dynamicScene: false,
            
            // 加载模式
            renderMode: GaussianSplats3D.RenderMode.Always, // 确保初始渲染完整
            sceneRevealMode: GaussianSplats3D.SceneRevealMode.Instant, // 场景立即显示

            // 启用 SIMD 指令加速排序
            enableSIMDInSort: true,
        })

        // 监听窗口变化
        window.addEventListener('resize', onWindowResize)

        // 监听页面可见性变化
        document.addEventListener('visibilitychange', onVisibilityChange)
    } catch (error: any) {
        console.error('Failed to initialize Avatar component:', error)
        isLoading.value = false
        errorMessage.value = `初始化失败: ${error.message}`
        emit('error', error)
    }
})

onUnmounted(() => {
    // 停止动画
    if (animationId) {
        cancelAnimationFrame(animationId)
        animationId = null
    }

    // 卸载事件
    window.removeEventListener('resize', onWindowResize)
    document.removeEventListener('visibilitychange', onVisibilityChange)

    // 清理 Preloader Worker
    if (preloader) {
        preloader.dispose()
    }

    // 清理VrmController
    if (vrmController) {
        vrmController.clearVRM()
    }

    // 清理VRM引用
    vrmModel = null

    // 清理背景平面
    if (backgroundPlane) {
        if (backgroundPlane.geometry) backgroundPlane.geometry.dispose()
        backgroundPlane = null
    }

    // 清理 RenderTarget
    if (backgroundRenderTarget) {
        backgroundRenderTarget.dispose()
        backgroundRenderTarget = null
    }

    // 清理天空球
    if (skysphere) {
        if (skysphere.geometry) skysphere.geometry.dispose()
        skysphere = null
    }

    // 销毁控制器
    if (controls) {
        controls.dispose()
        controls = null
    }

    // 销毁 viewer
    if (viewer) {
        try {
            viewer.dispose()
        } catch (error) {
            console.error('Error disposing viewer:', error)
        }
        viewer = null
    }

    // 清理场景
    if (backgroundScene) {
        backgroundScene.clear()
        backgroundScene = null
    }

    if (vrmScene) {
        vrmScene.clear()
        vrmScene = null
    }

    // 销毁渲染器
    if (renderer) {
        renderer.dispose()
        if (renderer.forceContextLoss) {
            renderer.forceContextLoss()
        }
        renderer = null
    }

    camera = null
})

/**
 * 相机推进动画
 * @param duration 动画持续时间（毫秒）
 */
const animateCameraZoom = (): Promise<void> => {
    return new Promise((resolve) => {
        if (!camera) {
            resolve()
            return
        }

        // 使用配置中的值
        const startPosition = { ...cameraAnimationConfig.value.startPosition }
        const startRotation = { ...cameraAnimationConfig.value.startRotation }
        const targetPosition = { ...cameraAnimationConfig.value.endPosition }
        const targetRotation = { ...cameraAnimationConfig.value.endRotation }

        // 设置初始位置和旋转
        camera.position.set(startPosition.x, startPosition.y, startPosition.z)
        camera.rotation.set(startRotation.x, startRotation.y, startRotation.z)

        // 标记正在执行动画
        isCameraAnimating = true

        // 禁用控制器
        const controlsWasEnabled = controls?.enabled ?? false
        if (controls) {
            controls.enabled = false
        }

        const startTime = performance.now()

        // 缓动函数：easeOutCubic
        const easeOutCubic = (t: number): number => {
            return 1 - Math.pow(1 - t, 3)
        }

        const animateStep = () => {
            if (!camera) {
                isCameraAnimating = false
                resolve()
                return
            }

            const now = performance.now()
            const elapsed = now - startTime
            const progress = Math.min(elapsed / cameraAnimationConfig.value.duration, 1)

            // 应用缓动曲线
            const easedProgress = easeOutCubic(progress)

            // 插值计算当前位置和旋转（X、Y、Z 三轴都进行平滑过渡）
            const currentX = startPosition.x + (targetPosition.x - startPosition.x) * easedProgress
            const currentY = startPosition.y + (targetPosition.y - startPosition.y) * easedProgress
            const currentZ = startPosition.z + (targetPosition.z - startPosition.z) * easedProgress
            
            const currentRotX = startRotation.x + (targetRotation.x - startRotation.x) * easedProgress
            const currentRotY = startRotation.y + (targetRotation.y - startRotation.y) * easedProgress
            const currentRotZ = startRotation.z + (targetRotation.z - startRotation.z) * easedProgress

            // 更新相机位置和旋转
            camera.position.set(currentX, currentY, currentZ)
            camera.rotation.set(currentRotX, currentRotY, currentRotZ)

            // 标记需要更新背景
            needUpdateBackground = true

            if (progress < 1) {
                requestAnimationFrame(animateStep)
            } else {
                // 动画完成，确保到达精确的目标位置
                camera.position.set(targetPosition.x, targetPosition.y, targetPosition.z)
                camera.rotation.set(targetRotation.x, targetRotation.y, targetRotation.z)
                
                // 动画完成
                isCameraAnimating = false
                
                // 恢复控制器
                if (controls && controlsWasEnabled) {
                    controls.enabled = true
                }
                
                resolve()
            }
        }

        animateStep()
    })
}

// 暴露给父组件的方法
defineExpose({
    getVrmController: () => vrmController,
    getVrmModel: () => vrmModel,
    getCamera: () => camera,
    getRenderer: () => renderer,
    getControls: () => controls,
    pause: () => {
        isPaused = true
    },
    resume: () => {
        isPaused = false
        clock.getDelta()
        needUpdateBackground = true
    },
    forceBackgroundUpdate: () => {
        needUpdateBackground = true
    },
    getLoadProgress: () => preloadProgress.value,
    startCameraZoomAnimation: animateCameraZoom,
})
</script>

<template>
    <div ref="main" class="avatar-container">
        <canvas ref="canvas" class="avatar-canvas"></canvas>
        <span v-if="props.showFps" class="fps">FPS: {{ fps }}</span>
        <div v-if="errorMessage" class="error">{{ errorMessage }}</div>
    </div>
</template>

<style scoped>
.avatar-container {
    position: relative;
    display: flex;
    justify-content: center;
    align-items: center;
    width: 100%;
    height: 100%;
    background-color: #000000;
    overflow: hidden;
}

.avatar-canvas {
    width: 100%;
    height: 100%;
}

.fps {
    position: absolute;
    top: 0;
    left: 0;
    font-size: 42px;
    padding: 0.5rem;
    color: #ffffff;
    background-color: rgba(0, 0, 0, 0.5);
    opacity: 1;
    z-index: 10;
}

.error {
    position: absolute;
    top: 50%;
    left: 50%;
    font-size: 21px;
    text-align: center;
    padding: 1rem;
    color: #ff0000;
    background-color: rgba(0, 0, 0, 0.8);
    border: 2px solid #ff0000;
    border-radius: 8px;
    transform: translate(-50%, -50%);
    max-width: 80%;
    word-wrap: break-word;
    z-index: 10;
}
</style>
