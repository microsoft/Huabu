# 功能更新日志

每次重要功能变更都会记录在此文件中，按时间倒序排列。

---

## 2026-04-27 · Accent 节点跨 LOD 颜色统一

**What Changed**

- 设置了 `accent` 的节点，其 PreviewCard（完整视图）的标题与图标颜色不再使用饱和的 accent 原色，改为与 SemanticPlaceholder（minimal LOD 占位符）相同的混色公式，保证缩放切换 LOD 时颜色不再"跳变"。
- SemanticPlaceholder 的 accent 边框由 6px 调整为 4px，视觉更克制。

**Notes**

- 颜色派生集中到 `apps/web/src/components/Nodes/accentTokens.ts`，后续如需统一调整 accent 文本/背景/边框混合比例，只需修改这一处。
- 该变更只影响视觉，不改变交互或数据。

---

## 2026-04-27 · Text / Note 节点一键互转

**What Changed**

- 选中 `text` 或 `note` 节点时，浮动工具栏左侧的类型图标变为分段开关，单击即可在 Text / Note 之间切换。
- 粘贴纯文本时按长度自动选择容器：单行且长度 < 30 进入 `text` 节点，否则进入 `note` 节点；后续可随时通过开关切换。
- `note → text` 转换会把 Markdown 内容拍平为纯文本（剥离标题、强调、列表、链接、代码围栏等语法），并清理仅 note 渲染会用到的 BlockNote JSON 缓存与 block-level provenance。

**Notes**

- 转换不会触碰 `sourceId`：节点与知识库 source 的绑定保留下来，切回 `note` 后可继续 ingest，不会产生 KB 孤儿记录。
- 当节点正处于大视图编辑（BlockNote 打开）或正在执行 ingest 时，类型开关会被禁用，避免脏状态被回写覆盖转换结果。
- 所有转换都进入 undo 堆栈，误操作可撤销恢复 `contentJson` / provenance 等附属数据。

---

## 2026-04-09 · 修复 Chat 输入框长文本滚动

**What Changed**

- 修复 Chat Panel 输入区域在 prompt 过长时无法在输入框内滚动的问题。
- 输入框自动增高逻辑改为对 `line-height: normal` 提供稳定兜底，确保超过 5 行后正确启用内部纵向滚动。

**Notes**

- 该修复不改变原有交互：输入框仍会自动扩展到最多 5 行，然后进入滚动模式。

---

## 2026-04-03 · Semantic Zoom 与触控/边样式增强

**What Changed**

- **Semantic Zoom (LOD)**：当节点在屏幕上的宽度低于阈值（默认 120px）时，重型节点（note、pdf、web）自动切换为轻量占位符，仅显示节点类型图标 + 标签。缩放回来后自动恢复完整渲染。带有 hysteresis 缓冲防止频繁切换。
- **Edge Style Toolbar**：选中单条边时弹出浮动工具栏，可调整线型（bezier / straight / step）、线条样式（solid / dashed / dotted）、箭头方向（none / forward / backward / both）、线宽（1–4px）以及颜色。新增 `SET_EDGE_STYLE` canvas command，AI Agent 也可通过该命令设置边样式。
- **触控输入适配**：新增 `useInputMode` hook 实时检测输入类型（mouse / touch / pen）。Canvas 底部工具栏在触控模式下额外显示 Undo / Redo / Delete 按钮（触屏无键盘快捷键）。连接手柄在触控下变大且半透明可见，选中后激活；resize 手柄尺寸也做了触控友好调整。
- **Loose Connection Mode**：Canvas 启用 `ConnectionMode.Loose`，拖拽连线结束时即使未精确落在 handle 上，只要指针在目标节点范围内即自动建立连接，大幅改善触控设备上的连线体验。
- **Node Accent Color**：节点工具栏和多选工具栏新增 Accent Color 拾色器，可为节点添加彩色边框/阴影以进行视觉分组。Frame 节点的 accent 表现为角落色块投影。
- **FloatingToolbar 组件**：新增通用 `FloatingToolbar` compound 组件（Root / Divider / ToggleButton / ActionButton / Group / Select / ColorPicker），统一了节点、边、多选三处工具栏的样式与交互。
- **PDF / PreviewCard 加载态**：PDF 节点与 PreviewCard 新增骨架屏（`SkeletonLines`）加载动画和缩略图生成。
- **节点类型图标**：节点工具栏左侧新增当前节点类型的小图标（带 tooltip），帮助用户快速识别节点类型。
- **Color System 统一**：将颜色调色板（accent / edge stroke / node background）统一定义在 `@sediment/shared`，前端和 Agent 工具定义自动同步。节点背景色改为 hex 值和 CSS keyword，替换原有 Tailwind class 方案。

**Notes**

- Semantic Zoom 阈值和参与的节点类型可在 `config/semanticZoom.ts` 中配置；image / video / text / frame 默认始终 full 渲染。
- 占位符标签会对 camelCase 和数字边界插入零宽空格以改善换行效果，字体大小由 pretext 库二分搜索自动适配容器。
- 触控模式检测在 App 根组件一次性安装全局 `pointerdown` 监听器，混合设备（如 Surface）会即时切换。

---

## 2026-03-27 · Button 图标尺寸统一

**What Changed**

- `ghost` Button 现在也会应用和 `solid`、`outline` 一致的 `size` 样式，默认按钮的文字与内边距表现保持一致。
- Button 现在会为作为子节点传入的 `svg` 图标应用默认尺寸，图标可随按钮的 `size` 一起变化，无需在每个调用点单独写死尺寸。
- 现有页面中的 Button 用法已清理，优先依赖 Button 的默认图标尺寸规则。

**Notes**

- 默认图标尺寸按按钮规格统一：`sm` 为较小图标，`md` 与 `pill` 为常规图标，尽量贴近现有界面中的按钮比例。
- 该默认行为主要覆盖 SVG 图标组件；如果传入的是自定义复杂子组件，仍可在调用方自行控制尺寸。

## 2026-03-27 · 移除 Research Mode

**What Changed**

- 移除了 Chat Panel 中的 Deep Research 模式，现在仅保留 Ask 和 Operate 两种模式。
- 清理了相关死代码：`ResearchConfig`、`ResearchAgentEvent` 等类型定义，`RESEARCH_SYSTEM_PROMPT`，以及过时的测试用例和注释。

**Notes**

- 无迁移步骤，Research 模式已完全移除。

---

## 2026-03-25 · Canvas Changes Keep / Revert 按钮

**What Changed**

- Agent 模式执行完成后，Canvas changes 面板标题栏新增 **Keep all** 和 **Revert all** 按钮，可一键接受或撤销所有变更。
- 每一行变更右侧新增 ✓（Keep）和 ✗（Revert）按钮（hover 时显示），支持逐条接受或撤销单个操作。
- 可撤销的操作类型：创建节点（Created）、连接节点（Connected）。不可撤销的操作（如 Delete、Update、Auto layout）的 Revert 按钮为禁用状态。

**Notes**

- Revert 通过执行反向命令实现（创建 → 删除，连接 → 断开），而非全局 undo。
- Revert All 按逆序执行所有反向命令，确保先断开边再删除节点。

---

## 2026-03-27 · Button 默认字号统一

**What Changed**

- `ghost` Button 现在也会应用和 `solid`、`outline` 一致的 `size` 样式，默认 `md` 尺寸下的文字大小与内边距表现保持一致。
- Button 现在会为作为子节点传入的 `svg` 图标应用默认尺寸，图标可随按钮的 `size` 一起变化，无需在每个调用点单独写死尺寸。

**Notes**

- `shape="pill"` 仍然使用自身定义的尺寸样式，不受这次调整影响。
- 该默认行为主要覆盖 SVG 图标组件；如果传入的是自定义复杂子组件，仍可在调用方自行控制尺寸。

## 2026-03-27 · Button Showcase 页面

**What Changed**

- 新增一个独立的 Button Showcase 页面，可集中查看当前 Button 组件在 `variant`、`shape`、`tone`、`size` 维度下的全部组合样式。
- 页面同时展示了常见按钮组合和 disabled 状态，便于对照新的 Button API 做视觉验证。
- 新页面路由为 `/playground/buttons`。

**Notes**

- 该页面主要用于组件样式验证和开发联调，不影响现有画布或聊天流程。
- 页面依赖当前工作区正常初始化后访问。

## 2026-03-25 · arXiv PDF 链接导入支持

**What Changed**

- 粘贴 arXiv PDF 直链（如 `https://arxiv.org/pdf/2603.12644`）时，现在会自动识别为 PDF 节点，而不是网页节点。PDF 内容会直接在画布中渲染。
- 知识提取（预处理）也已更新，可下载并解析远程 PDF 链接的正文内容。

**Notes**

- 支持 `arxiv.org/pdf/` 前缀的链接（包含版本号，如 `.../pdf/2603.12644v1`）。
- 远程 PDF 的内容提取依赖网络可达性。

---

## 2026-03-25 · 上下文用量环精度提升

**What Changed**

- 聊天输入框旁的上下文用量环现在显示两段弧线：**红色**表示历史对话已占用的 token，**橙色**表示当前输入（草稿文本 + 选中节点 + 附件）的预估占用。鼠标悬浮可查看 History / Pending / Total 明细。

**Notes**

- 已占用 token 数从后端实时获取（包含 system prompt、所有消息文本及 tool call 等非文本内容），比之前仅统计前端可见消息更准确。
- 预估占用会模拟后端的包装格式（如 `[Extracted text from ...]`、`[Selected Nodes]` JSON），使估算更贴近实际。

## 2026-03-24 · AI 内容变更追踪

**变更内容**

- AI 修改笔记内容后，编辑器右侧会显示紫色色条标识 AI 编写的 block：实线表示纯 AI 内容，虚线表示用户已修改。
- 悬停色条区域可弹出逐词差异对比框（word-level diff），显示 AI 具体的增删改。
- 每个差异块支持单独 Accept / Reject，也可通过底部按钮一键 Accept All / Reject All。
- AI 删除的内容以红色标记显示在被删位置的下方，支持恢复。
- 用户编辑某个 block 后，该 block 的差异自动消除。

**Notes**

- 差异基线采用累积策略：AI 多次编辑不会覆盖基线，diff 始终显示从用户上次完整拥有的内容到当前内容的所有变更。
- AI 生成的节点顶部显示紫色边框和 "AI" 徽章，悬停可查看 provenance 统计。

---

## 2026-03-22 · 修复面板中 Ctrl+C 复制文本的问题

**What Changed**

- 在设置、数据源等面板中选中文本后按 `Ctrl/Cmd+C`，现在会正确复制选中的文本，而不再被画布节点复制逻辑拦截。

**Notes**

- 当没有选中任何文本时，`Ctrl/Cmd+C` 仍然正常执行画布节点的复制功能。

## 2026-03-22 · 多 LLM Provider 支持与 Settings UI 重构

**变更内容**

- **多 Provider 切换**：LLM 不再绑定 Azure OpenAI，支持在运行时切换 Provider 和 Model。目前支持 Anthropic、OpenAI、Azure OpenAI、Google Gemini、OpenRouter、Groq、xAI、Mistral、Amazon Bedrock、Google Vertex AI、GitHub Copilot。
- **Settings UI 重构**：Settings 面板新增 Provider / Model 选择器和 API Key 配置区域，切换后即时生效，配置持久化至 `apps/data/llm-config.json`。
- **GitHub Copilot OAuth 登录**：GitHub Copilot 作为 Provider 时，支持通过 GitHub Device Flow 完成 OAuth 授权，无需手动填写 API Key。
- **HTTP 代理支持**：自动识别系统环境变量 `HTTPS_PROXY`，也可在 `.env` 中手动配置。配置后所有出站请求将通过代理转发，不配置则直连。
- **新增 LLM API 路由**：`/api/llm` 提供 Provider 列表、Model 列表、配置读写、OAuth 登录等接口。
- **前端状态管理**：新增 `llmStore` 管理 Provider/Model 选择状态和认证状态。

**注意事项**

- 需要安装新依赖 `undici`（代理支持）。
- 未配置任何 Provider 时，LLM 相关功能将无法使用，Settings 中会提示配置。

---

## 2026-03-19 · Canvas Command 重构

**变更内容**

- **Command 模式重构**：将画布操作从 `canvasHandlers.ts`（1200+ 行）拆分为独立的 Command 模块，每个操作（创建、删除、对齐、分布、连线等）对应一个独立文件。
- **Resolver 层**：新增 Resolver 层处理复杂的用户意图到 Command 的映射（如拖拽停止、粘贴剪贴板、添加节点等），包含碰撞检测、Frame 归组等逻辑。
- **Post Effects**：Command 执行后的副作用（边重路由、自动标签生成等）统一由 `postEffects` 处理。
- **Node 工具函数整理**：`nodeDefaultSize`、`nodeInputBuilders` 等工具函数独立提取，`alignment` 和 `frame` 工具从 `utils/canvas` 迁移至 `canvas/utils`。

**注意事项**

- `canvasHandlers.ts` 已移除，相关逻辑分散到 `apps/web/src/canvas/commands/` 和 `apps/web/src/canvas/resolvers/` 目录。
- Canvas store 大幅简化，核心状态管理职责不变。

## 2026-03-20 · 修复聊天历史加载 404

**What Changed**

- 修复了打开 Chat Panel 时偶尔出现 `GET /api/agent/history/:threadId 404` 控制台报错的问题。

**Notes**

- 原因是 Chat Panel 挂载时 canvas 尚未加载完成，导致请求缺少 `canvasId` 参数。现在等 `canvasId` 就绪后才发起历史加载请求。

---

## 2026-03-20 · 节点预处理流水线统一

**What Changed**

- 所有 canvas 节点类型（note、text、web、pdf、image、frame、video）现在通过同一条 6 阶段预处理流水线处理，替代了之前分离的知识入库和 LLM 标签生成两套流程。
- Image 和 frame 节点的自动标签生成现在与 note/text/web/pdf 的内容入库共享相同的前端触发机制和服务端调度器。
- Agent 工具 `ingest_content` 现在支持所有节点类型（包括之前不支持的 PDF）。

**Notes**

- 用户感知上行为不变：note/text 编辑仍会自动同步到知识库，image/frame 仍会自动生成语义标签。
- 内部触发函数从 `ingestNodeIfNeeded` + `resolveLabelIfNeeded` 合并为 `preprocessNodeIfNeeded`。
- 详细设计文档见 `docs/node_preprocessing_design.md`，重构记录见 `docs/refactor_node-preprocessing-workflow.md`。

---

## 2026-03-19 · 快捷键帮助弹窗

**What Changed**

- 新增 `?` 全局快捷键，可在画布页面打开一个 Keyboard shortcuts modal，集中查看当前支持的编辑、布局、分层、AI 与帮助类快捷键。
- 打开该弹窗时，会临时停用画布级快捷键监听，避免在查看帮助时误触删除、分层、粘贴等操作。
- 用户文档中的快捷键参考页同步补充了帮助类快捷键说明。

**Notes**

- `?` 仅在焦点不位于输入框、文本域或富文本编辑区域时触发，避免干扰正常输入。
- 弹窗可通过 `Esc` 关闭。

---

## 2026-03-19 · Chat Panel 增强：中断生成、来源提示、上下文用量

**变更内容**

- **中断生成**：Ask / Research / Agent 模式在发送消息后，发送按钮变为停止按钮（■ 图标），点击即可中断正在进行的流式生成。底层通过 AbortController 取消 SSE 连接。
- **服务端中止**：客户端中断时，服务端通过监听 `reply.raw` / `socket` close 事件同步停止 LLM 推理和工具执行。中断后清理孤立的 toolCall（保留已完成的对话和工具结果），并向 context 追加 `[SYSTEM] interrupted` 通知，防止后续请求重复执行被取消的任务。
- **Research 完成后平滑刷新**：Research 模式完成后改用 `refreshCanvas()` 替代 `loadCanvas()`，避免全量重载导致画布闪烁/重渲染。
- **来源名称悬浮提示**：输入框旁的 "N sources" 指示器悬浮后，显示当前选中的各个节点名称列表。
- **上下文用量环形指示**：在来源指示器与发送按钮之间新增一个环形进度图标，实时显示当前会话已使用的 context window 百分比。鼠标悬浮显示精确的 token 用量（如 `12.3k / 128k tokens`），使用 gpt-tokenizer（o200k_base）精确计算。
- **服务端调试日志**：Agent 路由新增结构化日志，记录客户端断连检测、abort 上下文清理前后消息数、以及每次 context 保存时的最后 3 条消息摘要（含 role / stopReason / contentTypes），便于排查对话状态问题。

**注意事项**

- 新增依赖 `gpt-tokenizer`（web 端 token 计数）。
- 中断后，已接收的部分回复和已执行完的工具操作保留在对话中（不回滚），但未完成的 toolCall 会从 assistant 消息中移除。
- 上下文用量仅统计前端消息历史，不包含系统提示词和工具定义的 token 开销。

**可能存在的问题**

- 中断后如果立刻继续发送下一条消息，极少数情况下可能出现对话上下文保存被后一次请求覆盖。
- 如果某个工具已经开始执行，点击中断后它可能会先执行完，再停止后续生成。

---

## 2026-03-17 · Chat Panel 体验优化：去重、节点引用可点击、移除 Keep/Revert

**变更内容**

- **修复工具条目重复**：Agent 模式并行调用工具时，Chat Panel 里同一工具操作不再重复显示（之前 executing 和 completed 状态各显示一条）。改用队列追踪代替单变量，并将工具参数与结果合并保留完整信息。
- **移除 Keep / Revert 按钮**：Agent 模式的 Canvas changes 摘要不再显示 Keep / Revert 操作按钮，变更即时生效。
- **Connect 操作显示节点名称**：连线操作现在显示 `Connect [源节点] → [目标节点]` 而非笼统的 "Connect nodes"。Canvas changes 摘要同步更新。
- **节点引用可点击聚焦**：工具操作（Read node、Create、Update、Connect）和 Canvas changes 中的节点名称以 `[label]` 形式显示，点击后在画布中选中并定位到该节点。

**注意事项**

- Canvas 快照 / 恢复机制已移除（无 Revert 需求）。
- 新增 `NodeRef` 组件（`components/Messages/NodeRef.tsx`）供工具卡片和变更摘要复用。

---

## 2026-03-17 · 统一 AgentMode 类型：`'agent'` → `'operate'`

**变更内容**

- **图片节点**：新增 LLM Vision 自动标签。
- **Frame 节点**：新增 LLM 子节点归纳标签。
- 标签在节点创建、子节点变化后自动异步生成，用户手动设置的标签不会被覆盖。

**注意事项**

- 需要已配置 Azure OpenAI（支持 Vision 的部署），否则 Image/Frame 使用原有的顺序编号（Image 1、Frame 1）兜底。
- 标签生成为异步操作，创建节点后会有短暂延迟（约 2 秒 debounce + LLM 调用时间）。
- 已存在的旧节点不会自动获得新标签，需手动触发（如将子节点移入/移出 Frame）。

---

## 2026-03-13 · PDF 解析升级为结构化 Markdown

**变更内容**

- PDF 文档解析从纯文本提取（pdf-parse）切换为结构化 Markdown 输出（@opendocsg/pdf2md），知识库中的 PDF 内容将保留标题、段落等文档结构。

**注意事项**

- 已导入的 PDF 文档不会自动更新，需重新导入以获得结构化格式。
- 解析结果从纯文本变为 Markdown 格式，对复杂排版（多栏、表格）的支持仍有限。

---

## 2026-03-13 · 边连接自动选择最优 Handle

- 节点连线根据相对位置自动选择最近的 handle（上/下/左/右）连接，避免线路交叉混乱。
- 拖动节点、自动布局、对齐/分散、移入移出 Frame 等操作后，所有边自动重新路由。

**注意事项**

- 升级后已保存的旧画布中的边不会立即更新，需要执行一次拖动或布局操作后才会重新路由。

---

## 2026-03-13 · 多画布管理、工作区选择器与画布优化

- **多画布与路由导航**：支持创建和管理多个画布，新增画布列表页（`/`），通过 `/canvas/:canvasId` 路由导航，切换时自动保存。
- **工作区文件夹选择器**：首次启动引导用户选择工作区文件夹，支持原生文件选择对话框，路径持久化到 `localStorage`，可在 Settings 中随时切换。
- **导入/导出移至列表页**：导入和导出功能从画布编辑器移至首页画布列表页。

---

## 2026-03-12 · 后端存储迁移至文件系统

**变更内容**

画布和知识库的持久化方式从 SQLite 数据库迁移至基于文件的存储。数据以 JSON / Markdown 格式直接保存在工作区目录中，便于浏览、备份和版本管理。

- **画布** → `<workspace>/canvas/<canvasId>.json`（原子写入）
- **知识来源** → `<workspace>/sources/<Title>.md`（Markdown + YAML frontmatter，可用任意编辑器查看）
- **附件** → `<workspace>/artifacts/artifact-<uuid>.<ext>`（原始二进制文件）

详细结构及配置方式见 [08 · 数据存储](./08-data-storage.md)。

**⚠️ 注意事项**

- **不会自动迁移**：升级后旧版 SQLite 中的画布和知识库数据不会自动转移到新存储。
- **推荐迁移步骤**：
  1. 在旧版本中使用导出功能将画布导出为 `.sediment.json` 文件
  2. 更新到新版本并重新启动服务
  3. 使用导入功能将导出文件导入新存储
- 导出/导入会完整保留节点、连线、知识来源和附件，可放心操作。
