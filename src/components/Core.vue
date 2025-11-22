<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, reactive, ref } from 'vue'
import IconChatProcessingOutline from '~icons/mdi/chat-processing-outline'
import IconCog from '~icons/mdi/cog'
import { Agent } from '@/lib/agent'
import { loadStoredOpenRouterConfig, saveStoredOpenRouterConfig } from '@/lib/openrouter-config'
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
const settingsSaved = ref(false)
const isResponding = ref(false)
const chatError = ref('')
let agentInstance: Agent | null = null
const DEFAULT_OPENROUTER_CONFIG = {
    apiKey: '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',
    model: 'x-ai/grok-4.1-fast:free',
}

const settingsForm = reactive({
    apiKey: DEFAULT_OPENROUTER_CONFIG.apiKey,
    model: DEFAULT_OPENROUTER_CONFIG.model,
})
const messages = ref<ChatMessage[]>([])
const initialGreeting: ChatMessage = {
    id: -1,
    sender: 'ally',
    text: '你来啦，伙伴～',
}
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

const toggleChat = () => {
    isChatOpen.value = !isChatOpen.value
    if (isChatOpen.value) {
        scrollMessagesToBottom()
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

const ensureAgent = (): Agent => {
    const stored = loadStoredOpenRouterConfig() ?? DEFAULT_OPENROUTER_CONFIG
    if (!stored?.apiKey) {
        chatError.value = '请先在设置里配置 OpenRouter API Key。'
        openSettings()
        throw new Error('Missing OpenRouter API key.')
    }
    suggestions.value = []
    if (!agentInstance) {
        agentInstance = new Agent({
            systemPrompt: PROMPT,
            model: stored.model ?? DEFAULT_OPENROUTER_CONFIG.model,
        })
        agentInstance.addMemory({ role: 'assistant', content: initialGreeting.text, timestamp: Date.now() })
        if (!messages.value.length) {
            messages.value.push(initialGreeting)
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

const updateSuggestions = async () => {
    isGeneratingSuggestions.value = true
    try {
        const stored = loadStoredOpenRouterConfig() ?? DEFAULT_OPENROUTER_CONFIG
        if (!stored?.apiKey) {
            suggestions.value = []
            return
        }

        const agent = ensureAgent()

        const historyForSuggestion = messages.value.map(msg => ({
            role: msg.sender === 'self' ? 'user' : 'assistant',
            content: msg.text,
        }))

        const nextSuggestions = await generateChatSuggestions(historyForSuggestion, {
            client: agent.getClient(),
            model: stored.model ?? DEFAULT_OPENROUTER_CONFIG.model,
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

onMounted(() => {
    const stored = loadStoredOpenRouterConfig()
    if (stored) {
        settingsForm.apiKey = stored.apiKey ?? DEFAULT_OPENROUTER_CONFIG.apiKey
        settingsForm.model = stored.model ?? DEFAULT_OPENROUTER_CONFIG.model
    } else {
        settingsForm.apiKey = DEFAULT_OPENROUTER_CONFIG.apiKey
        settingsForm.model = DEFAULT_OPENROUTER_CONFIG.model
    }

    void updateSuggestions()
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
                            <span v-if="isResponding" class="animate-pulse text-white/50">Thinking...</span>
                            <span v-else>{{ messages.length > 0 ? messages[messages.length - 1].text : '...' }}</span>
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
                :disabled="isResponding"
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
                        :disabled="isResponding"
                    />
                    <button
                        type="button"
                        class="rounded-xl bg-white px-4 py-2 text-sm font-semibold text-black shadow-md transition hover:scale-[1.02] active:scale-95 disabled:opacity-50 disabled:hover:scale-100"
                        @click="submitCustomInput"
                        :disabled="isResponding || !customInput.trim()"
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

                    <form class="space-y-6" @submit.prevent="handleSettingsSubmit">
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

                        <div class="flex items-center justify-between pt-4">
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
