<script setup lang="ts">
/**
 * "记住的小事": browse, search, edit, import and export long-term memories.
 * Talks to the memory store directly; the parent only learns that something
 * changed so it can refresh its count.
 */
import { computed, ref, watch } from 'vue'
import CompanionSheet from './CompanionSheet.vue'
import IconBrain from '~icons/mdi/brain'
import { memoryStore, effectiveStrength, type MemoryCategory, type StoredMemory } from '@/lib/memory-store'

const props = defineProps<{ open: boolean; count: number }>()
const emit = defineEmits<{ close: []; changed: [] }>()

type MemoryView = StoredMemory & { strength: number }
const CATEGORIES = ['fact', 'preference', 'event', 'correction', 'context'] as const

const all = ref<MemoryView[]>([])
const query = ref('')
const sort = ref<'strongest' | 'recent' | 'important'>('strongest')
const groupBy = ref<'category' | 'none'>('category')
const editingId = ref<string | null>(null)
const editingContent = ref('')
const editingImportance = ref(5)
const editingConfidence = ref(5)
const fileInput = ref<HTMLInputElement | null>(null)

const load = async () => {
    try {
        const memories = await memoryStore.exportAll()
        all.value = memories.filter(m => m.isValid === 1).map(m => ({ ...m, strength: effectiveStrength(m) }))
    } catch (error) {
        console.warn('Failed to load memories:', error)
    }
}
watch(() => props.open, open => {
    if (open) void load()
    else editingId.value = null
}, { immediate: true })
const changed = async () => {
    await load()
    emit('changed')
}

const filtered = computed(() => {
    const q = query.value.trim().toLowerCase()
    const list = q ? all.value.filter(m => m.content.toLowerCase().includes(q)) : all.value
    const by = sort.value
    return [...list].sort((a, b) =>
        by === 'recent' ? b.createdAt - a.createdAt : by === 'important' ? b.importance - a.importance : b.strength - a.strength
    )
})
/** One group when flat, one per non-empty category when grouped; the card markup is shared. */
const groups = computed(() => {
    if (groupBy.value === 'none') return [{ key: 'all', label: '', items: filtered.value }]
    return CATEGORIES.map(cat => ({ key: cat, label: categoryLabel(cat), items: filtered.value.filter(m => m.category === cat) }))
        .filter(group => group.items.length > 0)
})

const categoryLabel = (cat: MemoryCategory) =>
    ({ fact: '事实', preference: '偏好', event: '事件', correction: '纠正', context: '背景' })[cat]
const subjectLabel = (subj: string) =>
    ({ user: '伙伴', character: '昔涟', world: '世界', relationship: '关系', other: '其他' } as Record<string, string>)[subj] ?? subj
const formatRelativeTime = (ts: number): string => {
    const mins = Math.floor((Date.now() - ts) / 60000)
    if (mins < 1) return '刚刚'
    if (mins < 60) return `${mins} 分钟前`
    const hours = Math.floor(mins / 60)
    if (hours < 24) return `${hours} 小时前`
    const days = Math.floor(hours / 24)
    if (days < 30) return `${days} 天前`
    return `${Math.floor(days / 30)} 个月前`
}

const remove = async (id: string) => {
    try {
        await memoryStore.invalidate(id)
        await changed()
    } catch (error) {
        console.warn('Failed to delete memory:', error)
    }
}
const startEdit = (m: MemoryView) => {
    editingId.value = m.id
    editingContent.value = m.content
    editingImportance.value = m.importance
    editingConfidence.value = m.confidence
}
const cancelEdit = () => { editingId.value = null }
const saveEdit = async () => {
    if (!editingId.value) return
    try {
        await memoryStore.update(editingId.value, {
            content: editingContent.value.trim(),
            importance: editingImportance.value,
            confidence: editingConfidence.value,
        })
        editingId.value = null
        await changed()
    } catch (error) {
        console.warn('Failed to update memory:', error)
    }
}
const exportAll = async () => {
    try {
        const memories = await memoryStore.exportAll()
        const blob = new Blob([JSON.stringify(memories, null, 2)], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `cyrene-memories-${new Date().toISOString().slice(0, 10)}.json`
        a.click()
        URL.revokeObjectURL(url)
    } catch (error) {
        console.warn('Export failed:', error)
    }
}
const triggerImport = () => fileInput.value?.click()
const handleImportFile = async (e: Event) => {
    const input = e.target as HTMLInputElement
    const file = input.files?.[0]
    if (!file) return
    try {
        const parsed = JSON.parse(await file.text())
        if (!Array.isArray(parsed)) {
            alert('导入失败：文件格式不正确')
            return
        }
        const count = await memoryStore.importMany(parsed)
        await changed()
        alert(`已导入 ${count} 条记忆`)
    } catch (error) {
        console.warn('Import failed:', error)
        alert('导入失败：' + (error instanceof Error ? error.message : '未知错误'))
    } finally {
        input.value = ''
    }
}
const clearAll = async () => {
    if (!confirm('确定要清除所有记忆吗？此操作不可恢复。')) return
    try {
        await memoryStore.clearAll()
        await changed()
    } catch (error) {
        console.warn('Failed to clear memories:', error)
    }
}
</script>

<template>
    <CompanionSheet :open="open" title="记住的小事" :subtitle="`留下了 ${count} 条记忆，你可以随时修改。`" wide @close="emit('close')">
        <div class="memory-content">
            <div class="px-8 pb-3 flex items-center gap-2 shrink-0">
                <input
                    v-model="query"
                    type="text"
                    placeholder="搜索记忆..."
                    class="flex-1 rounded-2xl border border-white/5 bg-black/20 px-4 py-2.5 text-[14px] text-white placeholder:text-white/30 focus:bg-black/40 focus:outline-none focus:ring-1 focus:ring-white/20"
                />
                <select v-model="sort" class="rounded-2xl border border-white/5 bg-black/20 px-3 py-2.5 text-[13px] text-white focus:outline-none">
                    <option value="strongest">按强度</option>
                    <option value="recent">按时间</option>
                    <option value="important">按重要性</option>
                </select>
                <button
                    @click="groupBy = groupBy === 'category' ? 'none' : 'category'"
                    class="rounded-2xl border border-white/5 bg-black/20 px-3 py-2.5 text-[13px] text-white/70 hover:bg-white/10 transition"
                    :title="groupBy === 'category' ? '取消分组' : '按类别分组'"
                >
                    {{ groupBy === 'category' ? '已分组' : '未分组' }}
                </button>
            </div>

            <div class="flex-1 overflow-y-auto px-8 pb-4">
                <div v-if="filtered.length === 0" class="py-12 text-center text-white/40">
                    <IconBrain class="mx-auto h-12 w-12 mb-4 opacity-50" />
                    <p v-if="all.length === 0">暂无记忆</p>
                    <p v-else>没有匹配的记忆</p>
                    <p class="text-sm mt-2" v-if="all.length === 0">与昔涟对话时，重要信息会被自动记住</p>
                </div>
                <div v-for="group in groups" :key="group.key" class="mb-4">
                    <h3 v-if="group.label" class="text-xs font-semibold text-white/40 uppercase tracking-wider mb-2 px-1">
                        {{ group.label }} ({{ group.items.length }})
                    </h3>
                    <div class="space-y-2">
                        <div
                            v-for="memory in group.items"
                            :key="memory.id"
                            class="group relative rounded-2xl border border-white/5 bg-white/5 p-4 transition hover:bg-white/10"
                        >
                            <div v-if="editingId === memory.id" class="space-y-3">
                                <textarea
                                    v-model="editingContent"
                                    rows="3"
                                    class="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-white/20 resize-none"
                                />
                                <div class="flex items-center gap-4 text-xs text-white/60">
                                    <label class="flex items-center gap-2 flex-1">
                                        <span class="shrink-0">重要性</span>
                                        <input v-model.number="editingImportance" type="range" min="1" max="10" class="flex-1 accent-pink-400" />
                                        <span class="w-6 text-center">{{ editingImportance }}</span>
                                    </label>
                                    <label class="flex items-center gap-2 flex-1">
                                        <span class="shrink-0">可信度</span>
                                        <input v-model.number="editingConfidence" type="range" min="1" max="10" class="flex-1 accent-blue-400" />
                                        <span class="w-6 text-center">{{ editingConfidence }}</span>
                                    </label>
                                </div>
                                <div class="flex justify-end gap-2">
                                    <button @click="cancelEdit" class="px-3 py-1.5 text-xs text-white/60 hover:text-white">取消</button>
                                    <button @click="saveEdit" class="px-4 py-1.5 text-xs font-medium bg-white/15 hover:bg-white/25 text-white rounded-full">保存</button>
                                </div>
                            </div>
                            <div v-else class="flex items-start gap-3">
                                <span class="shrink-0 rounded-lg bg-pink-500/15 px-2 py-1 text-[10px] font-medium text-pink-300">
                                    <template v-if="!group.label">{{ categoryLabel(memory.category) }}·</template>{{ subjectLabel(memory.subject) }}
                                </span>
                                <div class="flex-1 min-w-0">
                                    <p class="text-sm text-white/90 leading-relaxed">{{ memory.content }}</p>
                                    <div class="mt-2 flex items-center gap-3 text-[10px] text-white/30 flex-wrap">
                                        <span>重要 {{ memory.importance }}</span>
                                        <span>可信 {{ memory.confidence }}</span>
                                        <span>强度 {{ memory.strength.toFixed(1) }}</span>
                                        <span v-if="memory.accessCount > 0">访问 {{ memory.accessCount }}×</span>
                                        <span>{{ formatRelativeTime(memory.lastAccessedAt) }}</span>
                                        <span v-if="memory.expiresAt" class="text-amber-400/60">⏱ {{ formatRelativeTime(memory.expiresAt) }}</span>
                                    </div>
                                </div>
                                <div class="shrink-0 flex gap-1 memory-row-actions transition">
                                    <button @click="startEdit(memory)" class="flex h-6 w-6 items-center justify-center rounded-full bg-white/10 text-white/60 hover:bg-white/20 hover:text-white text-xs" title="编辑">✎</button>
                                    <button @click="remove(memory.id)" class="flex h-6 w-6 items-center justify-center rounded-full bg-red-500/20 text-red-300 hover:bg-red-500/40 text-xs" title="删除">×</button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <footer class="px-8 py-4 border-t border-white/5 shrink-0 flex items-center justify-between gap-2">
                <div class="flex gap-2">
                    <button @click="exportAll" class="rounded-full bg-white/10 hover:bg-white/20 px-4 py-2 text-xs font-medium text-white transition" :disabled="count === 0">导出</button>
                    <button @click="triggerImport" class="rounded-full bg-white/10 hover:bg-white/20 px-4 py-2 text-xs font-medium text-white transition">导入</button>
                    <input ref="fileInput" type="file" accept="application/json" class="hidden" @change="handleImportFile" />
                </div>
                <button v-if="count > 0" @click="clearAll" class="rounded-full border border-red-500/30 bg-red-500/10 px-4 py-2 text-xs font-medium text-red-300 transition hover:bg-red-500/20">清除所有</button>
            </footer>
        </div>
    </CompanionSheet>
</template>

<style scoped>
.memory-content > div,
.memory-content > footer {
    padding-left: 0;
    padding-right: 0;
}
.memory-content > .flex.items-center {
    flex-wrap: wrap;
}
.memory-content > .flex.items-center input {
    min-width: 120px;
}
.memory-row-actions {
    opacity: 0;
}
.group:hover .memory-row-actions,
.group:focus-within .memory-row-actions {
    opacity: 1;
}
button {
    cursor: pointer;
}
</style>
