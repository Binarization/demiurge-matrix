<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import CompanionSheet from './CompanionSheet.vue'

export type HistoryEntry = {
    id: string
    sender: 'self' | 'ally'
    text: string
    status: 'complete' | 'pending' | 'failed' | 'interrupted'
    speechInterrupted?: boolean
    timestamp: number
}

const props = defineProps<{ open: boolean; entries: HistoryEntry[]; memoryCount: number }>()
const emit = defineEmits<{ close: []; 'open-memory': []; export: [] }>()

// Follows new lines while the reader is at the bottom; stops once they scroll up.
const pages = ref<HTMLDivElement | null>(null)
const pinned = ref(true)
const trackScroll = () => {
    const el = pages.value
    if (el) pinned.value = el.scrollHeight - el.scrollTop - el.clientHeight < 72
}
const scrollToBottom = () => {
    nextTick(() => {
        const el = pages.value
        if (el && pinned.value) el.scrollTop = el.scrollHeight
    })
}
watch(() => [props.entries.length, props.entries[props.entries.length - 1]?.text], scrollToBottom)
const onOpened = () => {
    pinned.value = true
    scrollToBottom()
}

const messageDate = (timestamp: number) =>
    new Date(timestamp).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })
const note = (entry: HistoryEntry) =>
    entry.speechInterrupted
        ? '朗读已停下，文字仍在这里'
        : entry.status === 'pending'
          ? entry.sender === 'ally'
              ? '正在写下…'
              : '等待回应'
          : entry.status === 'failed'
            ? '这次回复没有完成'
            : '这一句停在了这里'
</script>

<template>
    <CompanionSheet :open="open" title="共同经历" subtitle="说过的话，留在这里。" wide @opened="onOpened" @close="emit('close')">
        <div class="history-tools">
            <button class="text-button" @click="emit('open-memory')" aria-label="记忆管理">
                记住的小事 <span>{{ memoryCount || '' }}</span></button
            ><button class="text-button" @click="emit('export')">导出记录</button>
        </div>
        <div ref="pages" class="conversation-pages" @scroll="trackScroll">
            <template v-for="(entry, index) in entries" :key="entry.id">
                <p v-if="index === 0 || messageDate(entry.timestamp) !== messageDate(entries[index - 1]!.timestamp)" class="memory-date">
                    {{ messageDate(entry.timestamp) }}
                </p>
                <article class="conversation-entry" :class="{ 'conversation-entry--self': entry.sender === 'self' }">
                    <span>{{ entry.sender === 'self' ? '你' : '昔涟' }}</span>
                    <p>{{ entry.text }}</p>
                    <small v-if="entry.status !== 'complete' || entry.speechInterrupted">{{ note(entry) }}</small>
                </article>
            </template>
        </div>
    </CompanionSheet>
</template>

<style scoped>
.history-tools {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding-bottom: 22px;
    font-size: 12px;
    color: #c9bfce;
}
.history-tools span {
    margin-left: 8px;
    font:
        10px ui-monospace,
        monospace;
    color: #aca3b8;
}
.conversation-pages {
    max-height: calc(100dvh - 220px);
    overflow-y: auto;
    padding-right: 6px;
    overscroll-behavior: contain;
    scrollbar-width: thin;
    scrollbar-color: #aca3b844 transparent;
}
.memory-date {
    margin: 0 0 25px;
    font-size: 11px;
    color: #aca3b8;
    letter-spacing: 0.1em;
}
.conversation-entry {
    margin-bottom: 26px;
    padding-left: 15px;
    border-left: 1px solid #e2b8cc55;
}
.conversation-entry > span {
    font-size: 11px;
    color: #e2b8cc;
}
.conversation-entry > p {
    font:
        16px/1.85 'Songti SC',
        'Noto Serif CJK SC',
        serif;
    margin: 7px 0;
    color: #e7e2ee;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
}
.conversation-entry small {
    display: block;
    color: #aca3b8;
    font-size: 10px;
}
.conversation-entry--self {
    border-color: #aca3b82b;
}
.conversation-entry--self > span {
    color: #aca3b8;
}
.conversation-entry--self > p {
    color: #c2baca;
    font:
        13px/1.85 'PingFang SC',
        sans-serif;
}
</style>
