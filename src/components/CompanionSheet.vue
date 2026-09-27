<script setup lang="ts">
import { nextTick, ref, useId, watch } from 'vue'
const props = defineProps<{ open: boolean; title: string; subtitle?: string; wide?: boolean }>()
const emit = defineEmits<{ close: []; opened: [] }>()
const dialog = ref<HTMLDialogElement | null>(null)
const titleId = useId()
watch(
    () => props.open,
    async value => {
        await nextTick()
        if (value && dialog.value && !dialog.value.open) {
            dialog.value.showModal()
            emit('opened')
        }
        if (!value && dialog.value?.open) dialog.value.close()
    },
    { immediate: true }
)
const dismissBackdrop = (event: MouseEvent) => {
    if (!dialog.value || event.target !== dialog.value) return
    const rect = dialog.value.getBoundingClientRect()
    if (
        event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom
    )
        emit('close')
}
</script>

<template>
    <Teleport to="body">
        <dialog
            ref="dialog"
            class="companion-sheet"
            :class="{ 'companion-sheet--wide': wide }"
            :aria-labelledby="titleId"
            @cancel.prevent="emit('close')"
            @click="dismissBackdrop"
            @close="props.open && emit('close')"
        >
            <header class="sheet-heading">
                <div>
                    <h2 :id="titleId">{{ title }}</h2>
                    <p v-if="subtitle">{{ subtitle }}</p>
                </div>
                <button
                    type="button"
                    class="sheet-close"
                    :aria-label="`关闭${title}`"
                    @click="emit('close')"
                >
                    ×
                </button>
            </header>
            <div class="sheet-content"><slot /></div>
        </dialog>
    </Teleport>
</template>

<style scoped>
.companion-sheet {
    --petal: #e2b8cc;
    --mist: #e7e2ee;
    color: var(--mist);
    font-family: 'PingFang SC', 'Microsoft YaHei', sans-serif;
    position: fixed;
    inset: 16px 16px 16px auto;
    margin: 0;
    width: min(400px, calc(100vw - 32px));
    height: calc(100dvh - 32px);
    max-height: none;
    max-width: none;
    padding: 0;
    border: 1px solid #e7e2ee22;
    border-radius: 22px;
    background: #24212ef5;
    box-shadow: 0 12px 50px #15121c38;
    overflow: hidden;
}
.companion-sheet[open] {
    display: flex;
    flex-direction: column;
    animation: arrive 0.24s ease-out;
}
.companion-sheet--wide {
    width: min(510px, calc(100vw - 32px));
}
.companion-sheet::backdrop {
    background: #19152020;
}
.sheet-heading {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    flex: 0 0 auto;
    gap: 20px;
    margin: 0 26px;
    padding: 26px 0 22px;
    border-bottom: 1px solid #e7e2ee16;
}
.sheet-heading h2 {
    font:
        400 23px/1.3 'Songti SC',
        'Noto Serif CJK SC',
        serif;
    letter-spacing: 0.08em;
    margin: 0;
}
.sheet-heading p {
    font-size: 12px;
    line-height: 1.7;
    color: #aca3b8;
    margin: 9px 0 0;
}
.sheet-close {
    width: 36px;
    height: 36px;
    flex-shrink: 0;
    border: 0;
    border-radius: 50%;
    background: transparent;
    color: #aca3b8;
    font-size: 24px;
    cursor: pointer;
}
.sheet-close:hover {
    color: #fff;
    background: #ffffff0b;
}
.sheet-content {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-width: thin;
    scrollbar-color: #aca3b855 transparent;
    padding: 22px 26px 28px;
}
:deep(button),
:deep(summary),
:deep(select) {
    cursor: pointer;
}
:deep(button:disabled) {
    cursor: not-allowed;
}
:deep(:focus-visible),
.sheet-close:focus-visible {
    outline: 2px solid #e2b8cc;
    outline-offset: 4px;
}
@keyframes arrive {
    from {
        opacity: 0;
        transform: translateX(14px);
    }
    to {
        opacity: 1;
        transform: none;
    }
}
@media (max-width: 600px) {
    .companion-sheet,
    .companion-sheet--wide {
        inset: auto 0 0;
        width: 100%;
        max-height: 88dvh;
        height: auto;
        border-radius: 24px 24px 0 0;
    }
    .sheet-content {
        padding-bottom: max(24px, env(safe-area-inset-bottom));
    }
}
@media (prefers-reduced-motion: reduce) {
    .companion-sheet[open] {
        animation: none;
    }
}
</style>
