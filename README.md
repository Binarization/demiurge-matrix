# demiurge-matrix

我的明天叫做昨天

首次启动请在设置中填写自己的 OpenRouter API Key。项目不提供共享 Key；旧版本自动保存的共享凭据会在读取配置时清除。

开发：`npm ci`、`npm run voice:build`、`npm run dev`。构建：`npm run build`。首次编译语音前处理需要 Rust、`wasm32-unknown-unknown` target 和 wasm-pack。

回归测试：安装 Bun 后运行 `bun test`。测试使用模拟模型与记忆存储，不会访问外部模型或使用真实 API Key。

完整对话保存于当前浏览器的本地存储，独立于模型的20轮上下文窗口。刷新、修改模型会恢复近期对话；更早原话通过 `recall_conversation` 检索。共同经历面板可导出记录。失败和打断会保留状态，不冒充已完成的回复。存储失败时会提示导出备份；目前不支持跨设备同步。

角色提示词位于 `src/lib/persona/cyrene.ts`，对话和问候共用。资料来源、3.7知识边界、同人场景与原创行为规则见 [角色设计文档](docs/cyrene-persona.md)。未使用真实模型自动评分，人格表现仍需配置自己的 Key 后体验校准。

仅支持本地昔涟模型朗读，默认关闭。模型加载并预热成功前不能开启；失败时保留文字，不会回退到系统语音。输入时停止朗读，生成过程中可点击“打断”或发送新消息。倾听表示输入框交互状态，未接入麦克风。嘴部开合使用真实 PCM 能量，尚非精确音素同步。

如果曾部署包含共享 Key 的旧版本，请在 OpenRouter 控制台撤销旧 Key，并重新构建部署；移除源码中的凭据不会使 Git 历史或旧构建中的 Key 自动失效。


设置中的「声音来源」现支持昔涟本地 WebGPU / WASM。先点击「加载角色声音」，再点击「试听昔涟声音」；加载与预热成功后才可开启朗读。LLM 的最终回复会流式显示，并按短语增量合成。模型在浏览器 Worker 内执行，不会把语音文本发送给 TTS 服务。WebGPU 模式允许必要算子回退 WASM；不支持时会显示错误，可手动切换后端，不会静默上传。

准备自己的本地模型（路径按实际目录填写）：

```sh
npm run voice:prepare -- /path/to/cyrene_chinese /path/to/bert/chinese-roberta-wwm-ext-large-onnx
npm run voice:check
npm run build
```

模型复制到被 Git 忽略的 `public/voice/`，构建时会进入 `dist/voice/`；首次加载约 759 MiB，使用按内容哈希命名的 Cache Storage 缓存。配额不足仍可当次使用。角色模型仅有 Neutral，嘴部开合跟随真实音频能量，尚非音素级口型。系统/设备自带语音已移除，旧 device 设置会迁移为关闭状态。

浏览器回归：启动 `npm run preview -- --port 5175`，另一个终端运行 `npm run voice:test-browser`（需要本机 Chrome 与可用 WebGPU）。前处理回归：`cargo test --manifest-path voice-frontend/Cargo.toml`。来源与迁移细节见 [声音实现文档](docs/cyrene-webgpu-voice.md)。


低延迟链路：必要工具操作 → 最终回答 SSE → 短语缓冲 → 本地合成/播放。首块优先短停顿，未出现标点时约 450 ms 后尝试在中文/空白边界提交；数字和未完成的英文单词不会被计时器从中切断。声音会在完整回答结束前开始，结束时只播放剩余文本，不重读全文。保留最多一块音频预生成；打断会清空缓冲并忽略旧结果，保留已预热的模型会话。

工具阶段与最终回答分开，避免朗读工具参数或工具结果尚未到达时的临时说明。这会增加一次选择工具的请求，首声指标包含这一阶段、检索与最终回答首短语的等待。增量流程回归：`npm run voice:test-streaming`（本地预览 5175；模拟 LLM SSE，使用真实 ONNX 和音频，不访问真实 LLM）。
