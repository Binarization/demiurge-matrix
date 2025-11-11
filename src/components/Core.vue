<script setup lang="ts">
import { nextTick, ref } from 'vue';
import IconChatProcessingOutline from '~icons/mdi/chat-processing-outline';
import IconSend from '~icons/mdi/send';

type Sender = 'self' | 'ally';
type ChatMessage = {
  id: number;
  sender: Sender;
  text: string;
};

const isChatOpen = ref(false);
const pendingMessage = ref('');
const chatMessagesRef = ref<HTMLDivElement | null>(null);
const messages = ref<ChatMessage[]>([
  { id: 1, sender: 'ally', text: '中枢接口已接入，准备同步下一阶段。' },
  { id: 2, sender: 'self', text: '收到，正在等待更多参数。' },
]);

const scrollMessagesToBottom = () => {
  nextTick(() => {
    const container = chatMessagesRef.value;
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  });
};

const toggleChat = () => {
  isChatOpen.value = !isChatOpen.value;
  if (isChatOpen.value) {
    scrollMessagesToBottom();
  }
};

const handleSend = () => {
  const text = pendingMessage.value.trim();
  if (!text) {
    return;
  }
  messages.value.push({
    id: Date.now(),
    sender: 'self',
    text,
  });
  pendingMessage.value = '';
  scrollMessagesToBottom();
};

const handleKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    handleSend();
  }
};
</script>

<template>
  <section
    class="fixed inset-0 flex items-center justify-center bg-[radial-gradient(circle_at_top,#101018_0%,#050509_50%,#010103_100%)] px-4 text-center text-white"
    style="font-family: 'Space Grotesk', 'Inter', 'Segoe UI', sans-serif;"
  >
    <div
      class="min-w-[320px] rounded-[24px] border border-white/10 bg-[rgba(5,5,12,0.85)] p-8 backdrop-blur-[16px]"
    >
      <p class="mb-1 text-[0.9rem] uppercase tracking-[0.4em] text-white/60">你好，世界</p>
      <p class="mb-2 text-[2rem] font-light text-white/90">核心通道</p>
      <p class="text-[1.1rem] text-white/75">在这里继续构建你的故事。</p>
    </div>
  </section>
  <button
    class="fixed bottom-6 right-6 flex h-14 w-14 items-center justify-center rounded-full bg-white/90 text-black shadow-lg shadow-cyan-500/30 transition hover:bg-white"
    type="button"
    aria-label="Toggle chat"
    @click="toggleChat"
  >
    <IconChatProcessingOutline v-if="!isChatOpen" class="h-6 w-6" />
    <span v-else class="text-2xl leading-none">×</span>
  </button>
  <div
    class="fixed right-6 z-20 w-[320px] max-w-[90vw] rounded-3xl border border-white/10 bg-[rgba(5,5,12,0.92)] p-4 text-left text-white shadow-2xl shadow-cyan-500/40 backdrop-blur-[18px] transition-all duration-300"
    :class="[
      isChatOpen ? 'opacity-100 pointer-events-auto translate-y-0 bottom-28' : 'pointer-events-none opacity-0 translate-y-4 bottom-16',
    ]"
  >
    <header class="mb-3 flex items-center justify-between">
      <p class="text-xs uppercase tracking-[0.4em] text-white/60">实时通联</p>
      <span class="text-xs text-white/50">{{ messages.length }} 条</span>
    </header>
    <div
      ref="chatMessagesRef"
      class="mb-3 max-h-64 overflow-y-auto pr-1"
    >
      <div
        v-for="message in messages"
        :key="message.id"
        class="mb-2 flex"
        :class="message.sender === 'self' ? 'justify-end' : 'justify-start'"
      >
        <div
          class="max-w-[80%] rounded-2xl px-3 py-2 text-sm leading-relaxed"
          :class="message.sender === 'self' ? 'bg-cyan-500/30 text-white/95 border border-cyan-300/40' : 'bg-white/5 border border-white/10 text-white/80'"
        >
          {{ message.text }}
        </div>
      </div>
    </div>
    <form
      class="flex items-end gap-2"
      @submit.prevent="handleSend"
    >
      <textarea
        v-model="pendingMessage"
        rows="1"
        placeholder="输入消息..."
        class="w-full resize-none rounded-2xl border border-white/15 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/40 focus:border-cyan-300/60 focus:outline-none"
        @keydown="handleKeydown"
      ></textarea>
      <button
        class="flex h-10 w-10 items-center justify-center rounded-2xl bg-white/90 text-black transition hover:bg-white disabled:cursor-not-allowed disabled:bg-white/40"
        type="submit"
        :disabled="!pendingMessage.trim()"
        aria-label="Send message"
      >
        <IconSend class="h-5 w-5" />
      </button>
    </form>
  </div>
</template>
