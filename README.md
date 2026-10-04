# demiurge-matrix

我的明天叫做昨天

首次启动请在设置中填写自己的 OpenRouter API Key。项目不提供共享 Key；旧版本自动保存的共享凭据会在读取配置时清除。

开发：`npm ci`、`npm run dev`。构建：`npm run build`。仓库包含可直接使用的语音前处理 WASM；只有修改 Rust 前处理源码后才需要安装 Rust、`wasm32-unknown-unknown` target 和 wasm-pack，并运行 `npm run voice:build`，提交更新后的 `src/lib/voice/runtime/`。

回归测试：安装 Bun 后运行 `bun test`。测试使用模拟模型与记忆存储，不会访问外部模型或使用真实 API Key。

完整对话保存于当前浏览器的本地存储，独立于模型的20轮上下文窗口。刷新、修改模型会恢复近期对话；更早原话通过 `recall_conversation` 检索。共同经历面板可导出记录。失败和打断会保留状态，不冒充已完成的回复。存储失败时会提示导出备份；目前不支持跨设备同步。

角色提示词位于 `src/lib/persona/cyrene.ts`，对话和问候共用。资料来源、3.7知识边界、同人场景与原创行为规则见 [角色设计文档](docs/cyrene-persona.md)。未使用真实模型自动评分，人格表现仍需配置自己的 Key 后体验校准。

仅支持本地昔涟模型朗读，默认关闭。模型加载并预热成功前不能开启；失败时保留文字，不会回退到系统语音。输入时停止朗读，生成过程中可点击“打断”或发送新消息。支持普通话麦克风输入，识别文字由用户确认发送；浏览器识别可能联网，首次开启前会说明。嘴形按真实 PCM 的能量与低/中/高频段占比估计 aa、ih、ou、ee、oh 五个口型，尚非音素级同步。

如果曾部署包含共享 Key 的旧版本，请在 OpenRouter 控制台撤销旧 Key，并重新构建部署；移除源码中的凭据不会使 Git 历史或旧构建中的 Key 自动失效。


设置中的「声音来源」现支持昔涟本地 WebGPU / WASM。先点击「加载角色声音」，再点击「试听昔涟声音」；加载与预热成功后才可开启朗读。LLM 的最终回复会流式显示，并按短语增量合成。模型在浏览器 Worker 内执行，不会把语音文本发送给 TTS 服务。WebGPU 模式允许必要算子回退 WASM；不支持时会显示错误，可手动切换后端，不会静默上传。

准备自己的本地模型（路径按实际目录填写）：

```sh
npm run voice:prepare -- /path/to/cyrene_chinese /path/to/bert/chinese-roberta-wwm-ext-large-onnx
npm run voice:check
npm run build
```

本地模型复制到被 Git 忽略的 `public/voice/`，开发模式使用这些文件。生产构建默认使用 `src/lib/voice/hosting.json` 中的已部署下载接口，Pages 无需包含模型；首次加载约 759 MiB，使用按内容哈希命名的 Cache Storage 缓存。配额不足仍可当次使用。角色模型仅有 Neutral，口型按真实音频的频段能量估计，尚非音素级同步。系统/设备自带语音已移除，旧 device 设置会迁移为关闭状态。

浏览器回归：启动 `npm run preview -- --port 5175`，另一个终端运行 `npm run voice:test-browser`（需要本机 Chrome 与可用 WebGPU）。前处理回归：`cargo test --manifest-path voice-frontend/Cargo.toml`。来源与迁移细节见 [声音实现文档](docs/cyrene-webgpu-voice.md)。


低延迟链路：必要工具操作 → 最终回答 SSE → 短语缓冲 → 本地合成/播放。首块优先短停顿，未出现标点时约 450 ms 后尝试在中文/空白边界提交；数字和未完成的英文单词不会被计时器从中切断。声音会在完整回答结束前开始，结束时只播放剩余文本，不重读全文。开启朗读时，底部字幕按真实播放进度逐短语显示，不先于声音；较早的行在顶部淡出而不是被截断。打断或关闭朗读时字幕显示完整文字。伙伴自己的上一句也留在字幕上方，她答完后变淡。保留最多一块音频预生成；打断会清空缓冲并忽略旧结果，保留已预热的模型会话。

工具阶段与最终回答分开，避免朗读工具参数或工具结果尚未到达时的临时说明。这会增加一次选择工具的请求，首声指标包含这一阶段、检索与最终回答首短语的等待。为缩短首声：设置中的「快速模型」可承担工具规划、记忆重排、反思与摘要（留空则用主模型）；8 字以内且不含提问、名字、时间等回忆线索的闲聊（如“晚安”“谢谢你呀”）在上一轮未用工具时跳过规划直接作答；记忆重排与规划并行，只有最终回答等待重排结果。增量流程回归：`npm run voice:test-streaming`（本地预览 5175；模拟 LLM SSE，使用真实 ONNX 和音频，不访问真实 LLM）。


### Cloudflare Pages

- 构建命令：`npm run build`；输出目录：`dist`；根目录为仓库根目录。
- Node 版本由 `.node-version` 固定；不需要在 Pages 安装 Rust 或 wasm-pack。
- `prebuild` 从固定版本的 ONNX Runtime 依赖生成 gzip 资源，浏览器 Worker 解压后交给 ONNX Runtime，避免原始 WASM 超过 Pages 的 25 MiB 单文件上限。推理仍在客户端执行。
- Pages 环境下构建结束会检查输出文件大小；本地可运行 `node scripts/check-pages-assets.mjs --always`。
- 声音模型已放在专用私有 R2 桶，生产默认地址为 https://demiurge-cyrene-voice.combo.workers.dev/voice/ ，无需 Pages 账户额外设置。需要换资源服务时，可设置构建变量 `VITE_VOICE_BASE_URL`（保留末尾斜杠）；服务须允许网页跨域 GET。
- 模型加载失败时，页面与文字对话可用，角色朗读保持不可开启，不会回退到浏览器合成。

平台限制：[Cloudflare Pages Limits](https://developers.cloudflare.com/pages/platform/limits/)。


### 声音资源托管维护

`deploy/voice/` 是独立的只读下载 Worker。R2 桶保持私有，接口只公开 `manifest.json` 与发布清单列出的五个资源，不支持列举、写入或下载桶内其他对象。大型文件分成 64 MiB 的私有上传对象，Worker 流式拼回原文件；客户端仍验证原始文件 SHA-256。

更新声音模型时：

1. 先运行 `voice:prepare` 准备模型，再运行 `node scripts/prepare-voice-upload.mjs`。该步骤校验原文件哈希并更新 Worker 的清单，分片默认写入 `/tmp/cyrene-voice-upload`。
2. 已授权 Cloudflare 账户中运行 `node scripts/upload-voice-r2.mjs`，等待所有对象上传成功。
3. 运行 `npx wrangler types deploy/voice/worker-configuration.d.ts --config deploy/voice/wrangler.jsonc` 和 `npx wrangler deploy --config deploy/voice/wrangler.jsonc`。
4. 校验下载文件哈希后提交清单。桶名和账户配置在 `deploy/voice/wrangler.jsonc`，凭据仅由 Wrangler 本机登录管理。

本地语音浏览器回归可使用 `VITE_VOICE_BASE_URL=/voice/ npm run build` 后启动预览，避免重复下载线上模型；默认生产构建的浏览器回归会验证线上模型。
