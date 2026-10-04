<script setup lang="ts">
import CompanionSheet from './CompanionSheet.vue'
import { ACTION_LABELS, type BodyAction } from '@/avatar/scene/BodyDirector'
import type { CameraView } from '@/avatar/scene/CameraDirector'

defineProps<{ open: boolean; busy: boolean; seated: boolean }>()
const emit = defineEmits<{ close: []; camera: [view: CameraView]; action: [action: BodyAction] }>()

const ACTIONS = ['approach', 'return', 'stretch', 'wave', 'offer_hand', 'headpat', 'sit', 'stand'] as const
const SEATED_BLOCKED: readonly BodyAction[] = ['approach', 'return', 'stretch', 'sit']
</script>

<template>
    <CompanionSheet :open="open" title="一起待一会儿" subtitle="轻触她的头或手，也会有回应。" @close="emit('close')">
        <div class="scene-options">
            <p>换个距离</p>
            <div class="scene-choice-row">
                <button class="soft-button" @click="emit('camera', 'companion')">陪伴视角</button>
                <button class="soft-button" @click="emit('camera', 'full')">看看全身</button>
                <button class="soft-button" @click="emit('camera', 'close')">近一点看</button>
            </div>
            <p>此刻，做点什么</p>
            <div class="scene-action-grid">
                <button
                    v-for="action in ACTIONS"
                    :key="action"
                    class="soft-button"
                    :disabled="busy || (action === 'stand' && !seated) || (seated && SEATED_BLOCKED.includes(action))"
                    @click="emit('action', action)"
                >
                    {{ ACTION_LABELS[action] }}
                </button>
            </div>
            <p class="scene-hint">在她头上轻轻划过，可以摸摸头。拖动空白处可以转动视角；手动调整时，镜头会听你的。</p>
        </div>
    </CompanionSheet>
</template>

<style scoped>
.scene-options { display: grid; gap: 18px; padding: 6px 0; }
.scene-options > p { color: var(--muted, #aca3b8); font-size: 12px; }
.scene-choice-row { display: flex; flex-wrap: wrap; gap: 8px; }
.scene-action-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.scene-hint { line-height: 1.9; }
</style>
