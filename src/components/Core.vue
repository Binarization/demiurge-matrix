<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref } from 'vue'
import { buildCyrenePrompt } from '@/lib/persona/cyrene'
import { createSession, loadConversation, saveConversation, recentConversation, conversationRecallTool, type ConversationEntry } from '@/lib/conversation-store'
import { LocalVoiceController, type VoiceBackend } from '@/lib/voice/controller'
import type { PhraseStream } from '@/lib/voice/phrase-stream'
import { advanceMood, restingMood, type InteractionState } from '@/lib/interaction'
import IconChatProcessingOutline from '~icons/mdi/chat-processing-outline'
import IconCog from '~icons/mdi/cog'
import IconBrain from '~icons/mdi/brain'
import { Agent } from '@/lib/agent'
import { loadStoredOpenRouterConfig, saveStoredOpenRouterConfig } from '@/lib/openrouter-config'
import { memoryStore, effectiveStrength, type StoredMemory, type MemoryCategory } from '@/lib/memory-store'
import { getGreetingMemories, formatMemoriesForPrompt } from '@/lib/memory-tools'
import { OpenRouterClient } from '@/lib/openrouter'
import { loadEmbeddingsConfig, saveEmbeddingsConfig, DEFAULT_EMBEDDINGS_CONFIG, type StoredEmbeddingsConfig } from '@/lib/embeddings-config'
import Avatar from '@/avatar/components/Avatar.vue'
import { generateChatSuggestions } from '@/lib/chatSuggestions'
import { EMOTION_NAMES, type EmotionName } from '@/avatar/utils/VrmController'

// Emotion-tag parser. The agent emits a leading `<emote happy=0.7 ... />` tag
// on each reply. We strip it before display and feed the values into the
// VRM expression tween.
const EMOTE_TAG_RE = /^\s*<emote\b([^>]*)\/?>\s*/i
const EMOTE_ATTR_RE = /(\w+)\s*=\s*"?([0-9.]+)"?/g

const parseEmoteTag = (text: string): { stripped: string; emotions: Partial<Record<EmotionName, number>> | null } => {
    const match = text.match(EMOTE_TAG_RE)
    if (!match) return { stripped: /^\s*<(?:e(?:m(?:o(?:t(?:e)?)?)?)?)?$/i.test(text) || /^\s*<emote\b[^>]*$/i.test(text) ? '' : text, emotions: null }
    const attrs = match[1] ?? ''
    const emotions: Partial<Record<EmotionName, number>> = {}
    for (const m of attrs.matchAll(EMOTE_ATTR_RE)) {
        const key = (m[1] ?? '').toLowerCase() as EmotionName
        const value = parseFloat(m[2] ?? '')
        if (EMOTION_NAMES.includes(key) && Number.isFinite(value)) {
            emotions[key] = Math.max(0, Math.min(1, value))
        }
    }
    const stripped = text.slice(match[0].length)
    return { stripped, emotions: Object.keys(emotions).length > 0 ? emotions : {} }
}

// Lightweight Chinese keyword fallback, used only when the model omits the
// tag entirely. Single dominant emotion at modest intensity.
const KEYWORD_LEXICON: Array<{ name: EmotionName; words: string[] }> = [
    { name: 'happy', words: ['开心', '高兴', '喜欢', '真好', '太棒', '哈哈', '嘻嘻', '♪', '❤', '~'] },
    { name: 'sad', words: ['难过', '伤心', '失落', '寂寞', '想哭', '唉', '抱歉', '对不起'] },
    { name: 'angry', words: ['生气', '讨厌', '气死', '可恶', '不爽'] },
    { name: 'surprised', words: ['惊讶', '吓', '哇', '诶？', '诶?', '真的吗', '不会吧'] },
    { name: 'relaxed', words: ['安心', '舒服', '轻松', '放心', '嗯～', '嗯嗯'] },
]

const keywordFallback = (text: string): Partial<Record<EmotionName, number>> | null => {
    if (!text) return null
    for (const entry of KEYWORD_LEXICON) {
        if (entry.words.some(w => text.includes(w))) {
            return { [entry.name]: 0.5 }
        }
    }
    return null
}

// 定义 emits
const emit = defineEmits<{
    (e: 'loading', progress: number): void
    (e: 'ready'): void
}>()

const isChatOpen = ref(false)
const chatMessagesRef = ref<HTMLDivElement | null>(null)
const isSettingsOpen = ref(false)
const isMemoryPanelOpen = ref(false)
const settingsSaved = ref(false)
const isResponding = ref(false)
const chatError = ref('')
const memoryCount = ref(0)
let agentInstance: Agent | null = null

// Credentials must be supplied by the user; never ship a shared browser key.
const getDefaultConfig = () => ({
    apiKey: '',
    model: 'z-ai/glm-4.5-air:free',
})

const settingsForm = reactive({
    apiKey: getDefaultConfig().apiKey,
    model: getDefaultConfig().model,
})
const embeddingsForm = reactive<StoredEmbeddingsConfig>({ ...DEFAULT_EMBEDDINGS_CONFIG })
const session = reactive(createSession())
const messages = computed(() => session.messages.map(entry => ({
    id: entry.id, sender: entry.role === 'user' ? 'self' : 'ally',
    text: entry.role === 'assistant' ? parseEmoteTag(entry.content).stripped : entry.content,
    status: entry.status, speechInterrupted: entry.speechInterrupted,
})))
const storageError = ref('')
let storageWritable = true
const interactionState = ref<InteractionState>('idle')
const stateLabels: Record<InteractionState, string> = { idle: '陪在这里', listening: '正在倾听', thinking: '正在想你说的话', speaking: '正在说话', interrupted: '好，你说' }
const localVoice = new LocalVoiceController()
const voiceBackend = computed<VoiceBackend>({ get: () => session.voiceBackend ?? 'webgpu', set: value => { session.voiceBackend = value } })
const voiceReady = ref(false)
const voiceLoading = ref(false)
const voiceStatus = ref('请先加载昔涟声音，加载并预热成功后才能开启朗读。')
const voiceMetrics = ref('')
const firstAudioLatency = ref('')
let voiceLoadGeneration = 0
localVoice.onStatus = text => { voiceStatus.value = text }
localVoice.onReady = ready => {
    voiceReady.value = ready
    if (!ready) session.voiceEnabled = false
}
localVoice.onMetrics = m => { voiceMetrics.value = `合成 ${(Number(m.totalMs) / 1000).toFixed(2)} 秒 · 音频 ${Number(m.audioSeconds).toFixed(2)} 秒` }
const changeVoiceBackend = () => {
    voiceLoadGeneration++
    interrupt(); localVoice.dispose(); voiceLoading.value = false
    session.voiceEnabled = false; persistSession()
    voiceStatus.value = '请加载所选后端的昔涟声音。'; voiceMetrics.value = ''
}
const prepareVoice = async (restoreEnabled = false) => {
    const generation = ++voiceLoadGeneration
    voiceLoading.value = true
    try {
        await localVoice.initialize(voiceBackend.value)
        if (generation !== voiceLoadGeneration || disposed) return
        if (restoreEnabled) session.voiceEnabled = true
        persistSession()
    } catch (e) {
        if (generation !== voiceLoadGeneration || disposed) return
        session.voiceEnabled = false; voiceStatus.value = String(e); persistSession()
    } finally { if (generation === voiceLoadGeneration) voiceLoading.value = false }
}
const voiceError = ref('')
const activeSpeechId = ref<string | null>(null)
let requestController: AbortController | null = null
let activeEntry: ConversationEntry | null = null
let activeAnswer: ConversationEntry | null = null
let runGeneration = 0
let suggestionGeneration = 0
let disposed = false
const persistSession = () => {
    if (!storageWritable) return
    try { saveConversation(session); storageError.value = '' }
    catch { storageError.value = '对话暂时无法保存，请导出记录备份，避免刷新后丢失。' }
}
const appendEntry = (role: 'user' | 'assistant', content: string, status: ConversationEntry['status'] = 'complete') => {
    const entry: ConversationEntry = { id: crypto.randomUUID(), role, content, status, timestamp: Date.now() }
    session.messages.push(entry)
    persistSession()
    return session.messages[session.messages.length - 1]!
}
const setInteraction = (state: InteractionState) => {
    interactionState.value = state
    avatarRef.value?.getVrmController?.()?.setInteractionState(state)
}
const interrupt = () => {
    const wasBusy = isResponding.value || activeSpeechId.value !== null
    runGeneration++
    suggestionGeneration++
    requestController?.abort()
    requestController = null
    if (activeEntry?.status === 'pending') activeEntry.status = 'interrupted'
    if (activeAnswer?.status === 'pending') activeAnswer.status = 'interrupted'
    activeAnswer = null
    activeEntry = null
    if (activeSpeechId.value) {
        const entry = session.messages.find(m => m.id === activeSpeechId.value)
        if (entry) entry.speechInterrupted = true
    }
    localVoice.stop()
    activeSpeechId.value = null
    isResponding.value = false
    isGeneratingSuggestions.value = false
    agentInstance = null
    if (wasBusy) setInteraction('interrupted')
    persistSession()
}
const onInputFocus = () => {
    if (activeSpeechId.value) interrupt()
    if (!isResponding.value) setInteraction('listening')
}
const onInputBlur = () => { if (interactionState.value === 'listening') setInteraction('idle') }
const startVoiceStream = (entry: ConversationEntry, requestedAt?: number): PhraseStream | null => {
    if (!voiceReady.value) return null
    voiceError.value = ''
    let first = true
    const stream = localVoice.beginStream(voiceBackend.value, {
        start: () => {
            if (first && requestedAt !== undefined) firstAudioLatency.value = `首声 ${((performance.now() - requestedAt) / 1000).toFixed(2)} 秒`
            first = false; setInteraction('speaking')
        },
        pause: () => { if (!disposed) setInteraction(isResponding.value ? 'thinking' : 'idle') },
        end: () => { activeSpeechId.value = null; if (!disposed) setInteraction(isResponding.value ? 'thinking' : 'idle') },
        error: () => { session.voiceEnabled = false; voiceError.value = '昔涟声音暂不可用，朗读已关闭；文字回复已保留。'; persistSession() },
        level: (value: number | null) => avatarRef.value?.getVrmController?.()?.setSpeechLevel(value),
    })
    if (stream) activeSpeechId.value = entry.id
    return stream
}
const toggleVoice = async () => {
    if (session.voiceEnabled && voiceReady.value) {
        try { await localVoice.unlock() }
        catch { session.voiceEnabled = false; voiceError.value = '浏览器未允许音频播放，朗读未开启。' }
    } else {
        session.voiceEnabled = false
        localVoice.stop(); activeSpeechId.value = null
    }
    persistSession()
}
const previewVoice = () => {
    if (isResponding.value || !voiceReady.value) return
    if (activeSpeechId.value) interrupt()
    const entry = [...session.messages].reverse().find(message => message.role === 'assistant' && message.status === 'complete')
    if (entry) {
        const stream = startVoiceStream(entry)
        stream?.push(entry.content); stream?.end()
    }
}
const exportConversation = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(session, null, 2)], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url; link.download = 'cyrene-conversation.json'; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
}
const defaultGreeting = '你来啦，伙伴～'
const isLoadingGreeting = ref(true)
const suggestions = ref<string[]>([])
const customInput = ref('')
const isGeneratingSuggestions = ref(false)

const scrollMessagesToBottom = () => {
    nextTick(() => {
        const container = chatMessagesRef.value
        if (container) {
            container.scrollTop = container.scrollHeight
        }
    })
}

/**
 * Generate a personalized greeting based on important memories
 */
const generatePersonalizedGreeting = async (): Promise<string> => {
    try {
        const greetingMemories = await getGreetingMemories()

        if (greetingMemories.length === 0) {
            return defaultGreeting
        }

        const stored = loadStoredOpenRouterConfig() ?? getDefaultConfig()
        if (!stored?.apiKey) {
            return defaultGreeting
        }

        const client = new OpenRouterClient({
            apiKey: stored.apiKey,
            model: stored.model ?? getDefaultConfig().model,
        })

        const memoriesContext = formatMemoriesForPrompt(greetingMemories)

        const response = await client.sendChat([
            {
                role: 'system',
                content: buildCyrenePrompt('greeting') + memoriesContext,
            },
            {
                role: 'user',
                content: '生成一句问候语来迎接伙伴回来。',
            },
        ], {
            model: stored.model ?? getDefaultConfig().model,
        })

        const greeting = response?.choices?.[0]?.message?.content?.trim()

        if (greeting && greeting.length > 0 && greeting.length < 100) {
            return greeting
        }

        return defaultGreeting
    } catch (error) {
        console.warn('Failed to generate personalized greeting:', error)
        return defaultGreeting
    }
}

// Apply an assistant message's emotion to the avatar. Prefers the explicit
// <emote/> tag; falls back to keyword sentiment when the model omits it.
const dispatchEmotion = (raw: string) => {
    const { stripped, emotions } = parseEmoteTag(raw)
    const final = emotions ?? keywordFallback(stripped)
    if (!final) return
    session.mood = advanceMood(session.mood, final, Date.now() - session.moodUpdatedAt)
    session.moodUpdatedAt = Date.now()
    persistSession()
    const controller = avatarRef.value?.getVrmController?.()
    controller?.setMood(session.mood)
    controller?.applyEmotion(final)
}

const ensureAgent = (): Agent => {
    const stored = loadStoredOpenRouterConfig() ?? getDefaultConfig()
    if (!stored?.apiKey) {
        chatError.value = '请先在设置里配置 OpenRouter API Key。'
        openSettings()
        throw new Error('Missing OpenRouter API key.')
    }
    suggestions.value = []
    if (!agentInstance) {
        agentInstance = new Agent({
            systemPrompt: buildCyrenePrompt(),
            initialHistory: recentConversation(session.messages),
            tools: [conversationRecallTool(() => session.messages)],
            model: stored.model ?? getDefaultConfig().model,
            maxContextMessages: 20, // Limit context to 20 conversation turns
            enableMemoryTools: true, // Enable memory tools
            autoInjectMemories: true, // Auto-inject relevant memories
            maxInjectedMemories: 5, // Max 5 memories per request
        })

    }
    return agentInstance
}

const openSettings = () => {
    settingsSaved.value = false
    isSettingsOpen.value = true
}

const closeSettings = () => {
    isSettingsOpen.value = false
}

const handleSettingsSubmit = () => {
    if (!settingsForm.apiKey.trim()) {
        return
    }
    interrupt()
    saveStoredOpenRouterConfig({
        apiKey: settingsForm.apiKey.trim(),
        model: settingsForm.model.trim() || undefined,
    })
    settingsSaved.value = true
    agentInstance = null
    chatError.value = ''
    setTimeout(() => {
        settingsSaved.value = false
    }, 2000)
}

// Avatar ref
const avatarRef = ref<InstanceType<typeof Avatar> | null>(null)

// 处理 Avatar 加载进度
const handleAvatarProgress = (progress: number) => {
    emit('loading', progress)
}

const handleAvatarReady = () => {
    const controller = avatarRef.value?.getVrmController?.()
    controller?.setMood(session.mood)
    controller?.setInteractionState(interactionState.value)
    emit('ready')
}

// Memory management
const updateMemoryCount = async () => {
    try {
        memoryCount.value = await memoryStore.getCount()
    } catch (error) {
        console.warn('Failed to get memory count:', error)
    }
}

type MemoryView = StoredMemory & { strength: number }

const allMemories = ref<MemoryView[]>([])
const memorySearchQuery = ref('')
const memorySort = ref<'strongest' | 'recent' | 'important'>('strongest')
const memoryGroupBy = ref<'category' | 'none'>('category')
const editingMemoryId = ref<string | null>(null)
const editingMemoryContent = ref('')
const editingMemoryImportance = ref(5)
const editingMemoryConfidence = ref(5)
const fileInputRef = ref<HTMLInputElement | null>(null)

const loadAllMemories = async () => {
    try {
        const memories = await memoryStore.exportAll()
        const valid = memories.filter(m => m.isValid === 1)
        allMemories.value = valid.map(m => ({ ...m, strength: effectiveStrength(m) }))
    } catch (error) {
        console.warn('Failed to load memories:', error)
    }
}

const filteredMemories = computed(() => {
    const q = memorySearchQuery.value.trim().toLowerCase()
    let list = allMemories.value
    if (q) {
        list = list.filter(m => m.content.toLowerCase().includes(q))
    }
    const sorted = [...list]
    if (memorySort.value === 'recent') {
        sorted.sort((a, b) => b.createdAt - a.createdAt)
    } else if (memorySort.value === 'important') {
        sorted.sort((a, b) => b.importance - a.importance)
    } else {
        sorted.sort((a, b) => b.strength - a.strength)
    }
    return sorted
})

const groupedMemories = computed(() => {
    if (memoryGroupBy.value === 'none') return null
    const groups: Record<MemoryCategory, MemoryView[]> = {
        fact: [], preference: [], event: [], correction: [], context: [],
    }
    for (const m of filteredMemories.value) {
        groups[m.category].push(m)
    }
    return groups
})

const categoryLabel = (cat: MemoryCategory) => ({
    fact: '事实', preference: '偏好', event: '事件', correction: '纠正', context: '背景',
}[cat])

const subjectLabel = (subj: string) => ({
    user: '伙伴', character: '昔涟', world: '世界', relationship: '关系', other: '其他',
} as Record<string, string>)[subj] ?? subj

const formatRelativeTime = (ts: number): string => {
    const diff = Date.now() - ts
    const mins = Math.floor(diff / 60000)
    if (mins < 1) return '刚刚'
    if (mins < 60) return `${mins} 分钟前`
    const hours = Math.floor(mins / 60)
    if (hours < 24) return `${hours} 小时前`
    const days = Math.floor(hours / 24)
    if (days < 30) return `${days} 天前`
    const months = Math.floor(days / 30)
    return `${months} 个月前`
}

const openMemoryPanel = async () => {
    await Promise.all([loadAllMemories(), updateMemoryCount()])
    isMemoryPanelOpen.value = true
}

const closeMemoryPanel = () => {
    isMemoryPanelOpen.value = false
    editingMemoryId.value = null
}

const deleteMemory = async (id: string) => {
    try {
        await memoryStore.invalidate(id)
        await loadAllMemories()
        await updateMemoryCount()
    } catch (error) {
        console.warn('Failed to delete memory:', error)
    }
}

const startEditMemory = (m: MemoryView) => {
    editingMemoryId.value = m.id
    editingMemoryContent.value = m.content
    editingMemoryImportance.value = m.importance
    editingMemoryConfidence.value = m.confidence
}

const cancelEditMemory = () => {
    editingMemoryId.value = null
}

const saveEditMemory = async () => {
    if (!editingMemoryId.value) return
    try {
        await memoryStore.update(editingMemoryId.value, {
            content: editingMemoryContent.value.trim(),
            importance: editingMemoryImportance.value,
            confidence: editingMemoryConfidence.value,
        })
        editingMemoryId.value = null
        await loadAllMemories()
        await updateMemoryCount()
    } catch (error) {
        console.warn('Failed to update memory:', error)
    }
}

const exportMemories = async () => {
    try {
        const memories = await memoryStore.exportAll()
        const blob = new Blob([JSON.stringify(memories, null, 2)], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        const date = new Date().toISOString().slice(0, 10)
        a.download = `cyrene-memories-${date}.json`
        a.click()
        URL.revokeObjectURL(url)
    } catch (error) {
        console.warn('Export failed:', error)
    }
}

const triggerImport = () => {
    fileInputRef.value?.click()
}

const handleImportFile = async (e: Event) => {
    const input = e.target as HTMLInputElement
    const file = input.files?.[0]
    if (!file) return
    try {
        const text = await file.text()
        const parsed = JSON.parse(text)
        if (!Array.isArray(parsed)) {
            alert('导入失败：文件格式不正确')
            return
        }
        const count = await memoryStore.importMany(parsed)
        await loadAllMemories()
        await updateMemoryCount()
        alert(`已导入 ${count} 条记忆`)
    } catch (error) {
        console.warn('Import failed:', error)
        alert('导入失败：' + (error instanceof Error ? error.message : '未知错误'))
    } finally {
        input.value = ''
    }
}

const clearAllMemories = async () => {
    if (confirm('确定要清除所有记忆吗？此操作不可恢复。')) {
        try {
            await memoryStore.clearAll()
            await loadAllMemories()
            await updateMemoryCount()
        } catch (error) {
            console.warn('Failed to clear memories:', error)
        }
    }
}

const handleEmbeddingsSave = () => {
    saveEmbeddingsConfig({ ...embeddingsForm })
    settingsSaved.value = true
    setTimeout(() => { settingsSaved.value = false }, 2000)
}

const updateSuggestions = async () => {
    const generation = ++suggestionGeneration
    isGeneratingSuggestions.value = true
    try {
        const stored = loadStoredOpenRouterConfig() ?? getDefaultConfig()
        if (!stored?.apiKey) {
            suggestions.value = []
            return
        }

        const agent = ensureAgent()

        const historyForSuggestion = messages.value.map(msg => ({
            role: msg.sender === 'self' ? 'user' as const : 'assistant' as const,
            content: msg.text,
        }))

        const nextSuggestions = await generateChatSuggestions(historyForSuggestion, {
            client: agent.getClient(),
            model: stored.model ?? getDefaultConfig().model,
        })

        if (generation === suggestionGeneration && !disposed) suggestions.value = nextSuggestions
    } catch {
        if (generation === suggestionGeneration) suggestions.value = []
    } finally {
        if (generation === suggestionGeneration) isGeneratingSuggestions.value = false
    }
}

const sendMessage = async (text: string) => {
    const trimmed = text.trim()
    if (!trimmed || isLoadingGreeting.value) return
    if (isResponding.value || activeSpeechId.value) interrupt()
    let agent: Agent
    try { agent = ensureAgent() } catch { return }
    const generation = ++runGeneration
    suggestionGeneration++
    suggestions.value = []
    const requestedAt = performance.now()
    firstAudioLatency.value = ''
    const abort = new AbortController()
    requestController = abort
    const entry = appendEntry('user', trimmed, 'pending')
    activeEntry = entry
    customInput.value = ''
    chatError.value = ''
    isResponding.value = true
    setInteraction('thinking')
    scrollMessagesToBottom()
    let answer: ConversationEntry | null = null
    let voiceStream: PhraseStream | null = null
    let voiceAttempted = false
    let emotionApplied = false
    let lastSave = 0
    try {
        const result = await agent.run(trimmed, {
            stream: true,
            onDelta: delta => {
                if (generation !== runGeneration || disposed) return
                if (!answer) { answer = appendEntry('assistant', '', 'pending'); activeAnswer = answer }
                answer.content += delta
                if (!emotionApplied && EMOTE_TAG_RE.test(answer.content)) { dispatchEmotion(answer.content); emotionApplied = true }
                if (!voiceAttempted) {
                    voiceAttempted = true
                    if (session.voiceEnabled && voiceReady.value) voiceStream = startVoiceStream(answer, requestedAt)
                }
                voiceStream?.push(delta)
                if (performance.now() - lastSave > 250) { persistSession(); lastSave = performance.now() }
                scrollMessagesToBottom()
            },
            signal: abort.signal,
            interactionContext: `当前时间：${new Date().toISOString()}。上一轮心境强度：${JSON.stringify(session.mood)}。正在回应伙伴输入；没有接入麦克风或摄像头。`,
        })
        if (generation !== runGeneration || disposed) return
        entry.status = 'complete'
        if (!answer) answer = appendEntry('assistant', result.content)
        else { (answer as ConversationEntry).content = result.content; (answer as ConversationEntry).status = 'complete' }
        if (!emotionApplied) dispatchEmotion(result.content)
        ;(voiceStream as PhraseStream | null)?.end()
        activeAnswer = null
        if (!activeSpeechId.value) setInteraction('idle')
        scrollMessagesToBottom()
        void updateMemoryCount()
    } catch (error) {
        if (generation !== runGeneration || disposed) return
        entry.status = abort.signal.aborted ? 'interrupted' : 'failed'
        if (answer) (answer as ConversationEntry).status = entry.status
        activeAnswer = null
        localVoice.stop(); activeSpeechId.value = null
        agentInstance = null
        chatError.value = error instanceof Error ? error.message : '暂时没能收到回复，请重试。'
        setInteraction('idle')
    } finally {
        if (generation === runGeneration && !disposed) {
            isResponding.value = false
            requestController = null
            activeEntry = null
            persistSession()
            void updateSuggestions()
        }
    }
}

const handleSuggestionClick = (text: string) => {
    sendMessage(text)
}

const submitCustomInput = () => {
    const text = customInput.value.trim()
    if (!text) return
    sendMessage(text)
}

onMounted(async () => {
    window.addEventListener('pagehide', interrupt)
    const stored = loadStoredOpenRouterConfig()
    const defaultConfig = getDefaultConfig()
    if (stored) {
        settingsForm.apiKey = stored.apiKey ?? defaultConfig.apiKey
        settingsForm.model = stored.model ?? defaultConfig.model
    } else {
        // First launch: leave credentials empty and prompt for configuration.
        settingsForm.apiKey = defaultConfig.apiKey
        settingsForm.model = defaultConfig.model
    }

    Object.assign(embeddingsForm, loadEmbeddingsConfig())

    try {
        Object.assign(session, loadConversation())
        const restoreVoice = session.voiceEnabled
        session.voiceEnabled = false
        if (restoreVoice) void prepareVoice(true)
        session.mood = restingMood(session.mood, Date.now() - session.moodUpdatedAt)
        session.moodUpdatedAt = Date.now()
        avatarRef.value?.getVrmController?.()?.setMood(session.mood)
    } catch (error) {
        storageWritable = false
        storageError.value = error instanceof Error ? error.message : '无法读取对话存档；本次记录请手动导出。'
    }
    isLoadingGreeting.value = true
    try {
        if (!session.messages.length) {
            const greeting = await generatePersonalizedGreeting()
            if (disposed) return
            appendEntry('assistant', greeting)
            dispatchEmotion(greeting)
        }
        if (!disposed) ensureAgent()
    } catch (error) {
        console.warn('Conversation initialization:', error)
    } finally {
        isLoadingGreeting.value = false
    }
    scrollMessagesToBottom()

    void updateSuggestions()
    void updateMemoryCount()
})

onUnmounted(() => {
    disposed = true
    voiceLoadGeneration++
    localVoice.dispose()
    window.removeEventListener('pagehide', interrupt)
    interrupt()
})

// 暴露 Avatar 引用
defineExpose({
    getAvatar: () => avatarRef.value,
})
</script>

<template>
    <div class="core-root">
        <!-- Avatar 背景 -->
        <div class="fixed inset-0 z-0">
            <Avatar
                ref="avatarRef"
                :show-fps="false"
                :show-loading-progress="true"
                @loading="handleAvatarProgress"
                @ready="handleAvatarReady"
            />
        </div>

        <!-- 顶部功能区 -->
        <div class="fixed top-6 right-6 z-20 flex gap-4">
            <button
                class="relative flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white backdrop-blur-md transition hover:bg-white/20 active:scale-95"
                type="button"
                aria-label="记忆管理"
                @click="openMemoryPanel"
            >
                <IconBrain class="h-5 w-5" />
                <span v-if="memoryCount > 0" class="absolute -top-1 -right-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-pink-500 px-1 text-[10px] font-bold text-white">
                    {{ memoryCount > 99 ? '99+' : memoryCount }}
                </span>
            </button>
            <button
                class="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white backdrop-blur-md transition hover:bg-white/20 active:scale-95"
                type="button"
                aria-label="打开设置"
                @click="openSettings"
            >
                <IconCog class="h-5 w-5" />
            </button>
        </div>

        <!-- iOS Glass 风格对话框 -->
        <div class="fixed bottom-0 left-0 right-0 z-30 flex flex-col items-center pb-8 px-4 pointer-events-none">
            
            <!-- 历史记录浮层 -->
            <Transition name="fade-scale">
                <div v-if="isChatOpen" class="pointer-events-auto absolute bottom-full mb-6 w-full max-w-3xl rounded-[32px] border border-white/10 bg-black/60 p-6 backdrop-blur-3xl shadow-2xl max-h-[60vh] overflow-y-auto">
                    <div class="flex justify-between items-center mb-6 px-2">
                        <h3 class="text-lg font-semibold text-white">共同经历</h3>
                        <button class="text-xs text-white/60" @click="exportConversation">导出记录</button>
                        <button @click="isChatOpen = false" class="flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-white/60 transition hover:bg-white/20 hover:text-white">
                            <span class="text-lg leading-none">×</span>
                        </button>
                    </div>
                    <div class="space-y-6 px-2">
                        <div v-for="msg in messages" :key="msg.id" class="flex flex-col gap-2">
                            <span class="text-xs font-medium text-white/40 uppercase tracking-wide">
                                {{ msg.sender === 'self' ? 'You' : 'Cyrene' }}
                            </span>
                            <p class="text-[15px] leading-relaxed text-white/90 font-light">{{ msg.text }}</p>
                            <span v-if="msg.status !== 'complete' || msg.speechInterrupted" class="text-xs text-white/50">{{ msg.speechInterrupted ? '朗读已打断 · 文字已保留' : msg.status === 'pending' ? (msg.sender === 'ally' ? '正在生成' : '等待回复') : msg.status === 'failed' ? '未收到回复' : '已中断' }}</span>
                        </div>
                    </div>
                </div>
            </Transition>

            <!-- 主对话框容器 -->
            <div class="pointer-events-auto w-full max-w-4xl relative flex flex-col gap-4">
                <!-- 对话内容卡片 -->
                <div class="relative overflow-hidden rounded-[32px] border border-white/10 bg-black/40 p-8 shadow-2xl backdrop-blur-2xl transition-all duration-500">
                    <!-- 名字 -->
                    <div class="mb-3 flex items-center gap-3">
                        <div class="h-2 w-2 rounded-full bg-pink-400 shadow-[0_0_8px_rgba(244,114,182,0.6)]"></div>
                        <span class="text-sm font-semibold text-white/60 tracking-wide">昔涟</span>
                        <span class="text-xs text-white/50" aria-live="polite">{{ stateLabels[interactionState] }}</span>
                    </div>

                    <!-- 文本内容 -->
                    <div class="min-h-[60px] pr-12">
                        <p class="text-lg leading-relaxed text-white font-light tracking-wide">
                            <span v-if="isResponding || isLoadingGreeting" class="animate-pulse text-white/50">{{ isLoadingGreeting ? '回想中...' : 'Thinking...' }}</span>
                            <span v-else>{{ [...messages].reverse().find(m => m.sender === 'ally')?.text ?? '...' }}</span>
                        </p>
                    </div>

                    <!-- Log 按钮 -->
                    <button 
                        @click="isChatOpen = !isChatOpen"
                        class="absolute top-8 right-8 flex h-8 w-8 items-center justify-center rounded-full bg-white/5 text-white/40 transition hover:bg-white/10 hover:text-white active:scale-95"
                    >
                        <IconChatProcessingOutline class="h-4 w-4" />
                    </button>
                </div>

            </div>
        </div>

        <!-- 右侧浮动建议与输入 -->
        <div class="pointer-events-none fixed right-6 bottom-8 z-40 flex max-w-[320px] flex-col items-end gap-3">
            <button
                v-for="suggestion in suggestions"
                :key="suggestion"
                type="button"
                class="pointer-events-auto w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-left text-sm text-white/80 backdrop-blur-2xl shadow-xl transition hover:border-white/30 hover:bg-white/10 hover:text-white"
                @click="handleSuggestionClick(suggestion)"
                :disabled="isResponding || isLoadingGreeting"
            >
                {{ suggestion }}
            </button>
            <p v-if="!suggestions.length" class="pointer-events-none w-full text-right text-sm text-white/50">{{ isGeneratingSuggestions ? '生成中...' : '暂无建议' }}</p>

            <button v-if="isResponding || activeSpeechId" class="pointer-events-auto rounded-full bg-white/15 px-4 py-2 text-sm text-white" @click="interrupt">打断</button>
            <p v-if="storageError" role="alert" class="text-sm text-amber-200">{{ storageError }}</p>
            <p v-if="voiceError" role="status" class="text-sm text-white/60">{{ voiceError }}</p>
            <div class="pointer-events-auto w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 backdrop-blur-2xl shadow-xl">
                <div class="flex items-center gap-2">
                    <input
                        v-model="customInput"
                        type="text"
                        class="flex-1 bg-transparent text-sm text-white placeholder:text-white/30 focus:outline-none"
                        placeholder="输入你想说的话..."
                        @keydown.enter.prevent="submitCustomInput"
                        @focus="onInputFocus"
                        @input="onInputFocus"
                        @blur="onInputBlur"
                        :disabled="isLoadingGreeting"
                    />
                    <button
                        type="button"
                        class="rounded-xl bg-white px-4 py-2 text-sm font-semibold text-black shadow-md transition hover:scale-[1.02] active:scale-95 disabled:opacity-50 disabled:hover:scale-100"
                        @click="submitCustomInput"
                        :disabled="isLoadingGreeting || !customInput.trim()"
                    >
                        {{ isResponding ? '打断并发送' : '发送' }}
                    </button>
                </div>
            </div>
        </div>

        <!-- 设置弹窗 -->
        <Transition name="fade-scale">
            <div v-if="isSettingsOpen" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
                <div class="relative w-[420px] max-w-[90vw] overflow-hidden rounded-[32px] border border-white/10 bg-[#1c1c1e]/90 p-8 shadow-2xl backdrop-blur-xl">
                    <header class="mb-8 flex items-center justify-between">
                        <h2 class="text-xl font-semibold text-white">设置</h2>
                        <button @click="closeSettings" class="flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-white/60 transition hover:bg-white/20 hover:text-white">
                            <span class="text-lg leading-none">×</span>
                        </button>
                    </header>

                    <div class="max-h-[70vh] overflow-y-auto pr-1 space-y-6">
                        <div class="space-y-2">
                            <label class="flex items-center gap-2 text-sm text-white/80"><input v-model="session.voiceEnabled" :disabled="!voiceReady" type="checkbox" @change="toggleVoice" />朗读昔涟的回复</label>
                            <p class="text-xs text-white/50">只使用本地昔涟模型。首次加载约 759 MiB；文字增量到达后按短语合成，支持打断。</p>
                            <button :disabled="!voiceReady || isResponding" type="button" class="text-xs text-pink-200 underline disabled:opacity-40" @click="previewVoice">试听昔涟声音</button>
                            <label class="block text-sm text-white/80">声音来源
                                <select v-model="voiceBackend" class="ml-2 rounded bg-slate-900 p-1" @change="changeVoiceBackend">
                                    <option value="webgpu">昔涟 · 本地 WebGPU</option>
                                    <option value="wasm">昔涟 · 本地 WASM（较慢）</option>
                                </select>
                            </label>
                            <button :disabled="voiceLoading" type="button" class="text-xs text-pink-200 underline disabled:opacity-40" @click="prepareVoice()">{{ voiceLoading ? '正在加载并预热…' : '加载角色声音' }}</button>
                            <p v-if="voiceStatus" role="status" class="text-xs text-white/60">{{ voiceStatus }}</p>
                            <p v-if="firstAudioLatency" class="text-xs text-white/50">{{ firstAudioLatency }}</p>
                            <p v-if="voiceMetrics" class="text-xs text-white/50">{{ voiceMetrics }}</p>
                        </div>
                        <form class="space-y-4" @submit.prevent="handleSettingsSubmit">
                            <div class="space-y-2">
                                <label class="ml-1 text-xs font-medium text-white/60 tracking-wider">API 密钥</label>
                                <input
                                    v-model="settingsForm.apiKey"
                                    type="password"
                                    required
                                    class="w-full rounded-2xl border border-white/5 bg-black/20 px-4 py-3.5 text-[15px] text-white transition focus:bg-black/40 focus:outline-none focus:ring-1 focus:ring-white/20"
                                    placeholder="sk-..."
                                />
                            </div>

                            <div class="space-y-2">
                                <label class="ml-1 text-xs font-medium text-white/60 tracking-wider">模型</label>
                                <input
                                    v-model="settingsForm.model"
                                    type="text"
                                    class="w-full rounded-2xl border border-white/5 bg-black/20 px-4 py-3.5 text-[15px] text-white transition focus:bg-black/40 focus:outline-none focus:ring-1 focus:ring-white/20"
                                    placeholder="如：google/gemini-2.5-flash"
                                />
                            </div>

                            <div class="flex items-center justify-between pt-2">
                                <span v-if="settingsSaved" class="text-sm text-green-400 font-medium">已保存</span>
                                <span v-else></span>
                                <button
                                    type="submit"
                                    class="rounded-full bg-white px-8 py-3 text-sm font-semibold text-black shadow-lg transition hover:scale-105 active:scale-95 disabled:opacity-50 disabled:hover:scale-100"
                                    :disabled="!settingsForm.apiKey.trim()"
                                >
                                    保存
                                </button>
                            </div>
                        </form>

                        <div class="border-t border-white/5 pt-6 space-y-4">
                            <div class="flex items-center justify-between">
                                <h3 class="text-sm font-semibold text-white/80">语义检索（可选）</h3>
                                <label class="flex items-center gap-2 cursor-pointer">
                                    <input
                                        v-model="embeddingsForm.enabled"
                                        type="checkbox"
                                        class="h-4 w-4 rounded accent-pink-400"
                                    />
                                    <span class="text-xs text-white/60">启用</span>
                                </label>
                            </div>
                            <p class="text-xs text-white/40 -mt-2">配置 OpenAI 兼容的 embeddings 端点以启用向量搜索。未启用时使用关键词检索。</p>

                            <div class="space-y-2">
                                <label class="ml-1 text-xs font-medium text-white/60 tracking-wider">Base URL</label>
                                <input
                                    v-model="embeddingsForm.baseUrl"
                                    type="text"
                                    class="w-full rounded-2xl border border-white/5 bg-black/20 px-4 py-3 text-[14px] text-white focus:bg-black/40 focus:outline-none focus:ring-1 focus:ring-white/20"
                                    placeholder="https://api.openai.com/v1"
                                />
                            </div>

                            <div class="space-y-2">
                                <label class="ml-1 text-xs font-medium text-white/60 tracking-wider">API Key</label>
                                <input
                                    v-model="embeddingsForm.apiKey"
                                    type="password"
                                    class="w-full rounded-2xl border border-white/5 bg-black/20 px-4 py-3 text-[14px] text-white focus:bg-black/40 focus:outline-none focus:ring-1 focus:ring-white/20"
                                    placeholder="sk-..."
                                />
                            </div>

                            <div class="grid grid-cols-2 gap-3">
                                <div class="space-y-2">
                                    <label class="ml-1 text-xs font-medium text-white/60 tracking-wider">模型</label>
                                    <input
                                        v-model="embeddingsForm.model"
                                        type="text"
                                        class="w-full rounded-2xl border border-white/5 bg-black/20 px-3 py-3 text-[14px] text-white focus:bg-black/40 focus:outline-none focus:ring-1 focus:ring-white/20"
                                        placeholder="text-embedding-3-small"
                                    />
                                </div>
                                <div class="space-y-2">
                                    <label class="ml-1 text-xs font-medium text-white/60 tracking-wider">维度</label>
                                    <input
                                        v-model.number="embeddingsForm.dimensions"
                                        type="number"
                                        class="w-full rounded-2xl border border-white/5 bg-black/20 px-3 py-3 text-[14px] text-white focus:bg-black/40 focus:outline-none focus:ring-1 focus:ring-white/20"
                                        placeholder="512"
                                    />
                                </div>
                            </div>

                            <div class="flex justify-end">
                                <button
                                    type="button"
                                    @click="handleEmbeddingsSave"
                                    class="rounded-full bg-white/10 hover:bg-white/20 px-6 py-2 text-sm font-medium text-white transition"
                                >
                                    保存语义配置
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </Transition>

        <!-- 记忆管理弹窗 -->
        <Transition name="fade-scale">
            <div v-if="isMemoryPanelOpen" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
                <div class="relative w-[640px] max-w-[92vw] max-h-[85vh] overflow-hidden rounded-[32px] border border-white/10 bg-[#1c1c1e]/90 shadow-2xl backdrop-blur-xl flex flex-col">
                    <header class="px-8 pt-7 pb-4 flex items-center justify-between shrink-0">
                        <div>
                            <h2 class="text-xl font-semibold text-white">长期记忆</h2>
                            <p class="text-sm text-white/50 mt-1">共 {{ memoryCount }} 条记忆 · 显示 {{ filteredMemories.length }} 条</p>
                        </div>
                        <button @click="closeMemoryPanel" class="flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-white/60 transition hover:bg-white/20 hover:text-white">
                            <span class="text-lg leading-none">×</span>
                        </button>
                    </header>

                    <!-- 搜索/排序工具栏 -->
                    <div class="px-8 pb-3 flex items-center gap-2 shrink-0">
                        <input
                            v-model="memorySearchQuery"
                            type="text"
                            placeholder="搜索记忆..."
                            class="flex-1 rounded-2xl border border-white/5 bg-black/20 px-4 py-2.5 text-[14px] text-white placeholder:text-white/30 focus:bg-black/40 focus:outline-none focus:ring-1 focus:ring-white/20"
                        />
                        <select
                            v-model="memorySort"
                            class="rounded-2xl border border-white/5 bg-black/20 px-3 py-2.5 text-[13px] text-white focus:outline-none"
                        >
                            <option value="strongest">按强度</option>
                            <option value="recent">按时间</option>
                            <option value="important">按重要性</option>
                        </select>
                        <button
                            @click="memoryGroupBy = memoryGroupBy === 'category' ? 'none' : 'category'"
                            class="rounded-2xl border border-white/5 bg-black/20 px-3 py-2.5 text-[13px] text-white/70 hover:bg-white/10 transition"
                            :title="memoryGroupBy === 'category' ? '取消分组' : '按类别分组'"
                        >
                            {{ memoryGroupBy === 'category' ? '已分组' : '未分组' }}
                        </button>
                    </div>

                    <div class="flex-1 overflow-y-auto px-8 pb-4">
                        <div v-if="filteredMemories.length === 0" class="py-12 text-center text-white/40">
                            <IconBrain class="mx-auto h-12 w-12 mb-4 opacity-50" />
                            <p v-if="allMemories.length === 0">暂无记忆</p>
                            <p v-else>没有匹配的记忆</p>
                            <p class="text-sm mt-2" v-if="allMemories.length === 0">与昔涟对话时，重要信息会被自动记住</p>
                        </div>

                        <!-- 分组视图 -->
                        <template v-else-if="groupedMemories">
                            <div v-for="cat in (['fact','preference','event','correction','context'] as const)" :key="cat">
                                <div v-if="groupedMemories[cat].length > 0" class="mb-4">
                                    <h3 class="text-xs font-semibold text-white/40 uppercase tracking-wider mb-2 px-1">
                                        {{ categoryLabel(cat) }} ({{ groupedMemories[cat].length }})
                                    </h3>
                                    <div class="space-y-2">
                                        <div
                                            v-for="memory in groupedMemories[cat]"
                                            :key="memory.id"
                                            class="group relative rounded-2xl border border-white/5 bg-white/5 p-4 transition hover:bg-white/10"
                                        >
                                            <!-- 编辑模式 -->
                                            <div v-if="editingMemoryId === memory.id" class="space-y-3">
                                                <textarea
                                                    v-model="editingMemoryContent"
                                                    rows="3"
                                                    class="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-white/20 resize-none"
                                                />
                                                <div class="flex items-center gap-4 text-xs text-white/60">
                                                    <label class="flex items-center gap-2 flex-1">
                                                        <span class="shrink-0">重要性</span>
                                                        <input v-model.number="editingMemoryImportance" type="range" min="1" max="10" class="flex-1 accent-pink-400" />
                                                        <span class="w-6 text-center">{{ editingMemoryImportance }}</span>
                                                    </label>
                                                    <label class="flex items-center gap-2 flex-1">
                                                        <span class="shrink-0">可信度</span>
                                                        <input v-model.number="editingMemoryConfidence" type="range" min="1" max="10" class="flex-1 accent-blue-400" />
                                                        <span class="w-6 text-center">{{ editingMemoryConfidence }}</span>
                                                    </label>
                                                </div>
                                                <div class="flex justify-end gap-2">
                                                    <button @click="cancelEditMemory" class="px-3 py-1.5 text-xs text-white/60 hover:text-white">取消</button>
                                                    <button @click="saveEditMemory" class="px-4 py-1.5 text-xs font-medium bg-white/15 hover:bg-white/25 text-white rounded-full">保存</button>
                                                </div>
                                            </div>

                                            <!-- 浏览模式 -->
                                            <div v-else class="flex items-start gap-3">
                                                <span class="shrink-0 rounded-lg bg-pink-500/15 px-2 py-1 text-[10px] font-medium text-pink-300">
                                                    {{ subjectLabel(memory.subject) }}
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
                                                <div class="shrink-0 flex gap-1 opacity-0 group-hover:opacity-100 transition">
                                                    <button
                                                        @click="startEditMemory(memory)"
                                                        class="flex h-6 w-6 items-center justify-center rounded-full bg-white/10 text-white/60 hover:bg-white/20 hover:text-white text-xs"
                                                        title="编辑"
                                                    >
                                                        ✎
                                                    </button>
                                                    <button
                                                        @click="deleteMemory(memory.id)"
                                                        class="flex h-6 w-6 items-center justify-center rounded-full bg-red-500/20 text-red-300 hover:bg-red-500/40 text-xs"
                                                        title="删除"
                                                    >
                                                        ×
                                                    </button>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </template>

                        <!-- 平铺视图 -->
                        <div v-else class="space-y-2">
                            <div
                                v-for="memory in filteredMemories"
                                :key="memory.id"
                                class="group relative rounded-2xl border border-white/5 bg-white/5 p-4 transition hover:bg-white/10"
                            >
                                <div v-if="editingMemoryId === memory.id" class="space-y-3">
                                    <textarea
                                        v-model="editingMemoryContent"
                                        rows="3"
                                        class="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-white/20 resize-none"
                                    />
                                    <div class="flex items-center gap-4 text-xs text-white/60">
                                        <label class="flex items-center gap-2 flex-1">
                                            <span class="shrink-0">重要性</span>
                                            <input v-model.number="editingMemoryImportance" type="range" min="1" max="10" class="flex-1 accent-pink-400" />
                                            <span class="w-6 text-center">{{ editingMemoryImportance }}</span>
                                        </label>
                                        <label class="flex items-center gap-2 flex-1">
                                            <span class="shrink-0">可信度</span>
                                            <input v-model.number="editingMemoryConfidence" type="range" min="1" max="10" class="flex-1 accent-blue-400" />
                                            <span class="w-6 text-center">{{ editingMemoryConfidence }}</span>
                                        </label>
                                    </div>
                                    <div class="flex justify-end gap-2">
                                        <button @click="cancelEditMemory" class="px-3 py-1.5 text-xs text-white/60 hover:text-white">取消</button>
                                        <button @click="saveEditMemory" class="px-4 py-1.5 text-xs font-medium bg-white/15 hover:bg-white/25 text-white rounded-full">保存</button>
                                    </div>
                                </div>
                                <div v-else class="flex items-start gap-3">
                                    <span class="shrink-0 rounded-lg bg-pink-500/15 px-2 py-1 text-[10px] font-medium text-pink-300">
                                        {{ categoryLabel(memory.category) }}·{{ subjectLabel(memory.subject) }}
                                    </span>
                                    <div class="flex-1 min-w-0">
                                        <p class="text-sm text-white/90 leading-relaxed">{{ memory.content }}</p>
                                        <div class="mt-2 flex items-center gap-3 text-[10px] text-white/30 flex-wrap">
                                            <span>重要 {{ memory.importance }}</span>
                                            <span>可信 {{ memory.confidence }}</span>
                                            <span>强度 {{ memory.strength.toFixed(1) }}</span>
                                            <span v-if="memory.accessCount > 0">访问 {{ memory.accessCount }}×</span>
                                            <span>{{ formatRelativeTime(memory.lastAccessedAt) }}</span>
                                        </div>
                                    </div>
                                    <div class="shrink-0 flex gap-1 opacity-0 group-hover:opacity-100 transition">
                                        <button @click="startEditMemory(memory)" class="flex h-6 w-6 items-center justify-center rounded-full bg-white/10 text-white/60 hover:bg-white/20 hover:text-white text-xs" title="编辑">✎</button>
                                        <button @click="deleteMemory(memory.id)" class="flex h-6 w-6 items-center justify-center rounded-full bg-red-500/20 text-red-300 hover:bg-red-500/40 text-xs" title="删除">×</button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>

                    <footer class="px-8 py-4 border-t border-white/5 shrink-0 flex items-center justify-between gap-2">
                        <div class="flex gap-2">
                            <button
                                @click="exportMemories"
                                class="rounded-full bg-white/10 hover:bg-white/20 px-4 py-2 text-xs font-medium text-white transition"
                                :disabled="memoryCount === 0"
                            >
                                导出
                            </button>
                            <button
                                @click="triggerImport"
                                class="rounded-full bg-white/10 hover:bg-white/20 px-4 py-2 text-xs font-medium text-white transition"
                            >
                                导入
                            </button>
                            <input ref="fileInputRef" type="file" accept="application/json" class="hidden" @change="handleImportFile" />
                        </div>
                        <button
                            v-if="memoryCount > 0"
                            @click="clearAllMemories"
                            class="rounded-full border border-red-500/30 bg-red-500/10 px-4 py-2 text-xs font-medium text-red-300 transition hover:bg-red-500/20"
                        >
                            清除所有
                        </button>
                    </footer>
                </div>
            </div>
        </Transition>

        <!-- 错误提示 -->
        <Transition name="slide-up">
            <div v-if="chatError" class="fixed bottom-32 left-1/2 z-50 -translate-x-1/2 transform">
                <div class="rounded-full border border-red-500/20 bg-red-500/10 px-6 py-3 text-sm font-medium text-red-200 backdrop-blur-md shadow-lg">
                    {{ chatError }}
                </div>
            </div>
        </Transition>
    </div>
</template>

<style scoped>
.fade-scale-enter-active,
.fade-scale-leave-active {
    transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
}

.fade-scale-enter-from,
.fade-scale-leave-to {
    opacity: 0;
    transform: scale(0.95);
}

.slide-up-enter-active,
.slide-up-leave-active {
    transition: all 0.4s cubic-bezier(0.16, 1, 0.3, 1);
}

.slide-up-enter-from,
.slide-up-leave-to {
    opacity: 0;
    transform: translate(-50%, 40px);
}
</style>
