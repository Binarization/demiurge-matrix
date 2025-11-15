<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Landing from './components/Landing.vue'
import Core from './components/Core.vue'
import PointerOverlay from './components/PointerOverlay.vue'
import { BackgroundMusicController } from './lib/backgroundMusic'

type CurtainPhase = 'idle' | 'hold' | 'fade'
const CURTAIN_FADE_DELAY = 0 // 无延迟
const CURTAIN_FADE_DURATION = 250 // 0.25秒完成白色窗帘过渡

// 背景音乐控制器
const bgMusic = new BackgroundMusicController(0.4) // 默认音量 40%
const hasUserInteracted = ref(false)
const isInCore = ref(false) // 标记是否已经进入 Core 阶段

const showNextSection = ref(false)
const curtainPhase = ref<CurtainPhase>('idle')
const curtainSkipTransition = ref(false)
let curtainTimer: number | undefined

// Avatar 加载进度
const avatarProgress = ref(0)

// Core 组件引用
const coreRef = ref<InstanceType<typeof Core> | null>(null)

const handleAvatarLoading = (progress: number) => {
    avatarProgress.value = progress
}

const handleLandingComplete = () => {
    curtainSkipTransition.value = true
    curtainPhase.value = 'hold'
    showNextSection.value = true
    isInCore.value = true // 标记已进入 Core
    
    if (curtainTimer) {
        window.clearTimeout(curtainTimer)
    }
    curtainTimer = window.setTimeout(() => {
        curtainSkipTransition.value = false
        curtainPhase.value = 'fade'
        
        // Landing 结束，切换音乐（如果已经在播放）
        if (hasUserInteracted.value) {
            switchToHomelandMusic()
        }
    }, CURTAIN_FADE_DELAY)
}

// 切换到 homeland 音乐
const switchToHomelandMusic = async () => {
    try {
        await bgMusic.crossfade('/audios/homeland.mp3', 1500, 2000)
    } catch (error) {
        console.warn('Failed to switch music:', error)
    }
}

// 处理用户交互，启动背景音乐
const handleUserInteraction = async () => {
    if (hasUserInteracted.value) return
    hasUserInteracted.value = true
    
    try {
        // 根据当前阶段选择播放的音乐
        if (isInCore.value) {
            // 如果已经在 Core 阶段，直接播放 homeland
            await bgMusic.load('/audios/homeland.mp3')
            await bgMusic.fadeIn(2000)
        } else {
            // 如果还在 Landing 阶段，播放 zai_du_yu_ni
            await bgMusic.load('/audios/zai_du_yu_ni.flac')
            await bgMusic.fadeIn(2000)
        }
    } catch (error) {
        console.warn('Failed to start background music:', error)
    }
    
    // 移除事件监听
    document.removeEventListener('click', handleUserInteraction)
    document.removeEventListener('keydown', handleUserInteraction)
    document.removeEventListener('touchstart', handleUserInteraction)
}

const handleCurtainTransitionEnd = (event: TransitionEvent) => {
    if (event.propertyName !== 'opacity' || event.target !== event.currentTarget) {
        return
    }
    if (curtainPhase.value === 'fade') {
        curtainPhase.value = 'idle'
        // 窗帘动画结束后，恢复 Avatar 的渲染
        if (coreRef.value && coreRef.value.getAvatar()) {
            coreRef.value.getAvatar()?.resume()
        }
    }
}

// 监听 showNextSection 变化，当 Landing 消失时恢复 Avatar 渲染
watch(showNextSection, (value) => {
    if (value && coreRef.value && coreRef.value.getAvatar()) {
        // Landing 消失，恢复 Avatar 渲染
        coreRef.value.getAvatar()?.resume()
    }
})

// 初始化用户交互监听
onMounted(() => {
    // 添加全局事件监听,等待用户交互后启动音乐
    document.addEventListener('click', handleUserInteraction, { once: false })
    document.addEventListener('keydown', handleUserInteraction, { once: false })
    document.addEventListener('mousestart', handleUserInteraction, { once: false })
})

onBeforeUnmount(() => {
    if (curtainTimer) {
        window.clearTimeout(curtainTimer)
    }
    
    // 清理音乐控制器
    bgMusic.destroy()
    
    // 移除事件监听（如果还未触发）
    document.removeEventListener('click', handleUserInteraction)
    document.removeEventListener('keydown', handleUserInteraction)
    document.removeEventListener('touchstart', handleUserInteraction)
    document.removeEventListener('mousestart', handleUserInteraction)
})
</script>

<template>
    <div class="app-root">
        <!-- Core 始终渲染，为了加载 Avatar -->
        <Core
            ref="coreRef"
            v-show="true"
            @loading="handleAvatarLoading"
        />

        <!-- Landing 遮罩层，加载完成后消失 -->
        <Transition name="landing-fade">
            <Landing
                v-if="!showNextSection"
                :external-progress="avatarProgress"
                @complete="handleLandingComplete"
            />
        </Transition>

        <PointerOverlay />

        <!-- 音乐提示 -->
        <Transition name="music-hint-fade">
            <div v-if="!hasUserInteracted" class="music-hint">
                <div class="music-hint-content">
                    <svg
                        class="music-icon"
                        xmlns="http://www.w3.org/2000/svg"
                        viewBox="0 0 24 24"
                        fill="currentColor"
                    >
                        <path
                            d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"
                        />
                    </svg>
                    <p class="music-hint-text">点击任意位置开始体验</p>
                </div>
            </div>
        </Transition>

        <div
            class="white-curtain"
            :class="{
                'white-curtain--hold': curtainPhase === 'hold',
                'white-curtain--fade': curtainPhase === 'fade',
                'white-curtain--no-transition': curtainSkipTransition,
            }"
            :style="{ '--curtain-duration': `${CURTAIN_FADE_DURATION}ms` }"
            @transitionend="handleCurtainTransitionEnd"
        ></div>
    </div>
</template>

<style scoped>
:global(html, body, #app) {
    cursor: none;
}

.app-root {
    position: relative;
}

.white-curtain {
    position: fixed;
    inset: 0;
    background: #fff;
    opacity: 0;
    pointer-events: none;
    transition: opacity var(--curtain-duration, 1.4s) cubic-bezier(0.2, 0.8, 0.2, 1);
    z-index: 30;
}

.white-curtain--hold {
    opacity: 1;
}

.white-curtain--fade {
    opacity: 0;
}

.white-curtain--no-transition {
    transition: none !important;
}

/* Landing 淡出过渡 */
.landing-fade-enter-active,
.landing-fade-leave-active {
    transition: opacity 0.25s ease-out;
}

.landing-fade-enter-from,
.landing-fade-leave-to {
    opacity: 0;
}

.landing-fade-enter-to,
.landing-fade-leave-from {
    opacity: 1;
}

/* 音乐提示样式 */
.music-hint {
    position: fixed;
    bottom: 64px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 60;
    pointer-events: none;
}

.music-hint-content {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 16px 28px;
    background: rgba(255, 255, 255, 0.95);
    border-radius: 50px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
    backdrop-filter: blur(10px);
    animation: music-hint-pulse 2s ease-in-out infinite;
}

.music-icon {
    width: 24px;
    height: 24px;
    color: #333;
}

.music-hint-text {
    margin: 0;
    font-size: 14px;
    font-weight: 500;
    color: #333;
    letter-spacing: 0.5px;
}

@keyframes music-hint-pulse {
    0%,
    100% {
        opacity: 1;
        transform: scale(1);
    }
    50% {
        opacity: 0.8;
        transform: scale(0.98);
    }
}

.music-hint-fade-enter-active {
    transition: opacity 0.8s ease-out 1s;
}

.music-hint-fade-leave-active {
    transition: opacity 0.4s ease-out;
}

.music-hint-fade-enter-from,
.music-hint-fade-leave-to {
    opacity: 0;
}

.music-hint-fade-enter-to,
.music-hint-fade-leave-from {
    opacity: 1;
}
</style>
