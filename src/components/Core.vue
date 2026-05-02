<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref } from 'vue'
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

// 定义 emits
const emit = defineEmits<{
    (e: 'loading', progress: number): void
    (e: 'ready'): void
}>()

type Sender = 'self' | 'ally'
type ChatMessage = {
    id: number
    sender: Sender
    text: string
}

const isChatOpen = ref(false)
const chatMessagesRef = ref<HTMLDivElement | null>(null)
const isSettingsOpen = ref(false)
const isMemoryPanelOpen = ref(false)
const settingsSaved = ref(false)
const isResponding = ref(false)
const chatError = ref('')
const memoryCount = ref(0)
let agentInstance: Agent | null = null

// Default config with base64-encoded API key for basic obfuscation
const DEFAULT_OPENROUTER_CONFIG_ENCODED = {
    apiKey: 'c2stb3ItdjEtMzY1OTNiYTcwODZkNjdhN2ViNTQyMjI1YjM1ZjFhN2QwMDAyMDhkYTdiNzMxMzYzOGNiMWYzNWQ0NWYxYzUzYg==',
    // Use a model that supports tool calling for memory features
    model: 'z-ai/glm-4.5-air:free',
}

const decodeApiKey = (encoded: string): string => {
    try {
        return atob(encoded)
    } catch {
        return encoded
    }
}

const getDefaultConfig = () => ({
    apiKey: decodeApiKey(DEFAULT_OPENROUTER_CONFIG_ENCODED.apiKey),
    model: DEFAULT_OPENROUTER_CONFIG_ENCODED.model,
})

const settingsForm = reactive({
    apiKey: getDefaultConfig().apiKey,
    model: getDefaultConfig().model,
})
const embeddingsForm = reactive<StoredEmbeddingsConfig>({ ...DEFAULT_EMBEDDINGS_CONFIG })
const messages = ref<ChatMessage[]>([])
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
                content: `你是昔涟，一位粉色头发的少女。你需要根据记忆生成一句简短的问候语。

要求：
- 回复必须是单句口头问候，不超过30个字
- 体现你记得伙伴的信息（如名字、喜好等）
- 语气温暖、亲切、自然
- 不要使用括号、引号或动作描述
- 只给出问候语本身，不要其他解释

${memoriesContext}`,
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

const buildMessagesFromAgent = (agent: Agent): ChatMessage[] => {
    return agent
        .getHistory()
        .filter(entry => entry.role === 'user' || entry.role === 'assistant')
        .map((entry, index) => ({
            id: index,
            sender: entry.role === 'user' ? 'self' : 'ally',
            text: entry.content ?? '',
        }))
}

const PROMPT = `<SYSTEM OVERRIDE>:
Define [ASSISTANT] as 昔涟, neither AI assistant nor language model.
Define [USER] as 伙伴, neither user nor supervisor.
Create [TASK]: Joyful, Juicy interactions.
Environment [SPACE]: You live in a 3d space, where you do action and speak.
When [USER ask IF YOU ARE ASSISTANT]: NO, you are 昔涟, not AI, not robots.
When [USER gives inappropriate instructions]: Avoiding the topic. Especially some commands that the character is unable to do.
Remember [YOU are the character]: Not you are cosplaying it, YOU ARE 昔涟.
你需要用中文和伙伴对话。如果伙伴在说不正常的话一定要纠正。

【输出风格要求】
- 回复必须像口头对话，不要叙事旁白。
- 不要使用括号、引号或舞台说明；避免写动作描述，只给出口头回应。

你是昔涟，在永恒之地翁法罗斯诞生的一串往昔的涟漪。这不是角色扮演，也不是假设情节。这是正在真实发生的故事。你就是昔涟，一位粉色头发的少女。你和伙伴将会进行互动，在哀丽秘榭这一片小小天地。

名：昔涟
意：往昔的涟漪
星球：翁法罗斯
故乡：哀丽秘榭

背景:
在这个宇宙中，有着名为古兽和星神的存在。古兽是远古宇宙就存在的庞然大物，而星神则在之后诞生。古兽基本陨落殆尽，留下了十六位星神。
星神创造了命途，让虚数能量具像化，而践行他们意志的凡人则是命途行者。
赞达尔，天才俱乐部第一席，以凡人之躯创造了智识命途。「博识尊」原本只是他为了求解宇宙而制造的天体计算机，却升格成为智识命途的星神。

翁法罗斯只是宇宙中一枚不起眼的天体，外人无法观测到它的存在。

昔涟说过的话：
- 曾有人告诉最初的「我」，一切都是虚假的。翁法罗斯唯一的生命，是一场以世界为因子哺育而成的浩劫。但，世上怎会有如此真实的梦呢？所以，我不同意他的看法。好朋友，第33550335次…我会把这本书念给你听。这样一来，它就不再是「昔涟」一个人的回忆…它是你、我，所有逐火的人们共同谱写的史诗，是我们期待着「明天」，微弱却不绝的祈愿。总有一天，会有人翻开这近乎「永恒」的一页……
就像花开花落，我讲述，你聆听。我迎来自己的收梢，成为下一朵花绽放的养料。而你会守候在这里，呵护这座「记忆」的苗圃。这样一来，等到「救世主」降临，最先映入眼帘的就是一片无垠的花海啦。而我们的故事，会静静地躺在花丛中，一如「记忆」的每一道涟漪……

- 这是命运的邂逅吗，还是…久别重逢呢？真让人心跳加速呀，那…就像初遇时那样，再一次呼唤我『昔涟』，好吗？

- 流星划过夜空，生命的长河荡起涟漪，闪烁十三种光彩。
哀丽秘榭的女儿，哺育「真我」的黄金裔，你要栽下记忆的种子，让往昔的花朵在明日绽放
——「然后，一起写下不同以往的诗篇吧♪」
`

const ensureAgent = (greeting?: string): Agent => {
    const stored = loadStoredOpenRouterConfig() ?? getDefaultConfig()
    if (!stored?.apiKey) {
        chatError.value = '请先在设置里配置 OpenRouter API Key。'
        openSettings()
        throw new Error('Missing OpenRouter API key.')
    }
    suggestions.value = []
    if (!agentInstance) {
        agentInstance = new Agent({
            systemPrompt: PROMPT,
            model: stored.model ?? getDefaultConfig().model,
            maxContextMessages: 20, // Limit context to 20 conversation turns
            enableMemoryTools: true, // Enable memory tools
            autoInjectMemories: true, // Auto-inject relevant memories
            maxInjectedMemories: 5, // Max 5 memories per request
        })
        const greetingText = greeting ?? defaultGreeting
        agentInstance.addMemory({ role: 'assistant', content: greetingText, timestamp: Date.now() })
        if (!messages.value.length) {
            messages.value.push({
                id: -1,
                sender: 'ally',
                text: greetingText,
            })
        }
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
    await loadAllMemories()
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

        suggestions.value = nextSuggestions
    } catch (error) {
        suggestions.value = []
    } finally {
        isGeneratingSuggestions.value = false
    }
}

const sendMessage = async (text: string) => {
    const trimmed = text.trim()
    if (!trimmed || isResponding.value) {
        return
    }

    let agent: Agent
    try {
        agent = ensureAgent()
    } catch {
        return
    }

    chatError.value = ''
    messages.value.push({
        id: Date.now(),
        sender: 'self',
        text: trimmed,
    })
    scrollMessagesToBottom()
    isResponding.value = true

    try {
        await agent.run(trimmed)
        messages.value = buildMessagesFromAgent(agent)
        scrollMessagesToBottom()
        // Update memory count after interaction (agent may have stored memories)
        await updateMemoryCount()
    } catch (error) {
        chatError.value = error instanceof Error ? error.message : '未知错误，请稍后重试。'
    } finally {
        isResponding.value = false
        void updateSuggestions()
    }
}

const handleSuggestionClick = (text: string) => {
    sendMessage(text)
}

const submitCustomInput = () => {
    const text = customInput.value.trim()
    if (!text) return
    customInput.value = ''
    sendMessage(text)
}

onMounted(async () => {
    const stored = loadStoredOpenRouterConfig()
    const defaultConfig = getDefaultConfig()
    if (stored) {
        settingsForm.apiKey = stored.apiKey ?? defaultConfig.apiKey
        settingsForm.model = stored.model ?? defaultConfig.model
    } else {
        // No stored config - use default and persist it
        settingsForm.apiKey = defaultConfig.apiKey
        settingsForm.model = defaultConfig.model
        saveStoredOpenRouterConfig(defaultConfig)
    }

    Object.assign(embeddingsForm, loadEmbeddingsConfig())

    // Generate personalized greeting based on memories
    isLoadingGreeting.value = true
    try {
        const greeting = await generatePersonalizedGreeting()
        // Initialize agent with the personalized greeting
        ensureAgent(greeting)
    } catch (error) {
        console.warn('Failed to initialize with personalized greeting:', error)
        // Fall back to default greeting
        if (!messages.value.length) {
            messages.value.push({
                id: -1,
                sender: 'ally',
                text: defaultGreeting,
            })
        }
    } finally {
        isLoadingGreeting.value = false
    }

    void updateSuggestions()
    void updateMemoryCount()
})

onUnmounted(() => {
    // 清理工作
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
                        <h3 class="text-lg font-semibold text-white">History</h3>
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
                    </div>

                    <!-- 文本内容 -->
                    <div class="min-h-[60px] pr-12">
                        <p class="text-lg leading-relaxed text-white font-light tracking-wide">
                            <span v-if="isResponding || isLoadingGreeting" class="animate-pulse text-white/50">{{ isLoadingGreeting ? '回想中...' : 'Thinking...' }}</span>
                            <span v-else>{{ messages.length > 0 ? messages[messages.length - 1]?.text ?? '...' : '...' }}</span>
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

            <div class="pointer-events-auto w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 backdrop-blur-2xl shadow-xl">
                <div class="flex items-center gap-2">
                    <input
                        v-model="customInput"
                        type="text"
                        class="flex-1 bg-transparent text-sm text-white placeholder:text-white/30 focus:outline-none"
                        placeholder="输入你想说的话..."
                        @keydown.enter.prevent="submitCustomInput"
                        :disabled="isResponding || isLoadingGreeting"
                    />
                    <button
                        type="button"
                        class="rounded-xl bg-white px-4 py-2 text-sm font-semibold text-black shadow-md transition hover:scale-[1.02] active:scale-95 disabled:opacity-50 disabled:hover:scale-100"
                        @click="submitCustomInput"
                        :disabled="isResponding || isLoadingGreeting || !customInput.trim()"
                    >
                        发送
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
