# 昔涟声音：浏览器端推理迁移评估

检查日期：2026-09-27。依据本机 `../sbv2-onnx-server` 源码，以及用户提供的 `cyrene_chinese` 模型和相邻 `bert` 目录。最初进行了代码与 ONNX 图静态审计，随后实现并验证了浏览器本地推理。以下先记录当前实现，再保留模型分析与后续优化要求。

## 当前实现与实测

后续增量改造：LLM 最终回答使用 SSE，`chat-stream.ts` 消费 SDK 的 `data.choices[].delta`；工具选择/执行阶段不进入朗读，随后发起无工具的最终回答流。`PhraseStream` 跨 token 过滤表情标签、在短语边界及 450 ms 超时后的安全边界提交音频任务。控制器保留一块预生成，文本完成时只 flush 尾部；打断保留部分对话并阻止旧音频继续播放。每次模型初始化用“你好，伙伴。”完整跑一遍作为能力检查与预热，成功后才启用开关。


已接入 `src/lib/voice/`：独立 Worker、Rust WASM 前处理、tokenizer、BERT、音素展开、声学模型、PCM 播放队列、能量口型和取消。设备自带语音已移除；只有本地模型加载、预热成功才可开启朗读。模型使用原始精度，没有裁图、量化或移除 BERT。当前不提供 assist_text 控件，采用无辅助文本的原服务端路径。

`onnxruntime-web` 固定为 1.24.3。该版本的 `webgpu` 导出使用 **asyncify** 配套模块，显式引用同版本 `ort-wasm-simd-threaded.asyncify.mjs/.wasm`；不可套用旧文档中的 jsep 文件，否则可能移除 WebGPU provider 并退为 CPU。实现检查 WebGPU device 是否初始化，且界面明确显示 WebGPU/WASM 混合模式，不声称全图 GPU。

Chrome 本机测试（2026-09-27，独立自动化实例，非跨设备性能保证）：

| 输入 | 推理耗时，不含模型加载 | 音频长度 |
| --- | ---: | ---: |
| 你好，伙伴。很高兴再次见到你。（一次初始测试） | 4.52 s | 3.75 s |
| 同句（后续测试新会话，GPU/浏览器缓存状态不同） | 1.35 s | 3.70 s |
| 同句（紧接着复用会话） | 0.33 s | 3.68 s |
| 今天花了3.14元，Hello，伙伴。 | 1.03 s | 3.85 s |
| 嗯。 | 0.32 s | 1.09 s |

随机噪声会使时长略有变化。上述值不是冷启动总耗时，也未做与原生服务器的盲听等价评估。页面实际试听、播放中打断和刷新恢复 WebGPU 选项已验证。BERT 大文件在自动化浏览器中出现缓存配额不足，验证了当次继续推理的路径；不能保证所有设备离线缓存成功。WASM 路径也曾成功输出波形，速度明显较慢。

准备和复验命令见 README。模型与生成 WASM 文件被 Git 忽略；新 checkout 需先 `npm run voice:build`，模型需另行 `voice:prepare`。Rust NLP 来源、文件哈希和许可证见 `voice-frontend/UPSTREAM.json` 与 `voice-frontend/LICENSE`。模型不会自动下载第三方地址。

## 结论

已将整条语音合成链搬到客户端：中文前处理用 WASM/JavaScript，两个神经网络用 ONNX Runtime Web 的 WebGPU 执行后端，必要节点回退 WASM。现有模型不能保证直接实现全 GPU 执行或实时合成。已跑通完整句子与角色交互；不同浏览器和设备仍需按以下条件验证。

## 实际资产

| 资产 | 检查结果 |
| --- | --- |
| `cyrene_chinese_e100_s1800.onnx` | 187.63 MiB，opset 18，主要权重 FLOAT32 |
| `bert/chinese-roberta-wwm-ext-large-onnx/model_fp16.onnx` | 571.28 MiB，opset 17，主要权重 FLOAT16，输出 FLOAT32 |
| `style_vectors.npy` | FLOAT32，形状 `[1,256]`，只有 Neutral |
| `config.json` | 44,100 Hz，单说话人，`add_blank=true`，非 JP-extra |

两份模型合计约 758.91 MiB，尚未计词典、tokenizer 和运行时。运行内存还包含 CPU/GPU 副本、中间张量和当前项目的 3D 渲染资源，不能把文件体积当成内存预算。

声学模型接收 13 个输入：phones、length、speaker、tones、language（INT64），ZH/JA/EN BERT（FLOAT32，`[1,1024,N]`），style（`[1,256]`），以及 length_scale、sdp_ratio、noise_scale、noise_scale_w 四个 FLOAT32 标量。存在 7 个图输出，播放只需要名为 `output` 的波形；另 6 个是中间结果，可在模型副本中尝试裁掉输出并清理无用分支，再做等价性验证。

只有一个风格时，服务端 `mean + (target - mean) * weight` 中 target 与 mean 相同，改变 style_weight 不会改变风格向量。表情标签不等于声音情绪。语速、停顿与 assist_text 可以作为待试听的表达控制，不能冒充已具备多情绪模型。

## 计算分工

| 阶段 | 建议位置 | 保真要求 |
| --- | --- | --- |
| 数字/符号规范化、分词、拼音、多音字、变调、混合英文 G2P | Worker 内 WASM | 优先抽取现有 Rust NLP 代码，复用词典和映射 |
| tokenizer、special tokens、offsets、word2ph | Worker 内 JS/WASM | 与 Rust 逐项对照，不能只做到 token IDs 相似 |
| 中文 BERT | ONNX Runtime Web / WebGPU | 检查 FP16 能力、模型会话创建和真实输入运行 |
| word2ph 展开、assist_text 均值插值、补空白、JA/EN 零张量 | 先用 JS/WASM | 保持原始顺序与 `[1,1024,N]` 布局；剖析后再考虑 GPU |
| SBV2 波形生成 | WebGPU + 必要 WASM 回退 | 核查节点分配和传输次数，不能仅检查 `navigator.gpu` |
| 峰值归一化、播放队列、音量分析 | JS / Web Audio | 保留原处理语义，直接播放 FLOAT32 PCM，无需先编码 MP3/WAV |

现有 Rust crate 包含 native `ort`、Axum/Tokio、文件下载和可选 LAME，不适合整个直接编译为浏览器 WASM。应独立抽出前处理 crate；现有 `tokenizers` 的 `onig` 特性也需单独检查 WASM 兼容性。现已使用 tokenizers 的 `unstable_wasm` 特性完成交叉编译，并验证实际 tokenizer 与音素长度对齐。

## 算子风险

角色模型含 274 个 Conv、5 个一维 ConvTranspose、96 个 MatMul。官方主分支 WebGPU 表已列出这些算子，但实际支持仍取决于发布版本、输入类型、维度和参数。

以下在此次检查的官方主分支支持表中未列出：

| 算子 | 模型内节点数 |
| --- | ---: |
| RandomNormalLike | 2 |
| NonZero | 12 |
| ConstantOfShape | 26 |
| Softplus | 3 |
| And | 3 |

未列出并不等于整个模型无法运行：可能通过优化消除或落在 WASM，但也可能造成初始化/运行失败及频繁 GPU/CPU 同步。需固定 `onnxruntime-web` 版本进行实际 profiling。BERT 的原始算子类型均出现在该表内，但这也不保证该 FP16 图直接运行成功。

模型含动态长度和数据相关形状。当前不应启用 graph capture；官方要求静态形状且所有计算 kernel 在 WebGPU 上执行。后续若拆图，可考虑把随机噪声作为显式输入、重写不兼容子图；须保留随机分布和数值稳定性，不能简单删除随机节点或把 BERT 置零。

## 实现依据与后续验收

1. 固定运行时版本与配套 WASM 文件。使用本地静态资源或用户选择文件加载模型，首次加载展示体积和进度；缓存按模型哈希分版本，缓存失败仍允许当次运行。
2. 用现有 Rust 流程导出黄金输入：规范化文本、phones/tones/language、word2ph、tokenizer IDs/offsets、BERT 特征。中文、日期金额、多音字、中英混合、标点和极短句都应覆盖。
3. 独立浏览器验证 BERT 和声学模型，记录冷启动、热启动、首句耗时、实时率（合成耗时/音频时长）、峰值内存、回退节点、3D 帧率和设备丢失情况。相同噪声下比较波形/特征；无法固定噪声时不要断言逐样本等价，还需试听。
4. 独立 Worker 串行生成语义完整的短句，边播放边准备下一句。当前服务端分句后收集全部结果，不等于模型已支持流式声码器。不要逐 token 合成；保留句间韵律，避免把小数点误当句末。
5. 已删除原生 SpeechController，通过真实 PCM 播放开始/结束驱动 speaking 状态；用音量包络控制基础开合嘴。音量只能代表开合，精确 aa/ih/ou 等口型另需音素时间对齐。
6. 复用现有打断机制：停止当前音源、清空待播队列、使旧任务结果失效。丢弃结果不等于已中止正在提交的 GPU 运算；必要时重建 Worker/会话，成本需实测。
7. 当前无 WebGPU 或 FP16 不可用时显示错误，可手动尝试 WASM；仍不可用则保持文字模式，不自动上传。服务端后端尚未接入；WASM 不能默认认为在手机上够快。

首版应保留模型精度与原始 NLP 规则，再尝试声学模型 FP16、BERT 量化、输出裁剪或子图拆分。不能直接更换较小 BERT，因为隐藏维度、特征分布和声学模型训练条件需匹配。

## 官方参考

- [ONNX Runtime WebGPU 使用与限制](https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html)
- [WebGPU 算子支持表（主分支，不是固定发布版承诺）](https://github.com/microsoft/onnxruntime/blob/main/js/web/docs/webgpu-operators.md)
- [部署运行时与模型缓存](https://onnxruntime.ai/docs/tutorials/web/deploy.html)

本次实现只修改当前项目。原始模型与相邻服务端仓库保持不变。
