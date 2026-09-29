<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref } from 'vue'
import CompanionSheet from './CompanionSheet.vue'
import { SpeechInput, type SpeechInputState } from '@/lib/speech-input'
import { buildCyrenePrompt } from '@/lib/persona/cyrene'
import {
    createSession,
    loadConversation,
    saveConversation,
    recentConversation,
    conversationRecallTool,
    type ConversationEntry,
} from '@/lib/conversation-store'
import { LocalVoiceController, type VoiceBackend } from '@/lib/voice/controller'
import type { PhraseStream } from '@/lib/voice/phrase-stream'
import { advanceMood, restingMood, type InteractionState } from '@/lib/interaction'
import {
    addFollowUps,
    dueFollowUps,
    presenceContext,
    returnBrief,
    settleFollowUps,
    shouldGreetOnReturn,
} from '@/lib/companion'
import IconChatProcessingOutline from '~icons/mdi/chat-processing-outline'
import IconCog from '~icons/mdi/cog'
import IconBrain from '~icons/mdi/brain'
import { Agent } from '@/lib/agent'
import { loadStoredOpenRouterConfig, saveStoredOpenRouterConfig } from '@/lib/openrouter-config'
import {
    memoryStore,
    effectiveStrength,
    type StoredMemory,
    type MemoryCategory,
} from '@/lib/memory-store'
import { getGreetingMemories, formatMemoriesForPrompt } from '@/lib/memory-tools'
import { OpenRouterClient } from '@/lib/openrouter'
import {
    loadEmbeddingsConfig,
    saveEmbeddingsConfig,
    DEFAULT_EMBEDDINGS_CONFIG,
    type StoredEmbeddingsConfig,
} from '@/lib/embeddings-config'
import { ACTION_LABELS, type BodyAction, type SceneEvent } from '@/avatar/scene/BodyDirector'
import type { CameraView } from '@/avatar/scene/CameraDirector'
import { parseSceneCue } from '@/avatar/scene/commands'
import { parseGesture } from '@/avatar/utils/CompanionMotion'
import Avatar from '@/avatar/components/Avatar.vue'
import { generateChatSuggestions } from '@/lib/chatSuggestions'
import { EMOTION_NAMES, type EmotionName } from '@/avatar/utils/VrmController'

// Emotion-tag parser. The agent emits a leading `<emote happy=0.7 ... />` tag
// on each reply. We strip it before display and feed the values into the
// VRM expression tween.
const EMOTE_TAG_RE = /^\s*<emote\b([^>]*)\/?>\s*/i
const EMOTE_ATTR_RE = /(\w+)\s*=\s*"?([0-9.]+)"?/g

const parseEmoteTag = (
    text: string
): { stripped: string; emotions: Partial<Record<EmotionName, number>> | null } => {
    const match = text.match(EMOTE_TAG_RE)
    if (!match)
        return {
            stripped:
                /^\s*<(?:e(?:m(?:o(?:t(?:e)?)?)?)?)?$/i.test(text) ||
                /^\s*<emote\b[^>]*$/i.test(text)
                    ? ''
                    : text,
            emotions: null,
        }
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
    {
        name: 'happy',
        words: ['开心', '高兴', '喜欢', '真好', '太棒', '哈哈', '嘻嘻', '♪', '❤', '~'],
    },
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

const props = withDefaults(
    defineProps<{ musicEnabled?: boolean; musicBusy?: boolean; musicError?: string }>(),
    { musicEnabled: false, musicBusy: false, musicError: '' }
)

// 定义 emits
const emit = defineEmits<{
    (e: 'loading', progress: number): void
    (e: 'ready'): void
    (e: 'toggle-music'): void
    (e: 'dismiss-music-error'): void
}>()

const isChatOpen = ref(false)
const dismissNotice = () => {
    chatError.value = ''
    voiceError.value = ''
    emit('dismiss-music-error')
}
const quietMode = ref(false)
const quietReturnRef = ref<HTMLButtonElement | null>(null)
const topicsOpen = ref(false)
const configured = ref(false)
const composerRef = ref<HTMLInputElement | null>(null)
const historyPinned = ref(true)
const latestReply = computed(() =>
    [...messages.value].reverse().find(message => message.sender === 'ally')
)
const openHistory = () => {
    closeSpeechInput()
    isChatOpen.value = true
    topicsOpen.value = false
    historyPinned.value = true
    scrollMessagesToBottom()
}
const trackHistoryScroll = () => {
    const el = chatMessagesRef.value
    if (el) historyPinned.value = el.scrollHeight - el.scrollTop - el.clientHeight < 72
}
const toggleTopics = () => {
    topicsOpen.value = !topicsOpen.value
    if (topicsOpen.value && !suggestions.value.length) void updateSuggestions()
}
const enterQuietMode = () => {
    closeSpeechInput()
    quietMode.value = true
    topicsOpen.value = false
    nextTick(() => quietReturnRef.value?.focus())
}
const leaveQuietMode = () => {
    quietMode.value = false
    nextTick(() => composerRef.value?.focus())
}
const onComposerKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault()
        submitCustomInput()
    }
}
const messageDate = (timestamp: number) =>
    new Date(timestamp).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })
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
const messages = computed(() =>
    session.messages.map(entry => ({
        id: entry.id,
        sender: entry.role === 'user' ? 'self' : 'ally',
        text: entry.role === 'assistant' ? parseEmoteTag(entry.content).stripped : entry.content,
        status: entry.status,
        speechInterrupted: entry.speechInterrupted,
    }))
)
const storageError = ref('')
let storageWritable = true
const interactionState = ref<InteractionState>('idle')
const stateLabels: Record<InteractionState, string> = {
    idle: '在这里',
    listening: '在听你说',
    thinking: '想一想',
    speaking: '正在说话',
    interrupted: '好，你说',
}
const localVoice = new LocalVoiceController()
const voiceBackend = computed<VoiceBackend>({
    get: () => session.voiceBackend ?? 'webgpu',
    set: value => {
        session.voiceBackend = value
    },
})
const voiceReady = ref(false)
const voiceLoading = ref(false)
const voiceStatus = ref('请先加载昔涟声音，加载并预热成功后才能开启朗读。')
const voiceMetrics = ref('')
const firstAudioLatency = ref('')
let voiceLoadGeneration = 0
localVoice.onStatus = text => {
    voiceStatus.value = text
}
localVoice.onReady = ready => {
    voiceReady.value = ready
    if (!ready) session.voiceEnabled = false
}
localVoice.onMetrics = m => {
    voiceMetrics.value = `合成 ${(Number(m.totalMs) / 1000).toFixed(2)} 秒 · 音频 ${Number(m.audioSeconds).toFixed(2)} 秒`
}
const changeVoiceBackend = () => {
    voiceLoadGeneration++
    interrupt()
    localVoice.dispose()
    voiceLoading.value = false
    session.voiceEnabled = false
    persistSession()
    voiceStatus.value = '请加载所选后端的昔涟声音。'
    voiceMetrics.value = ''
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
        session.voiceEnabled = false
        voiceStatus.value = String(e)
        persistSession()
    } finally {
        if (generation === voiceLoadGeneration) voiceLoading.value = false
    }
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
    try {
        saveConversation(session)
        storageError.value = ''
    } catch {
        storageError.value = '对话暂时无法保存，请导出记录备份，避免刷新后丢失。'
    }
}
const appendEntry = (
    role: 'user' | 'assistant',
    content: string,
    status: ConversationEntry['status'] = 'complete'
) => {
    const entry: ConversationEntry = {
        id: crypto.randomUUID(),
        role,
        content,
        status,
        timestamp: Date.now(),
    }
    session.messages.push(entry)
    persistSession()
    return session.messages[session.messages.length - 1]!
}
const setInteraction = (state: InteractionState) => {
    interactionState.value = state
    avatarRef.value?.getVrmController?.()?.setInteractionState(state)
}
const interrupt = () => {
    pendingSceneCue = null
    avatarRef.value?.stopBodyAction()
    speechInput.cancel()
    const wasBusy = isResponding.value || activeSpeechId.value !== null
    avatarRef.value?.getVrmController?.()?.cancelGestures()
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
const onInputBlur = () => {
    if (!speechInputActive.value && interactionState.value === 'listening') setInteraction('idle')
}
const startVoiceStream = (entry: ConversationEntry, requestedAt?: number): PhraseStream | null => {
    if (!voiceReady.value) return null
    voiceError.value = ''
    let first = true
    const stream = localVoice.beginStream(voiceBackend.value, {
        start: () => {
            if (first && requestedAt !== undefined)
                firstAudioLatency.value = `首声 ${((performance.now() - requestedAt) / 1000).toFixed(2)} 秒`
            first = false
            setInteraction('speaking')
            flushSceneCue()
        },
        pause: () => {
            if (!disposed) setInteraction(isResponding.value ? 'thinking' : 'idle')
        },
        end: () => {
            pendingSceneCue = null
            avatarRef.value?.getVrmController?.()?.cancelGestures()
            activeSpeechId.value = null
            if (!disposed) setInteraction(isResponding.value ? 'thinking' : 'idle')
        },
        error: () => {
            pendingSceneCue = null
            avatarRef.value?.getVrmController?.()?.cancelGestures()
            session.voiceEnabled = false
            voiceError.value = '昔涟声音暂不可用，朗读已关闭；文字回复已保留。'
            persistSession()
        },
        level: (value: number | null) =>
            avatarRef.value?.getVrmController?.()?.setSpeechLevel(value),
    })
    if (stream) activeSpeechId.value = entry.id
    return stream
}
const toggleVoice = async () => {
    if (session.voiceEnabled && voiceReady.value) {
        try {
            await localVoice.unlock()
        } catch {
            session.voiceEnabled = false
            voiceError.value = '浏览器未允许音频播放，朗读未开启。'
        }
    } else {
        session.voiceEnabled = false
        localVoice.stop()
        activeSpeechId.value = null
    }
    persistSession()
}
const previewVoice = () => {
    if (isResponding.value || !voiceReady.value) return
    if (activeSpeechId.value) interrupt()
    const entry = [...session.messages]
        .reverse()
        .find(message => message.role === 'assistant' && message.status === 'complete')
    if (entry) {
        const stream = startVoiceStream(entry)
        stream?.push(entry.content)
        stream?.end()
    }
}
const exportConversation = () => {
    const url = URL.createObjectURL(
        new Blob([JSON.stringify(session, null, 2)], { type: 'application/json' })
    )
    const link = document.createElement('a')
    link.href = url
    link.download = 'cyrene-conversation.json'
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
}
const defaultGreeting = '你来啦，伙伴～'
const isLoadingGreeting = ref(true)
const suggestions = ref<string[]>([])
const customInput = ref('')
const speechInput = new SpeechInput()
const speechInputState = ref<SpeechInputState>('idle')
const speechInputActive = computed(() => speechInputState.value !== 'idle')
const speechInputError = ref('')
const speechInputHelp = ref(false)
let speechInputAccepted = false
speechInput.onText = text => {
    customInput.value = text
}
speechInput.onError = message => {
    speechInputError.value = message
}
speechInput.onState = state => {
    speechInputState.value = state
    if (disposed) return
    if (state === 'listening') setInteraction('listening')
    else if (state === 'idle' && interactionState.value === 'listening') setInteraction('idle')
}
const closeSpeechInput = () => {
    speechInput.cancel()
    speechInputHelp.value = false
}
const startSpeechInput = () => {
    speechInputAccepted = true
    speechInputHelp.value = false
    interrupt()
    if (props.musicEnabled || props.musicBusy) emit('toggle-music')
    speechInput.start(customInput.value)
}
const toggleSpeechInput = () => {
    if (speechInputActive.value) {
        if (speechInputState.value === 'stopping') speechInput.cancel()
        else speechInput.stop()
    } else if (!speechInput.supported) {
        speechInput.start(customInput.value)
    } else if (!speechInputAccepted) {
        speechInputHelp.value = !speechInputHelp.value
    } else startSpeechInput()
}
const onComposerInput = () => {
    closeSpeechInput()
    onInputFocus()
}
const onVisibilityChange = () => {
    if (document.hidden) closeSpeechInput()
    else if (!isLoadingGreeting.value) void greetOnReturn()
}
const speechInputStatus = computed(
    () =>
        ({
            idle: '',
            starting: '正在开启麦克风，请允许浏览器使用麦克风…',
            listening: '正在听，文字会出现在输入框。说完再点一次麦克风。',
            stopping: '正在收尾，再点一次即可取消等待。',
        })[speechInputState.value]
)
const isGeneratingSuggestions = ref(false)

const scrollMessagesToBottom = () => {
    nextTick(() => {
        const container = chatMessagesRef.value
        if (container && historyPinned.value) {
            container.scrollTop = container.scrollHeight
        }
    })
}

/**
 * Opening line when the partner comes back after a while. Grounded in the
 * real transcript tail and due follow-ups; returns null when unavailable.
 */
const generateReturnGreeting = async (brief: string): Promise<string | null> => {
    const stored = loadStoredOpenRouterConfig()
    if (!stored?.apiKey) return null
    try {
        const client = new OpenRouterClient({ apiKey: stored.apiKey, model: stored.model ?? getDefaultConfig().model })
        const memories = formatMemoriesForPrompt(await getGreetingMemories().catch(() => []))
        const response = await client.sendChat(
            [
                { role: 'system', content: buildCyrenePrompt('return') + memories + `\n【回访情况】\n${brief}` },
                { role: 'user', content: '伙伴刚刚回来，还没有说话。你先开口。' },
            ],
            { model: stored.model ?? getDefaultConfig().model }
        )
        const text = response?.choices?.[0]?.message?.content?.trim()
        return text && text.length < 160 ? text : null
    } catch (error) {
        console.warn('Failed to generate return greeting:', error)
        return null
    }
}

let returnGreetingInFlight = false
const greetOnReturn = async () => {
    if (returnGreetingInFlight || !configured.value || isResponding.value || activeSpeechId.value) return
    if (!shouldGreetOnReturn(session)) return
    returnGreetingInFlight = true
    const due = dueFollowUps(session.followUps)
    const lastId = session.messages[session.messages.length - 1]?.id
    try {
        const greeting = await generateReturnGreeting(returnBrief(session, due))
        // Drop it if the partner started talking meanwhile.
        if (!greeting || disposed || session.messages[session.messages.length - 1]?.id !== lastId) return
        appendEntry('assistant', greeting).kind = 'greeting'
        session.followUps = settleFollowUps(session.followUps, due)
        persistSession()
        // Rebuild the agent from the transcript so it sees the new opening line.
        agentInstance = null
        dispatchEmotion(greeting)
        scrollMessagesToBottom()
    } finally {
        returnGreetingInFlight = false
    }
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

        const response = await client.sendChat(
            [
                {
                    role: 'system',
                    content: buildCyrenePrompt('greeting') + memoriesContext,
                },
                {
                    role: 'user',
                    content: '生成一句问候语来迎接伙伴回来。',
                },
            ],
            {
                model: stored.model ?? getDefaultConfig().model,
            }
        )

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
    const controller = avatarRef.value?.getVrmController?.()
    const cue = parseSceneCue(raw)
    if (cue.body || cue.camera) {
        pendingSceneCue = cue
        if (!session.voiceEnabled || !voiceReady.value || interactionState.value === 'speaking') flushSceneCue()
    }
    const gesture = parseGesture(raw)
    if (gesture && !cue.body) controller?.queueGesture(gesture, session.voiceEnabled && voiceReady.value)
    const final = emotions ?? keywordFallback(stripped)
    if (!final) return
    session.mood = advanceMood(session.mood, final, Date.now() - session.moodUpdatedAt)
    session.moodUpdatedAt = Date.now()
    persistSession()
    controller?.setMood(session.mood)
    controller?.applyEmotion(final)
}

const ensureAgent = (): Agent => {
    const stored = loadStoredOpenRouterConfig() ?? getDefaultConfig()
    if (!stored?.apiKey) {
        chatError.value = '连接对话后，就可以和昔涟说话了。'
        throw new Error('Missing OpenRouter API key.')
    }
    suggestions.value = []
    if (!agentInstance) {
        agentInstance = new Agent({
            systemPrompt: buildCyrenePrompt(),
            initialHistory: recentConversation(session.messages),
            onFollowUps: items => {
                if (disposed) return
                session.followUps = addFollowUps(session.followUps, items)
                persistSession()
            },
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
    closeSpeechInput()
    settingsSaved.value = false
    topicsOpen.value = false
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
    configured.value = true
    agentInstance = null
    chatError.value = ''
    setTimeout(() => {
        settingsSaved.value = false
    }, 2000)
}

// Avatar ref
const avatarRef = ref<InstanceType<typeof Avatar> | null>(null)
const scenePanelOpen = ref(false)
const sceneBusy = ref(false)
const sceneSeated = ref(false)
const sceneNotice = ref('')
let sceneNoticeTimer: ReturnType<typeof setTimeout> | undefined
let pendingSceneCue: ReturnType<typeof parseSceneCue> | null = null
const noticeScene = (text: string) => {
    sceneNotice.value = text
    clearTimeout(sceneNoticeTimer)
    sceneNoticeTimer = setTimeout(() => { sceneNotice.value = '' }, 3600)
}
const handleSceneEvent = (event: SceneEvent) => {
    sceneBusy.value = event.phase === 'start'
    sceneSeated.value = avatarRef.value?.getSceneState().seated ?? false
    if (event.phase !== 'start') {
        session.sceneEvents ??= []
        session.sceneEvents.push({ timestamp: Date.now(), action: event.label, outcome: event.phase })
        session.sceneEvents = session.sceneEvents.slice(-20)
        persistSession()
    }
    noticeScene(event.phase === 'start' ? event.label : event.phase === 'cancel' ? '动作停下来了' : `${event.label} · 已完成`)
}
const requestBodyAction = (action: BodyAction) => {
    scenePanelOpen.value = false
    if (!avatarRef.value?.playBodyAction(action)) noticeScene(sceneSeated.value ? '先站起来，再走动吧。' : '稍等这个动作结束，再试一次。')
}
const requestCameraView = (view: CameraView) => {
    avatarRef.value?.setCameraView(view)
    scenePanelOpen.value = false
}
const flushSceneCue = () => {
    const cue = pendingSceneCue; pendingSceneCue = null
    if (cue?.body) requestBodyAction(cue.body)
    if (cue?.camera) avatarRef.value?.setCameraView(cue.camera)
}
onUnmounted(() => clearTimeout(sceneNoticeTimer))

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
        fact: [],
        preference: [],
        event: [],
        correction: [],
        context: [],
    }
    for (const m of filteredMemories.value) {
        groups[m.category].push(m)
    }
    return groups
})

const categoryLabel = (cat: MemoryCategory) =>
    ({
        fact: '事实',
        preference: '偏好',
        event: '事件',
        correction: '纠正',
        context: '背景',
    })[cat]

const subjectLabel = (subj: string) =>
    (
        ({
            user: '伙伴',
            character: '昔涟',
            world: '世界',
            relationship: '关系',
            other: '其他',
        }) as Record<string, string>
    )[subj] ?? subj

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
    isChatOpen.value = false
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
    setTimeout(() => {
        settingsSaved.value = false
    }, 2000)
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
            role: msg.sender === 'self' ? ('user' as const) : ('assistant' as const),
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
    closeSpeechInput()
    if (isResponding.value || activeSpeechId.value) interrupt()
    let agent: Agent
    try {
        agent = ensureAgent()
    } catch {
        return
    }
    const generation = ++runGeneration
    suggestionGeneration++
    suggestions.value = []
    const due = dueFollowUps(session.followUps)
    const presence = presenceContext(session, due)
    if (due.length) {
        session.followUps = settleFollowUps(session.followUps, due)
    }
    const requestedAt = performance.now()
    firstAudioLatency.value = ''
    const abort = new AbortController()
    requestController = abort
    const entry = appendEntry('user', trimmed, 'pending')
    activeEntry = entry
    customInput.value = ''
    topicsOpen.value = false
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
                if (!answer) {
                    answer = appendEntry('assistant', '', 'pending')
                    activeAnswer = answer
                }
                answer.content += delta
                if (!emotionApplied && EMOTE_TAG_RE.test(answer.content)) {
                    dispatchEmotion(answer.content)
                    emotionApplied = true
                }
                if (!voiceAttempted) {
                    voiceAttempted = true
                    if (session.voiceEnabled && voiceReady.value)
                        voiceStream = startVoiceStream(answer, requestedAt)
                }
                voiceStream?.push(delta)
                if (performance.now() - lastSave > 250) {
                    persistSession()
                    lastSave = performance.now()
                }
                scrollMessagesToBottom()
            },
            signal: abort.signal,
            interactionContext: `${presence}上一轮心境强度：${JSON.stringify(session.mood)}。当前场景状态：${JSON.stringify(avatarRef.value?.getSceneState())}。最近实际场景互动：${JSON.stringify(session.sceneEvents?.slice(-6) ?? [])}。没有接入摄像头；用户消息可能来自键盘或用户确认发送的语音转写。`,
        })
        if (generation !== runGeneration || disposed) return
        entry.status = 'complete'
        if (!answer) answer = appendEntry('assistant', result.content)
        else {
            ;(answer as ConversationEntry).content = result.content
            ;(answer as ConversationEntry).status = 'complete'
        }
        if (!emotionApplied) dispatchEmotion(result.content)
        ;(voiceStream as PhraseStream | null)?.end()
        activeAnswer = null
        if (!activeSpeechId.value) setInteraction('idle')
        scrollMessagesToBottom()
        void updateMemoryCount()
    } catch (error) {
        if (generation !== runGeneration || disposed) return
        pendingSceneCue = null
        avatarRef.value?.getVrmController?.()?.cancelGestures()
        entry.status = abort.signal.aborted ? 'interrupted' : 'failed'
        if (answer) (answer as ConversationEntry).status = entry.status
        activeAnswer = null
        localVoice.stop()
        activeSpeechId.value = null
        agentInstance = null
        chatError.value = error instanceof Error ? error.message : '暂时没能收到回复，请重试。'
        setInteraction('idle')
    } finally {
        if (generation === runGeneration && !disposed) {
            isResponding.value = false
            requestController = null
            activeEntry = null
            persistSession()
            if (topicsOpen.value) void updateSuggestions()
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
    document.addEventListener('visibilitychange', onVisibilityChange)
    const stored = loadStoredOpenRouterConfig()
    const defaultConfig = getDefaultConfig()
    configured.value = !!stored?.apiKey.trim()
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
        storageError.value =
            error instanceof Error ? error.message : '无法读取对话存档；本次记录请手动导出。'
    }
    isLoadingGreeting.value = true
    try {
        if (!session.messages.length) {
            const greeting = await generatePersonalizedGreeting()
            if (disposed) return
            appendEntry('assistant', greeting).kind = 'greeting'
            persistSession()
            dispatchEmotion(greeting)
        } else if (configured.value && shouldGreetOnReturn(session)) {
            await greetOnReturn()
            if (disposed) return
        }
        if (!disposed && configured.value) ensureAgent()
    } catch (error) {
        console.warn('Conversation initialization:', error)
    } finally {
        isLoadingGreeting.value = false
    }
    scrollMessagesToBottom()

    void updateMemoryCount()
})

onUnmounted(() => {
    disposed = true
    voiceLoadGeneration++
    localVoice.dispose()
    window.removeEventListener('pagehide', interrupt)
    document.removeEventListener('visibilitychange', onVisibilityChange)
    interrupt()
})

// 暴露 Avatar 引用
defineExpose({
    getAvatar: () => avatarRef.value,
})
</script>

<template>
    <div class="core-root" :class="{ 'is-quiet': quietMode }">
        <div class="scene">
            <Avatar
                ref="avatarRef"
                :show-fps="false"
                :show-loading-progress="false"
                @loading="handleAvatarProgress"
                @ready="handleAvatarReady"
                @interaction="handleSceneEvent"
            />
        </div>
        <div class="scene-shade" aria-hidden="true"></div>

        <header class="presence-header">
            <div class="presence-mark">
                <svg viewBox="0 0 28 32" aria-hidden="true">
                    <path
                        d="M14 28C13 15 2 16 3 5c8 0 12 8 11 23ZM14 28c0-11 11-10 11-20-8 0-12 9-11 20Z"
                        fill="currentColor"
                    />
                    <path d="M14 28V9" fill="none" stroke="currentColor" stroke-width=".7" /></svg
                ><span>昔涟</span><small>与你，此刻</small>
            </div>
            <nav class="presence-actions" aria-label="陪伴选项">
                <button class="ambient-button" @click="scenePanelOpen = true" aria-label="打开互动">
                    <span aria-hidden="true">✧</span><span>一起</span>
                </button>
                <button class="ambient-button" @click="openHistory" aria-label="打开共同经历">
                    <IconChatProcessingOutline /><span>回忆</span>
                </button>
                <button class="ambient-button" @click="openSettings" aria-label="打开设置">
                    <IconCog /><span>偏好</span>
                </button>
            </nav>
        </header>

        <div v-if="sceneNotice || sceneBusy" class="scene-feedback" role="status">
            <span>{{ sceneNotice }}</span>
            <button v-if="sceneBusy" class="text-button" @click="avatarRef?.stopBodyAction()" aria-label="停止动作">停一下</button>
        </div>
        <main v-show="!quietMode" class="companion-dock" aria-label="与昔涟对话">
            <section class="reply-caption" aria-label="昔涟的回复">
                <div class="caption-byline">
                    <span
                        class="presence-dot"
                        :class="{ 'presence-dot--busy': isResponding }"
                    ></span
                    ><span>昔涟</span
                    ><small role="status">{{ stateLabels[interactionState] }}</small>
                </div>
                <div class="caption-text">
                    <p v-if="isLoadingGreeting" class="caption-wait">稍等，我在这里。</p>
                    <p v-else-if="isResponding && !activeAnswer" class="caption-wait">
                        让我想一想…
                    </p>
                    <p v-else>{{ latestReply?.text || '你来啦，伙伴。' }}</p>
                </div>
            </section>

            <Transition name="soft-reveal">
                <div v-if="topicsOpen" class="topic-pocket" aria-label="聊点什么">
                    <div class="topic-heading">
                        <span>如果不知道从哪里说起</span
                        ><button
                            class="text-button"
                            @click="topicsOpen = false"
                            aria-label="收起话题"
                        >
                            收起
                        </button>
                    </div>
                    <button
                        v-for="suggestion in suggestions"
                        :key="suggestion"
                        class="topic-choice"
                        @click="handleSuggestionClick(suggestion)"
                        :disabled="isResponding || isLoadingGreeting"
                    >
                        {{ suggestion }}<span aria-hidden="true">↗</span>
                    </button>
                    <p v-if="!suggestions.length" class="muted-note">
                        {{
                            isGeneratingSuggestions
                                ? '想几个话题…'
                                : configured
                                  ? '说说今天的一件小事，也很好。'
                                  : '连接对话后，这里会出现适合你们的话题。'
                        }}
                    </p>
                </div>
            </Transition>

            <div class="composer">
                <label class="sr-only" for="companion-input">和昔涟说句话</label>
                <input
                    id="companion-input"
                    ref="composerRef"
                    v-model="customInput"
                    autocomplete="off"
                    placeholder="输入你想说的话..."
                    @keydown="onComposerKeydown"
                    @focus="onInputFocus"
                    @input="onComposerInput"
                    @blur="onInputBlur"
                    :disabled="isLoadingGreeting"
                />
                <button
                    v-if="isResponding || activeSpeechId"
                    class="interrupt-button"
                    @click="interrupt"
                    aria-label="打断"
                >
                    <span aria-hidden="true">Ⅱ</span><span>先等等</span>
                </button>
                <button
                    class="mic-button"
                    type="button"
                    :class="{ 'mic-button--active': speechInputActive }"
                    :aria-label="speechInputActive ? '停止语音输入' : '语音输入'"
                    :aria-pressed="speechInputActive"
                    :title="speechInput.supported ? '普通话语音输入' : '当前浏览器不支持语音输入'"
                    :disabled="isLoadingGreeting"
                    @click="toggleSpeechInput"
                >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                        <rect x="9" y="3" width="6" height="12" rx="3" />
                        <path d="M6 11v1a6 6 0 0 0 12 0v-1M12 18v3m-3 0h6" />
                    </svg>
                </button>
                <button
                    class="send-button"
                    type="button"
                    @click="submitCustomInput"
                    :disabled="isLoadingGreeting || !customInput.trim()"
                    :aria-label="isResponding ? '打断并发送' : '发送'"
                >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path
                            d="M12 19V5m-5 5 5-5 5 5"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="1.5"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                        />
                    </svg>
                </button>
            </div>
            <div v-if="speechInputHelp" class="speech-input-note">
                <p>普通话语音输入，由浏览器识别，可能联网处理。转成文字后，由你确认发送。</p>
                <div>
                    <button class="text-button" @click="startSpeechInput">开始说话</button
                    ><button class="text-button" @click="speechInputHelp = false">暂时不用</button>
                </div>
            </div>
            <div
                v-if="speechInputActive || speechInputError"
                class="speech-input-note"
                role="status"
            >
                <p>{{ speechInputError || speechInputStatus }}</p>
                <button
                    v-if="speechInputError"
                    class="text-button"
                    @click="speechInputError = ''"
                    aria-label="关闭语音输入提示"
                >
                    知道了
                </button>
            </div>
            <div class="dock-footnote">
                <button class="text-button" @click="enterQuietMode">
                    <span aria-hidden="true">◌</span> 静静陪伴
                </button>
                <div class="dock-options">
                    <button class="text-button" @click="toggleTopics" :aria-expanded="topicsOpen">
                        聊点什么</button
                    ><span aria-hidden="true">·</span
                    ><button
                        class="text-button"
                        :aria-pressed="props.musicEnabled"
                        @click="emit('toggle-music')"
                        :aria-label="
                            props.musicEnabled || props.musicBusy ? '关闭背景音乐' : '开启背景音乐'
                        "
                    >
                        {{
                            props.musicBusy ? '准备音乐…' : props.musicEnabled ? '音乐开' : '音乐关'
                        }}
                    </button>
                </div>
            </div>
            <button v-if="!configured && !chatError" class="connection-note" @click="openSettings">
                连接对话 <span>也可以先静静待一会儿</span><span aria-hidden="true">↗</span>
            </button>
            <div
                v-if="chatError || storageError || voiceError || props.musicError"
                class="gentle-notice"
                role="status"
            >
                <p>{{ storageError || chatError || voiceError || props.musicError }}</p>
                <button v-if="chatError && !configured" class="text-button" @click="openSettings">
                    连接对话
                </button>
                <button v-if="storageError" class="text-button" @click="exportConversation">
                    导出记录
                </button>
                <button v-else class="text-button" aria-label="关闭提示" @click="dismissNotice">
                    知道了
                </button>
            </div>
        </main>
        <div v-if="quietMode" class="quiet-return">
            <span>不说话，也可以。</span>
            <div>
                <button ref="quietReturnRef" class="quiet-return-button" @click="leaveQuietMode">
                    和昔涟说句话 <span aria-hidden="true">↗</span></button
                ><button
                    v-if="isResponding || activeSpeechId"
                    class="quiet-return-button"
                    @click="interrupt"
                    aria-label="打断"
                >
                    先等等
                </button>
            </div>
        </div>

        <CompanionSheet :open="scenePanelOpen" title="一起待一会儿" subtitle="轻触她的头或手，也会有回应。" @close="scenePanelOpen = false">
            <div class="scene-options">
                <p>换个距离</p>
                <div class="scene-choice-row">
                    <button class="soft-button" @click="requestCameraView('companion')">陪伴视角</button>
                    <button class="soft-button" @click="requestCameraView('full')">看看全身</button>
                    <button class="soft-button" @click="requestCameraView('close')">近一点看</button>
                </div>
                <p>此刻，做点什么</p>
                <div class="scene-action-grid">
                    <button v-for="action in (['approach', 'return', 'stretch', 'wave', 'offer_hand', 'headpat', 'sit', 'stand'] as const)"
                        :key="action" class="soft-button"
                        :disabled="sceneBusy || (action === 'stand' && !sceneSeated) || (sceneSeated && ['approach', 'return', 'stretch', 'sit'].includes(action))"
                        @click="requestBodyAction(action)">{{ ACTION_LABELS[action] }}</button>
                </div>
                <p class="scene-hint">在她头上轻轻划过，可以摸摸头。拖动空白处可以转动视角；手动调整时，镜头会听你的。</p>
            </div>
        </CompanionSheet>
        <CompanionSheet
            :open="isChatOpen"
            title="共同经历"
            subtitle="说过的话，留在这里。"
            @opened="scrollMessagesToBottom"
            wide
            @close="isChatOpen = false"
        >
            <div class="history-tools">
                <button class="text-button" @click="openMemoryPanel" aria-label="记忆管理">
                    记住的小事 <span>{{ memoryCount || '' }}</span></button
                ><button class="text-button" @click="exportConversation">导出记录</button>
            </div>
            <div ref="chatMessagesRef" class="conversation-pages" @scroll="trackHistoryScroll">
                <template v-for="(msg, index) in messages" :key="msg.id">
                    <p
                        v-if="
                            index === 0 ||
                            messageDate(session.messages[index]!.timestamp) !==
                                messageDate(session.messages[index - 1]!.timestamp)
                        "
                        class="memory-date"
                    >
                        {{ messageDate(session.messages[index]!.timestamp) }}
                    </p>
                    <article
                        class="conversation-entry"
                        :class="{ 'conversation-entry--self': msg.sender === 'self' }"
                    >
                        <span>{{ msg.sender === 'self' ? '你' : '昔涟' }}</span>
                        <p>{{ msg.text }}</p>
                        <small v-if="msg.status !== 'complete' || msg.speechInterrupted">{{
                            msg.speechInterrupted
                                ? '朗读已停下，文字仍在这里'
                                : msg.status === 'pending'
                                  ? msg.sender === 'ally'
                                      ? '正在写下…'
                                      : '等待回应'
                                  : msg.status === 'failed'
                                    ? '这次回复没有完成'
                                    : '这一句停在了这里'
                        }}</small>
                    </article>
                </template>
            </div>
        </CompanionSheet>

        <CompanionSheet
            :open="isSettingsOpen"
            title="偏好"
            subtitle="按你舒服的方式，相处。"
            @close="closeSettings"
        >
            <section class="preference-section">
                <div class="section-title">
                    <h3>听见昔涟</h3>
                    <span v-if="voiceReady" class="ready-note" role="status">声音已准备好</span>
                </div>
                <label class="voice-toggle"
                    ><span>朗读昔涟的回复</span
                    ><input
                        v-model="session.voiceEnabled"
                        :disabled="!voiceReady"
                        type="checkbox"
                        role="switch"
                        @change="toggleVoice"
                /></label>
                <p class="muted-note">
                    只使用昔涟的声音。首次需要加载约 759 MiB；准备好后再开启，不会自动播放。
                </p>
                <div class="button-pair">
                    <button
                        class="soft-button"
                        :disabled="voiceLoading || voiceReady"
                        @click="prepareVoice()"
                    >
                        {{
                            voiceLoading
                                ? '正在准备声音…'
                                : voiceReady
                                  ? '声音已就绪'
                                  : '加载角色声音'
                        }}</button
                    ><button
                        class="text-button"
                        :disabled="!voiceReady || isResponding"
                        @click="previewVoice"
                    >
                        试听昔涟声音
                    </button>
                </div>
                <p v-if="voiceError" class="muted-note" role="status">{{ voiceError }}</p>
                <details class="preference-details">
                    <summary>兼容性与加载状态</summary>
                    <label class="field"
                        >声音来源<select v-model="voiceBackend" @change="changeVoiceBackend">
                            <option value="webgpu">昔涟 · 本地 WebGPU</option>
                            <option value="wasm">昔涟 · 本地 WASM（较慢）</option>
                        </select></label
                    >
                    <p class="muted-note" role="status">{{ voiceStatus }}</p>
                    <p class="muted-note">{{ firstAudioLatency }} {{ voiceMetrics }}</p>
                </details>
            </section>
            <section class="preference-section">
                <div class="section-title">
                    <h3>背景音乐</h3>
                    <button
                        class="text-button"
                        :aria-pressed="props.musicEnabled"
                        @click="emit('toggle-music')"
                    >
                        {{ props.musicEnabled || props.musicBusy ? '关闭音乐' : '开启音乐' }}
                    </button>
                </div>
                <p class="muted-note">只在你想听的时候，轻轻放一点音乐。</p>
                <p v-if="props.musicError" class="muted-note" role="status">
                    {{ props.musicError }}
                </p>
            </section>
            <details class="preference-section connection-details" :open="!configured">
                <summary>
                    对话连接 <span>{{ configured ? '已配置' : '尚未连接' }}</span>
                </summary>
                <p class="muted-note">
                    填写你自己的 OpenRouter 密钥，开始对话。未连接时也可以留在这里。
                </p>
                <form class="preference-form" @submit.prevent="handleSettingsSubmit">
                    <label class="field"
                        >API 密钥<input
                            v-model="settingsForm.apiKey"
                            type="password"
                            required
                            autocomplete="off"
                            placeholder="sk-..." /></label
                    ><label class="field"
                        >模型<input
                            v-model="settingsForm.model"
                            type="text"
                            placeholder="如：google/gemini-2.5-flash"
                    /></label>
                    <div class="form-footer">
                        <span v-if="settingsSaved" role="status">已保存</span
                        ><button
                            class="soft-button"
                            type="submit"
                            :disabled="!settingsForm.apiKey.trim()"
                        >
                            保存
                        </button>
                    </div>
                </form>
            </details>
            <details class="preference-section preference-details">
                <summary>更多记忆设置</summary>
                <div class="preference-form">
                    <label class="voice-toggle"
                        ><span>启用语义检索</span
                        ><input v-model="embeddingsForm.enabled" type="checkbox"
                    /></label>
                    <p class="muted-note">
                        默认使用关键词回忆。需要语义检索时，可配置兼容的 embeddings 服务。
                    </p>
                    <label class="field"
                        >Base URL<input
                            v-model="embeddingsForm.baseUrl"
                            placeholder="https://api.openai.com/v1" /></label
                    ><label class="field"
                        >检索 API Key<input
                            v-model="embeddingsForm.apiKey"
                            type="password"
                            autocomplete="off"
                            placeholder="sk-..." /></label
                    ><label class="field"
                        >检索模型<input
                            v-model="embeddingsForm.model"
                            placeholder="text-embedding-3-small" /></label
                    ><label class="field"
                        >维度<input
                            v-model.number="embeddingsForm.dimensions"
                            type="number"
                            placeholder="512" /></label
                    ><button class="soft-button" @click="handleEmbeddingsSave">保存语义配置</button>
                </div>
            </details>
        </CompanionSheet>
        <CompanionSheet
            :open="isMemoryPanelOpen"
            title="记住的小事"
            :subtitle="`留下了 ${memoryCount} 条记忆，你可以随时修改。`"
            wide
            @close="closeMemoryPanel"
            ><div class="memory-content">
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
                    <div
                        v-if="filteredMemories.length === 0"
                        class="py-12 text-center text-white/40"
                    >
                        <IconBrain class="mx-auto h-12 w-12 mb-4 opacity-50" />
                        <p v-if="allMemories.length === 0">暂无记忆</p>
                        <p v-else>没有匹配的记忆</p>
                        <p class="text-sm mt-2" v-if="allMemories.length === 0">
                            与昔涟对话时，重要信息会被自动记住
                        </p>
                    </div>

                    <!-- 分组视图 -->
                    <template v-else-if="groupedMemories">
                        <div
                            v-for="cat in [
                                'fact',
                                'preference',
                                'event',
                                'correction',
                                'context',
                            ] as const"
                            :key="cat"
                        >
                            <div v-if="groupedMemories[cat].length > 0" class="mb-4">
                                <h3
                                    class="text-xs font-semibold text-white/40 uppercase tracking-wider mb-2 px-1"
                                >
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
                                            <div
                                                class="flex items-center gap-4 text-xs text-white/60"
                                            >
                                                <label class="flex items-center gap-2 flex-1">
                                                    <span class="shrink-0">重要性</span>
                                                    <input
                                                        v-model.number="editingMemoryImportance"
                                                        type="range"
                                                        min="1"
                                                        max="10"
                                                        class="flex-1 accent-pink-400"
                                                    />
                                                    <span class="w-6 text-center">{{
                                                        editingMemoryImportance
                                                    }}</span>
                                                </label>
                                                <label class="flex items-center gap-2 flex-1">
                                                    <span class="shrink-0">可信度</span>
                                                    <input
                                                        v-model.number="editingMemoryConfidence"
                                                        type="range"
                                                        min="1"
                                                        max="10"
                                                        class="flex-1 accent-blue-400"
                                                    />
                                                    <span class="w-6 text-center">{{
                                                        editingMemoryConfidence
                                                    }}</span>
                                                </label>
                                            </div>
                                            <div class="flex justify-end gap-2">
                                                <button
                                                    @click="cancelEditMemory"
                                                    class="px-3 py-1.5 text-xs text-white/60 hover:text-white"
                                                >
                                                    取消
                                                </button>
                                                <button
                                                    @click="saveEditMemory"
                                                    class="px-4 py-1.5 text-xs font-medium bg-white/15 hover:bg-white/25 text-white rounded-full"
                                                >
                                                    保存
                                                </button>
                                            </div>
                                        </div>

                                        <!-- 浏览模式 -->
                                        <div v-else class="flex items-start gap-3">
                                            <span
                                                class="shrink-0 rounded-lg bg-pink-500/15 px-2 py-1 text-[10px] font-medium text-pink-300"
                                            >
                                                {{ subjectLabel(memory.subject) }}
                                            </span>
                                            <div class="flex-1 min-w-0">
                                                <p class="text-sm text-white/90 leading-relaxed">
                                                    {{ memory.content }}
                                                </p>
                                                <div
                                                    class="mt-2 flex items-center gap-3 text-[10px] text-white/30 flex-wrap"
                                                >
                                                    <span>重要 {{ memory.importance }}</span>
                                                    <span>可信 {{ memory.confidence }}</span>
                                                    <span
                                                        >强度 {{ memory.strength.toFixed(1) }}</span
                                                    >
                                                    <span v-if="memory.accessCount > 0"
                                                        >访问 {{ memory.accessCount }}×</span
                                                    >
                                                    <span>{{
                                                        formatRelativeTime(memory.lastAccessedAt)
                                                    }}</span>
                                                    <span
                                                        v-if="memory.expiresAt"
                                                        class="text-amber-400/60"
                                                        >⏱
                                                        {{
                                                            formatRelativeTime(memory.expiresAt)
                                                        }}</span
                                                    >
                                                </div>
                                            </div>
                                            <div
                                                class="shrink-0 flex gap-1 memory-row-actions transition"
                                            >
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
                                        <input
                                            v-model.number="editingMemoryImportance"
                                            type="range"
                                            min="1"
                                            max="10"
                                            class="flex-1 accent-pink-400"
                                        />
                                        <span class="w-6 text-center">{{
                                            editingMemoryImportance
                                        }}</span>
                                    </label>
                                    <label class="flex items-center gap-2 flex-1">
                                        <span class="shrink-0">可信度</span>
                                        <input
                                            v-model.number="editingMemoryConfidence"
                                            type="range"
                                            min="1"
                                            max="10"
                                            class="flex-1 accent-blue-400"
                                        />
                                        <span class="w-6 text-center">{{
                                            editingMemoryConfidence
                                        }}</span>
                                    </label>
                                </div>
                                <div class="flex justify-end gap-2">
                                    <button
                                        @click="cancelEditMemory"
                                        class="px-3 py-1.5 text-xs text-white/60 hover:text-white"
                                    >
                                        取消
                                    </button>
                                    <button
                                        @click="saveEditMemory"
                                        class="px-4 py-1.5 text-xs font-medium bg-white/15 hover:bg-white/25 text-white rounded-full"
                                    >
                                        保存
                                    </button>
                                </div>
                            </div>
                            <div v-else class="flex items-start gap-3">
                                <span
                                    class="shrink-0 rounded-lg bg-pink-500/15 px-2 py-1 text-[10px] font-medium text-pink-300"
                                >
                                    {{ categoryLabel(memory.category) }}·{{
                                        subjectLabel(memory.subject)
                                    }}
                                </span>
                                <div class="flex-1 min-w-0">
                                    <p class="text-sm text-white/90 leading-relaxed">
                                        {{ memory.content }}
                                    </p>
                                    <div
                                        class="mt-2 flex items-center gap-3 text-[10px] text-white/30 flex-wrap"
                                    >
                                        <span>重要 {{ memory.importance }}</span>
                                        <span>可信 {{ memory.confidence }}</span>
                                        <span>强度 {{ memory.strength.toFixed(1) }}</span>
                                        <span v-if="memory.accessCount > 0"
                                            >访问 {{ memory.accessCount }}×</span
                                        >
                                        <span>{{ formatRelativeTime(memory.lastAccessedAt) }}</span>
                                    </div>
                                </div>
                                <div class="shrink-0 flex gap-1 memory-row-actions transition">
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

                <footer
                    class="px-8 py-4 border-t border-white/5 shrink-0 flex items-center justify-between gap-2"
                >
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
                        <input
                            ref="fileInputRef"
                            type="file"
                            accept="application/json"
                            class="hidden"
                            @change="handleImportFile"
                        />
                    </div>
                    <button
                        v-if="memoryCount > 0"
                        @click="clearAllMemories"
                        class="rounded-full border border-red-500/30 bg-red-500/10 px-4 py-2 text-xs font-medium text-red-300 transition hover:bg-red-500/20"
                    >
                        清除所有
                    </button>
                </footer>
            </div></CompanionSheet
        >
    </div>
</template>

<style scoped>
.scene-feedback { position: fixed; z-index: 21; top: 85px; right: 36px; display: flex; align-items: center; gap: 14px; color: #eee7ec; font-size: 12px; text-shadow: 0 1px 8px #24212e; }
.scene-options { display: grid; gap: 18px; padding: 6px 0; }
.scene-options > p { color: var(--muted, #aca3b8); font-size: 12px; }
.scene-choice-row { display: flex; flex-wrap: wrap; gap: 8px; }
.scene-action-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.scene-hint { line-height: 1.9; }
@media (max-width: 600px) { .scene-feedback { right: 20px; top: 78px; } }
.core-root {
    --ink: #24212e;
    --dusk: #3a3448;
    --mist: #e7e2ee;
    --petal: #e2b8cc;
    --muted: #aca3b8;
    color: var(--mist);
    font-family: 'PingFang SC', 'Microsoft YaHei', sans-serif;
}
.scene {
    position: fixed;
    inset: 0;
    z-index: 0;
}
.scene-shade {
    position: fixed;
    inset: 0;
    z-index: 1;
    pointer-events: none;
    background: linear-gradient(
        180deg,
        #24212e35 0,
        transparent 18%,
        transparent 54%,
        #24212e12 65%,
        #24212e9c 100%
    );
    transition: opacity 0.5s;
}
.is-quiet .scene-shade {
    opacity: 0.45;
}
.presence-header {
    position: fixed;
    top: max(28px, env(safe-area-inset-top));
    left: 36px;
    right: 36px;
    z-index: 20;
    display: flex;
    align-items: center;
    justify-content: space-between;
    pointer-events: none;
}
.presence-mark {
    display: flex;
    align-items: center;
    gap: 10px;
    text-shadow: 0 1px 12px #24212e88;
}
.presence-mark svg {
    width: 22px;
    height: 27px;
    color: var(--petal);
    opacity: 0.82;
}
.presence-mark > span {
    font:
        400 22px/1 'Songti SC',
        'Noto Serif CJK SC',
        serif;
    letter-spacing: 0.14em;
}
.presence-mark small {
    font-size: 10px;
    letter-spacing: 0.18em;
    margin-left: 8px;
    color: #e7e2eeb3;
}
.presence-actions {
    display: flex;
    gap: 6px;
    pointer-events: auto;
}
.ambient-button {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 10px 12px;
    font-size: 12px;
    border: 1px solid transparent;
    border-radius: 20px;
    background: #24212e18;
    color: #f2edf4d9;
    text-shadow: 0 1px 8px #24212e;
    transition: background 0.2s;
}
.ambient-button svg {
    width: 16px;
    height: 16px;
    opacity: 0.8;
}
.ambient-button:hover {
    background: #24212e70;
    border-color: #e7e2ee20;
}
.companion-dock {
    position: fixed;
    z-index: 20;
    bottom: max(22px, env(safe-area-inset-bottom));
    left: 50%;
    transform: translateX(-50%);
    width: min(560px, calc(100% - 48px));
}
.reply-caption {
    padding: 0 20px 22px;
    text-shadow:
        0 2px 14px #15121ccb,
        0 1px 3px #15121c80;
}
.caption-byline {
    display: flex;
    align-items: center;
    gap: 9px;
    margin-bottom: 10px;
    font-size: 12px;
    letter-spacing: 0.12em;
}
.caption-byline small {
    font-size: 10px;
    color: #e7e2eebf;
    margin-left: 5px;
    letter-spacing: 0.04em;
}
.presence-dot {
    height: 4px;
    width: 4px;
    border-radius: 50%;
    background: var(--petal);
}
.presence-dot--busy {
    animation: breathing 2s ease-in-out infinite;
}
.caption-text {
    max-height: 132px;
    overflow-y: auto;
    scrollbar-width: thin;
    scrollbar-color: #e7e2ee33 transparent;
}
.caption-text p {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    color: #fbf7fc;
    font:
        400 21px/1.8 'Songti SC',
        'Noto Serif CJK SC',
        'SimSun',
        serif;
    letter-spacing: 0.035em;
}
.caption-text .caption-wait {
    font-size: 17px;
    color: #e7e2eea8;
}
.composer {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 9px 8px 20px;
    min-height: 56px;
    border: 1px solid #e7e2ee2b;
    border-radius: 28px;
    background: #24212e85;
    backdrop-filter: blur(14px);
    transition:
        border-color 0.2s,
        background 0.2s;
}
.composer:focus-within {
    border-color: #e2b8cc80;
    background: #24212eb3;
}
.composer input {
    flex: 1;
    width: 0;
    min-width: 0;
    border: 0;
    background: none;
    color: #f8f3fa;
    font-size: 14px;
    line-height: 24px;
    padding: 0;
    outline: none;
}
.composer input::placeholder {
    color: #e7e2ee91;
    font-weight: 300;
}
.mic-button {
    width: 40px;
    height: 40px;
    flex-shrink: 0;
    display: grid;
    place-items: center;
    border: 0;
    border-radius: 50%;
    color: #e7e2ee;
    background: transparent;
}
.mic-button:hover {
    background: #e7e2ee16;
}
.mic-button:disabled {
    opacity: 0.4;
}
.mic-button--active {
    color: #332738;
    background: #e2b8cc;
}
.mic-button--active:hover {
    background: #f0cede;
}
.mic-button svg {
    width: 20px;
    height: 20px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
}
.speech-input-note {
    margin: 10px 14px 0;
    color: #e7e2ee;
    font-size: 12px;
    line-height: 1.7;
}
.speech-input-note p {
    margin: 0;
}
.speech-input-note > div {
    display: flex;
    gap: 20px;
    margin-top: 5px;
    color: #e2b8cc;
}
.send-button {
    width: 36px;
    height: 36px;
    flex-shrink: 0;
    border: 0;
    border-radius: 50%;
    background: #e2b8cc;
    color: #332738;
    transition:
        background 0.2s,
        opacity 0.2s;
}
.send-button svg {
    width: 22px;
    height: 22px;
    margin: auto;
}
.send-button:disabled {
    background: #e7e2ee13;
    color: #e7e2ee66;
}
.interrupt-button {
    display: flex;
    align-items: center;
    flex-shrink: 0;
    gap: 5px;
    border: 0;
    background: transparent;
    color: var(--petal);
    font-size: 11px;
    padding: 8px 5px;
}
.dock-footnote {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 15px 0;
    font-size: 11px;
    color: #e7e2eebd;
}
.dock-options {
    display: flex;
    align-items: center;
    gap: 13px;
}
.text-button {
    border: 0;
    padding: 4px 0;
    font: inherit;
    font-size: 12px;
    color: inherit;
    background: none;
    transition: color 0.2s;
}
.text-button:hover {
    color: #fff;
}
.text-button:disabled {
    opacity: 0.4;
}
.dock-footnote .text-button {
    font-size: 11px;
    text-shadow: 0 1px 6px #24212e;
}
.connection-note {
    display: flex;
    gap: 10px;
    align-items: center;
    margin: 16px auto 0;
    border: 0;
    padding: 4px;
    background: transparent;
    color: var(--petal);
    font-size: 11px;
}
.connection-note > span:first-child {
    color: #e7e2eea6;
}
.topic-pocket {
    position: absolute;
    bottom: calc(100% + 10px);
    right: 0;
    width: min(340px, 100%);
    padding: 18px 20px;
    background: #24212eef;
    border: 1px solid #e7e2ee20;
    border-radius: 18px;
    box-shadow: 0 6px 24px #15121c30;
}
.topic-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    color: var(--muted);
    font-size: 11px;
    gap: 12px;
}
.topic-heading .text-button {
    font-size: 11px;
}
.topic-choice {
    width: 100%;
    display: flex;
    gap: 16px;
    justify-content: space-between;
    border: 0;
    border-bottom: 1px solid #e7e2ee14;
    background: none;
    padding: 13px 0;
    text-align: left;
    font-size: 13px;
    line-height: 1.7;
    color: var(--mist);
}
.topic-choice:last-child {
    border-bottom: 0;
    padding-bottom: 0;
}
.topic-choice span {
    color: var(--petal);
}
.gentle-notice {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 8px 16px;
    margin-top: 12px;
    padding: 12px 16px;
    border-radius: 16px;
    background: #24212ec9;
    border: 1px solid #e2b8cc25;
    color: #e7e2eecc;
    font-size: 12px;
}
.gentle-notice p {
    flex: 1 1 200px;
    margin: 0;
    line-height: 1.7;
    overflow-wrap: anywhere;
}
.gentle-notice button {
    color: var(--petal);
}
.quiet-return {
    position: fixed;
    bottom: max(30px, env(safe-area-inset-bottom));
    left: 50%;
    transform: translateX(-50%);
    z-index: 20;
    text-align: center;
    white-space: nowrap;
}
.quiet-return > span {
    display: block;
    margin-bottom: 16px;
    font:
        13px/1.5 'Songti SC',
        serif;
    letter-spacing: 0.14em;
    color: #f3edf6cc;
    text-shadow: 0 1px 10px #24212e;
}
.quiet-return-button {
    padding: 11px 18px;
    color: #e7e2ee;
    background: #24212e70;
    border: 1px solid #e7e2ee30;
    border-radius: 24px;
    font-size: 12px;
    backdrop-filter: blur(10px);
    margin: 0 4px;
}
.quiet-return-button span {
    margin-left: 12px;
    color: var(--petal);
}
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
.preference-section {
    padding: 24px 0;
    border-bottom: 1px solid #e7e2ee16;
}
.preference-section:first-child {
    padding-top: 0;
}
.preference-section:last-child {
    border-bottom: 0;
}
.section-title {
    display: flex;
    gap: 12px;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 17px;
}
.section-title h3 {
    font:
        500 14px/1.5 'PingFang SC',
        sans-serif;
    margin: 0;
    color: #e7e2ee;
}
.ready-note {
    font-size: 10px;
    color: #e2b8cc;
}
.voice-toggle {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 16px;
    font-size: 13px;
    color: #e7e2ee;
}
.voice-toggle input {
    accent-color: #e2b8cc;
    width: 16px;
    height: 16px;
}
.muted-note {
    margin: 12px 0;
    font-size: 12px;
    line-height: 1.85;
    color: #aca3b8;
}
.button-pair {
    display: flex;
    gap: 22px;
    align-items: center;
    margin: 18px 0 6px;
}
.soft-button {
    padding: 9px 15px;
    border-radius: 10px;
    background: #e7e2ee0d;
    border: 1px solid #e7e2ee26;
    color: #e7e2ee;
    font-size: 12px;
    line-height: 1.6;
}
.soft-button:hover {
    border-color: #e2b8cc99;
}
.soft-button:disabled {
    opacity: 0.45;
}
.preference-details summary {
    font-size: 11px;
    color: #aca3b8;
    padding: 12px 0 2px;
}
.preference-details[open] summary {
    margin-bottom: 12px;
}
.connection-details > summary {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    color: #e7e2ee;
    font-size: 14px;
    list-style: none;
}
.connection-details > summary span {
    color: #aca3b8;
    font-size: 11px;
}
.preference-form {
    display: flex;
    flex-direction: column;
    gap: 18px;
    margin-top: 18px;
}
.field {
    display: flex;
    flex-direction: column;
    gap: 9px;
    font-size: 12px;
    color: #aca3b8;
}
.field input,
.field select {
    width: 100%;
    min-width: 0;
    border: 1px solid #e7e2ee24;
    border-radius: 9px;
    background: #19152050;
    padding: 10px 12px;
    color: #e7e2ee;
    font-size: 13px;
    outline: none;
}
.field input:focus,
.field select:focus {
    border-color: #e2b8cc90;
}
.field select option {
    background: #24212e;
}
.form-footer {
    display: flex;
    justify-content: flex-end;
    gap: 16px;
    align-items: center;
    font-size: 12px;
    color: #e2b8cc;
}
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
button:disabled {
    cursor: not-allowed;
}
button:focus-visible,
summary:focus-visible {
    outline: 2px solid #e2b8cc;
    outline-offset: 4px;
}
.soft-reveal-enter-active,
.soft-reveal-leave-active {
    transition:
        opacity 0.2s,
        transform 0.2s;
}
.soft-reveal-enter-from,
.soft-reveal-leave-to {
    opacity: 0;
    transform: translateY(6px);
}
@keyframes breathing {
    50% {
        opacity: 0.3;
    }
}
@media (max-width: 600px) {
    .presence-header {
        top: max(20px, env(safe-area-inset-top));
        left: 20px;
        right: 16px;
    }
    .presence-mark small {
        display: none;
    }
    .presence-mark > span {
        font-size: 19px;
    }
    .presence-actions {
        gap: 0;
    }
    .ambient-button {
        padding: 10px;
        gap: 5px;
    }
    .companion-dock {
        width: calc(100% - 32px);
        bottom: max(15px, env(safe-area-inset-bottom));
    }
    .reply-caption {
        padding: 0 12px 19px;
    }
    .caption-text {
        max-height: 112px;
    }
    .caption-text p {
        font-size: 19px;
    }
    .composer {
        padding-left: 16px;
        min-height: 54px;
    }
    .composer input {
        font-size: 16px;
    }
    .dock-footnote {
        padding-left: 9px;
        padding-right: 9px;
    }
    .connection-note {
        gap: 8px;
        font-size: 10px;
        margin-top: 12px;
    }
    .conversation-pages {
        max-height: 60dvh;
    }
    .interrupt-button > span:last-child {
        display: none;
    }
    .memory-row-actions {
        opacity: 1;
    }
}
@media (max-height: 520px) {
    .reply-caption {
        padding-bottom: 10px;
    }
    .caption-text {
        max-height: 70px;
    }
    .connection-note {
        display: none;
    }
}
@media (prefers-reduced-motion: reduce) {
    *,
    *::before,
    *::after {
        animation: none !important;
        transition: none !important;
    }
}
</style>
