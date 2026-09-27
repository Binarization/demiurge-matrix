<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import Landing from './components/Landing.vue'
import Core from './components/Core.vue'
const entered = ref(false)
const avatarProgress = ref(0)
const coreRef = ref<InstanceType<typeof Core> | null>(null)
const musicEnabled = ref(false)
const musicBusy = ref(false)
const musicError = ref('')
let audio: HTMLAudioElement | null = null
let disposed = false
let musicGeneration = 0
let entryTimer: ReturnType<typeof setTimeout> | undefined
const handleExplosionStart = () => {
    entryTimer = setTimeout(() => {
        requestAnimationFrame(() => {
            if (disposed) return
            const avatar = coreRef.value?.getAvatar()
            avatar?.resume()
            void avatar?.startCameraZoomAnimation()
        })
    }, 500)
}
const handleLandingComplete = () => {
    entered.value = true
    coreRef.value?.getAvatar()?.resume()
}
// Music starts only from this explicit action, never from arbitrary input.
const toggleMusic = async () => {
    const generation = ++musicGeneration
    musicError.value = ''
    if (musicEnabled.value || musicBusy.value) {
        audio?.pause()
        musicEnabled.value = false
        musicBusy.value = false
        return
    }
    audio ??= new Audio('/audios/homeland.mp3')
    audio.loop = true
    audio.volume = 0.18
    musicBusy.value = true
    try {
        await audio.play()
        if (disposed || generation !== musicGeneration) return
        musicEnabled.value = true
    } catch {
        if (generation === musicGeneration) musicError.value = '音乐暂时无法播放，可以稍后再试。'
    } finally {
        if (generation === musicGeneration) musicBusy.value = false
    }
}
onBeforeUnmount(() => {
    disposed = true
    clearTimeout(entryTimer)
    musicGeneration++
    audio?.pause()
    if (audio) audio.src = ''
})
</script>
<template>
    <div class="app-root">
        <Core
            ref="coreRef"
            :music-enabled="musicEnabled"
            :music-busy="musicBusy"
            :music-error="musicError"
            @toggle-music="toggleMusic"
            @dismiss-music-error="musicError = ''"
            @loading="avatarProgress = $event"
        />
        <Transition name="arrival-fade"
            ><Landing
                v-if="!entered"
                :external-progress="avatarProgress"
                @explosion-start="handleExplosionStart"
                @complete="handleLandingComplete"
        /></Transition>
    </div>
</template>
<style scoped>
:global(html),
:global(body),
:global(#app) {
    height: 100%;
    width: 100%;
    margin: 0;
    padding: 0;
    background: #24212e;
}
:global(body) {
    font-family: 'PingFang SC', 'Microsoft YaHei', sans-serif;
}
.app-root {
    position: relative;
}
.arrival-fade-leave-active {
    transition: opacity 0.25s ease-out;
}
.arrival-fade-leave-to {
    opacity: 0;
}
@media (prefers-reduced-motion: reduce) {
    .arrival-fade-leave-active {
        transition: none;
    }
}
</style>
