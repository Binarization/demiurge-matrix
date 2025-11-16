<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Landing from './components/Landing.vue'
import Core from './components/Core.vue'
import PointerOverlay from './components/PointerOverlay.vue'
import { BackgroundMusicController } from './lib/backgroundMusic'

// 背景音乐控制器
const bgMusic = new BackgroundMusicController(0.4) // 默认音量 40%
const hasUserInteracted = ref(false)
const isInCore = ref(false) // 标记是否已经进入 Core 阶段

const showNextSection = ref(false)

// Avatar 加载进度
const avatarProgress = ref(0)

// Core 组件引用
const coreRef = ref<InstanceType<typeof Core> | null>(null)

const handleAvatarLoading = (progress: number) => {
    console.log(`[App] Avatar loading progress: ${progress.toFixed(2)}%`)
    avatarProgress.value = progress
}

const handleExplosionStart = () => {
    setTimeout(() => {
        requestAnimationFrame(() => {
            // 启动相机推进动画
            if (coreRef.value && coreRef.value.getAvatar()) {
                const avatar = coreRef.value.getAvatar()
                avatar?.resume()
                
                avatar?.startCameraZoomAnimation()
            } else {
                console.warn('[App] No avatar reference found')
            }
        })
    }, 500)
}

const handleLandingComplete = () => {
    showNextSection.value = true
    isInCore.value = true // 标记已进入 Core
    
    // Landing 结束，切换音乐（如果已经在播放）
    if (hasUserInteracted.value) {
        switchToHomelandMusic()
    }
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
            await bgMusic.load('/audios/homeland.mp3')
            await bgMusic.fadeIn(2000)
        } else {
            await bgMusic.load('/audios/zai_du_he_ni.flac')
            await bgMusic.fadeIn(2000)
        }
    } catch (error) {
        if (error instanceof Error && error.name !== 'NotAllowedError') {
            console.warn('Failed to start background music:', error)
        }
        hasUserInteracted.value = false
        return
    }
    
    // 移除事件监听
    document.removeEventListener('click', handleUserInteraction)
    document.removeEventListener('keydown', handleUserInteraction)
    document.removeEventListener('mousestart', handleUserInteraction)
    document.removeEventListener('touchend', handleUserInteraction)
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
    document.addEventListener('touchend', handleUserInteraction, { once: false })
})

onBeforeUnmount(() => {
    // 清理音乐控制器
    bgMusic.destroy().catch(error => {
        console.warn('Failed to destroy background music:', error)
    })
    
    // 移除事件监听（如果还未触发）
    document.removeEventListener('click', handleUserInteraction)
    document.removeEventListener('keydown', handleUserInteraction)
    document.removeEventListener('mousestart', handleUserInteraction)
    document.removeEventListener('touchend', handleUserInteraction)
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
                @explosion-start="handleExplosionStart"
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
                    <p class="music-hint-text">点&zwj;击&zwj;任&zwj;意&zwj;位&zwj;置&zwnj;开&zwj;始&zwj;体&zwj;验</p>
                </div>
            </div>
        </Transition>

        <PointerOverlay />
    </div>
</template>

<style scoped>
:global(html, body, #app) {
    height: 100%;
    width: 100%;
    margin: 0;
    padding: 0;
    background: #000;
    cursor: none;
}

.app-root {
    position: relative;
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
    transition: opacity 0.4s ease-out;
}

.music-hint-fade-leave-active {
    transition: opacity 0.4s ease-out 0.2s;
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
