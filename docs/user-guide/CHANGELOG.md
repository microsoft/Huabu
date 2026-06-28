# 功能更新日志

每次重要功能变更都会记录在此文件中，按时间倒序排列。

## 2026-06-26 · Note 作为拖拽落点：精确插入 + 末尾追加 + 跨 Note 原子移动

**What Changed**

Note 节点现在不仅是拖拽的**源**，也是拖拽的**落点**。这意味着 chat 消息可以直接拖进 Note、Note A 的某块可以一次性搬到 Note B：

1. **拖到画布上的 Note 瓦片** → 内容**追加到该 Note 末尾**（按 block 间隔分隔，自动处理换行）。瓦片在拖拽悬停时高亮一圈 `ring-info` 蓝色环作为反馈。
2. **拖到右侧展开编辑面板里的 Note** → 内容在**光标所在 block 之后精确插入**。Chat 消息 → 当前编辑 Note 是这条路径的典型用法。
3. **修饰键**沿用画布上的约定：默认 = Move（源 Note 删掉该块），`Ctrl/Cmd` = Copy（源保留）。
4. **跨 Note 移动是一次原子写入**（一条 undo 记录）。新增 `MOVE_NOTE_BLOCK_INTO_NOTE` intent + 同名 resolver，输出单条 `MERGE_NODE_DATA` 携带源 + 目标两个 patch。
5. **锁定的 Note 不接收拖入**，事件继续冒泡到画布，行为退化为"在该位置新建节点"。
6. **自我拖拽**（把自己的块拖回自己的瓦片或展开面板）→ 早返回，交给 Crepe 的 in-editor block 重排接管。

**Notes**

- 来源不可回写的拖拽（chat 消息、Web / Image / 外部文件 / URL）即使按 `Ctrl/Cmd` 也只能 Copy，行为与画布一致。
- 落点精确插入靠新增的 `MilkdownInstance.getBlockKeyAtPoint(x, y)`：用 ProseMirror 的 `view.posAtCoords` resolve 到顶层 block，反查 fingerprint key 后调 `insertBlocksAfter`。drop 落在编辑器 padding 上时回退为末尾追加。
- 单一 expanded view 的 UX 假设下，"两个 Note 都展开互拖"不会发生 —— 跨 Note move 的真实路径是「展开 A 中的某块 → 拖到画布上 B 的瓦片」，这条路径走原子 `moveNoteBlockIntoNote` action。
- 拖图片到 Note 时（chat 图片块 / 节点内 image 浮动把手），payload 里的 `src` 通常是 artifact key（`art_xxx.png`），note 渲染器不认这种协议。`dragPayloadToMarkdown` 接受可选的 `canvasId` 选项，落点端把它传进来后会先 `resolveArtifactUrl(src, canvasId)`，最终插入到 note 里的 markdown 是一个可访问的 `/api/canvas/<id>/artifact/<key>` URL。
- 新增 / 修改文件：[NoteNode.tsx](apps/web/src/components/Nodes/note/NoteNode.tsx)、[NotePreview.tsx](apps/web/src/components/Nodes/note/NotePreview.tsx)、[createMilkdown.ts](apps/web/src/components/Milkdown/createMilkdown.ts)、[resolveMoveNoteBlockIntoNote.ts](apps/web/src/handler/canvasCommand/resolvers/resolveMoveNoteBlockIntoNote.ts)、[uiIntent.ts](apps/web/src/handler/canvasCommand/uiIntent.ts)、[canvasStore.ts](apps/web/src/store/canvasStore.ts)、[payloadToMarkdown.ts](apps/web/src/utils/io/payloadToMarkdown.ts)。

## 2026-06-26 · 术语更名：Agent Sideband → Agent Reachback（HST → HRT）

**What Changed**

把「Sideband」这一术语整体更名为「Reachback」。原名借自网络/硬件领域的「边带（sideband）」，对没有网络背景的用户和开发者不够直观；新名「Reachback」直接表达语义——被 spawn 出来的外部 agent「反向触达（reach back）」启动它的宿主应用，在主 prompt→response 对话之外读写共享状态。

更名同时明确了两层结构：

1. **agentlet 层（与宿主无关）**：负责工具脚本的*传输与分发*，定义 **Reachback Interface**。
2. **宿主应用层（如 Huabu）**：*提供*实现该接口的具体工具脚本；Huabu 的实现即 **Huabu Reachback Tool（HRT）**。

**Notes**

- 这是一次彻底的清理式更名（前后端均在本仓库内，可同步改）：环境变量 `AGENTLET_SIDEBAND_DIR` → `AGENTLET_REACHBACK_DIR`、路由前缀 `/api/sideband` → `/api/reachback`、脚本 `huabu-sideband-tool.mjs` → `huabu-reachback-tool.mjs`、目录 `apps/server/src/sideband/` → `apps/server/src/reachback/`、文档 `docs/agent-sideband.md` → `docs/agent-reachback.md`。
- 缓存目录默认值从 `node_modules/.cache/agentlet/sideband` 改为 `.../reachback`。
- agent system prompt 中的 `## Canvas Tools (Sideband)` 段改名为 `## Canvas Tools (Reachback)`。
- 本文件中 2026-06-26 之前的历史条目保持原样（作为当时的记录），不做回溯改名。

## 2026-06-26 · 拖拽语义：Note 块 → 画布 默认改为「移动」

**What Changed**

把 Note 编辑器里的某个块拖到画布时，默认行为从「复制」改为「移动」，与 Windows 资源管理器 / macOS Finder 的文件拖拽语义保持一致：

1. **直接拖拽 = 移动**：源 Note 删除该块，画布上新建一个内容相同的 Note。
2. **`Ctrl/Cmd` + 拖拽 = 复制**：源 Note 保留原文，画布上新建一个 Note。
3. **光标反馈**：浏览器原生 `dropEffect` 会随修饰键切换，复制时显示 `+` 号，移动时是普通箭头，所见即所得。
4. **来源无法回写时强制复制**：从 AI 对话卡片 / Web / Image 卡片 / 外部文件 / URL 拖出来的内容没有源块概念，按不按 `Ctrl/Cmd` 都是复制。

**Notes**

- 之前是「默认复制，Shift 强制移动」。Shift 这个键在 DnD 里几乎从不代表 copy/move 切换（一般用于多选 / 区间），用 `Ctrl/Cmd` 更贴近用户预期，也把 Shift 释放出来留给将来扩展。
- 实现上新增了 `application/x-sediment-dnd-movable` 哨兵 MIME：浏览器在 `dragover` 阶段会屏蔽 `getData(...)` 的 JSON 读取，所以无法从 payload 判断源是否可移动；改用 MIME 类型列表（在 `dragover` 时可见）来透传"我支持移动"这个标志，决定光标该显示 `+` 还是普通箭头。
- 改动文件：[dragDrop.ts](apps/web/src/utils/io/dragDrop.ts)、[Canvas.tsx](apps/web/src/components/Panels/Canvas/Canvas.tsx)、[03-canvas-basics.md](docs/user-guide/03-canvas-basics.md)、[08-shortcuts.md](docs/user-guide/08-shortcuts.md)、[Shortcuts.tsx](apps/web/src/docs/sections/reference/Shortcuts.tsx)。

## 2026-06-24 · 外部 Agent：prompt 卡片不再被「连接 agent」阻塞，并展示完整 system 段

**What Changed**

外部（ACP）agent 的 prompt 卡片（PreparedPromptCard）做了三处体验修复：

1. **pending 文案改为「Connecting to _agent_…」**：之前卡片在等待期一直显示「Preparing prompt for _agent_…」。但 prompt 现在是确定性、瞬时构建的——这段 spinner 实际等待的是 ACP 会话连上外部 agent，而不是「准备 prompt」。文案改得名副其实（且不向用户暴露内部「session」概念）。
2. **连接失败不再无限转圈**：如果这一轮在 prompt 下发前就失败（最常见是 agent 没连上），卡片以前会永远停在 spinner。现在前端在收到 `error` 时会把仍处于 pending 的卡片落定为失败态（spinner 停止），具体原因照旧显示在下方的错误状态行里。
3. **卡片展开后能看到完整 prompt**：首轮会话会把一次性 system preamble（角色设定 + `## Canvas Tools (Sideband)` 工具说明）随首条用户消息搭车下发；现在这段 preamble 也会随 `ExternalAgentPrompt.systemPreamble` 带到前端，卡片展开后在 `Task` 之上多出一个 `System` 段，让用户看到 agent 实际收到的完整 prompt。后续轮次不含 preamble，卡片也就不显示 `System` 段。

**Notes**

- 后端下发顺序不变（连接 → 确定性构建 → `prepared_prompt`）；只是把「等待期」的语义讲清楚，并让构建结果带上 `systemPreamble`。
- `systemPreamble` 只在新建会话首轮存在（恢复会话的转录里已含 preamble，不再重发），所以历史回填时也只有首轮卡片显示 `System` 段。
- 改动文件：[agent.ts](packages/shared/src/types/agent/agent.ts)（`ExternalAgentPrompt.systemPreamble`）、[preprocessor.ts](apps/server/src/modules/agent/acp/preprocessor.ts)、[PreparedPromptMessage.tsx](apps/web/src/components/Messages/PreparedPromptMessage.tsx)、[useAgentStream.ts](apps/web/src/hooks/useAgentStream.ts)、[chatTypes.ts](apps/web/src/store/chatTypes.ts)。

## 2026-06-23 · 外部 Agent：prompt 拆分为 system / user 两段，HST 说明只下发一次

**What Changed**

在确定性 prompt 编排的基础上，按 prompt engineering 的实践把下发文本拆成两段独立模板：

1. **`system_prompt.md`（一次性 system preamble）**：包含角色设定（"你是与用户共享 Huabu 画布工作区的助手……"）+ `## Canvas Tools (Sideband)` 工具说明。只在每个新建会话的**第一轮**拼到用户消息前面下发一次。
2. **`user_prompt.md`（每轮 user prompt）**：`## Request`（用户原始消息）+ 可选的 `## Selected Nodes` 表格。每一轮都下发。

第一轮 = `system_prompt.md` + `user_prompt.md` 拼成一条 `session/prompt`（ACP 的 `session/prompt` 必然触发一次模型回合，所以把 system 段搭车在首条用户消息上，避免多浪费一个回合）；之后每轮只下发 `user_prompt.md`。

**Notes**

- HST 的可用性与 `canvasId` **解耦**：HST 脚本对每个 agentlet-backed 外部 agent 都会无条件下发（见 `server-mount.ts` 的 `pushSidebandTools`），所以工具说明（system 段）总会下发，不再用 `canvasId` 去 gate。`## Selected Nodes` 表格仍然只在有选中节点时出现（有选中必然在画布上）。
- 新增会话实体字段 `AcpSessionEntry.systemPreambleSent`：新建会话（`session/new`）初始为 `false`，恢复会话（`session/load`，转录已含 preamble）初始为 `true`。在首轮 `session/prompt` **成功之后**才置 `true`；失败的回合或 slash command 短路（逐字下发、不含 preamble）都不会消费该标志，下一轮真实消息会重发。
- `prepareExternalAgentPrompt` 新增入参 `includeSystem`、返回值 `includedSystem`，由 service 层基于 `systemPreambleSent` 驱动。
- 改动文件：[preprocessor.ts](apps/server/src/modules/agent/acp/preprocessor.ts)、[system_prompt.md](apps/server/src/prompt/external-agent/system_prompt.md)（新增）、[user_prompt.md](apps/server/src/prompt/external-agent/user_prompt.md)（新增，替换原 `prompt.md`）、[service.ts](apps/server/src/modules/agent/acp/service.ts)、[session-registry.ts](apps/server/src/modules/agent/acp/session-registry.ts)。

## 2026-06-23 · 外部 Agent：上下文编排改为确定性构建（去掉预处理 LLM）

**What Changed**

简化外部（ACP）agent 的 prompt 编排：彻底移除 `acp-preprocessor` 这个预处理 LLM 子 agent。之前每次给外部 agent 发消息，都要先跑一个内部 LLM 去探索画布、合成 `task` briefing、再产出 `ExternalAgentPrompt` JSON（`task` + `attachments`）；这带来一次额外的模型往返、延迟、不确定性和 JSON 解析失败的风险。

现在 prompt 完全**确定性**构建，无任何 LLM 调用：

1. **`task`** = 用户原始消息，原样转发（slash command 仍走原有短路逻辑，逐字下发）。
2. **`selectedNodes`** = 用户选中节点的元数据表（`nodeId` / `type` / `label`），不再内联节点正文、也不再走文件 attachment。外部 agent 按需用 Huabu Sideband Tool（`read-node <node-id>`）自取内容。
3. 下发文本由独立的 prompt 模板 `src/prompt/external-agent/prompt.md` 渲染：`task` + `## Selected Nodes` 表格 + `## Canvas Tools (Sideband)`（仅在绑定画布时出现）。模板用仓库自带的 Mustache 风格引擎（`{{var}}` / `{{#block}}` / `{{include}}`），逐行表格在 TS 里拼好后注入。

**Notes**

- 类型 `ExternalAgentPrompt` **原地变更**：`attachments[]` → `selectedNodes[] { nodeId, type, label? }`。聊天历史里旧的 `[SYSTEM PreparedPrompt]` sidecar（含 `attachments`）在 UI 卡片里有兜底渲染（`selectedNodes ?? []`），不会崩。
- `prepareExternalAgentPrompt` 现在是同步函数；`runAcpAgent` 不再 `await` 它，也不再传 `canvasRoot`（去掉了把 attachment 渲染成绝对盘符路径的逻辑）。
- 移除了 `acp-preprocessor` agent（`AgentId` / `ToolScope` 枚举 + `AGENT.md`）。
- 改动文件：[agent.ts](packages/shared/src/types/agent/agent.ts)、[preprocessor.ts](apps/server/src/modules/agent/acp/preprocessor.ts)、[loader.ts](apps/server/src/prompt/agents/loader.ts)（导出 `renderPromptFile`）、[external-agent/prompt.md](apps/server/src/prompt/external-agent/prompt.md)（新增）、[service.ts](apps/server/src/modules/agent/acp/service.ts)、[tools/index.ts](apps/server/src/modules/agent/tools/index.ts)、[PreparedPromptMessage.tsx](apps/web/src/components/Messages/PreparedPromptMessage.tsx)。

## 2026-06-23 · Chat Panel：把当前会话一键保存为画布上的 Question 节点

**What Changed**

Chat Panel 顶部的"+"（新会话）旁边多了一个 **保存（书签 +）** 按钮，三段拼接成一组：`[💾 Save] [+] [▾]`。

点击 Save 后做两件事：

1. 用当前 thread 的**第一条 user 消息**为文字内容，在画布视口中心创建一个 `question` 节点（`status='done'`、`viewed=true`），并把当前的 `threadId` / `agentBinding` / `agentMode` 都写到节点 `data` 上；
2. 立刻调 `clearMessages` 铸一个新的空 thread，沿用当前 mode + 当前 binding（行为与"+"完全一致），让你接着开新会话——不会和已保存的那条混在一起。

后续双击画布上这个 question 节点，会复用 `QuestionNode.canOpenInChat` 既有的"打开对话"路径：Chat Panel 进入 Question Replay 模式，从服务器把这个 `threadId` 的完整历史拉回来显示——零额外服务端改动，因为每个 thread 本来就以 `<canvasId>/.history/chat/<threadId>.json` 的形式落盘了。

**Notes**

- Save 按钮在以下情况下灰掉：
  - 当前 thread 还没有任何 user 消息；
  - 正在流式生成（`isLoading`）；
  - Chat Panel 处于 Question Replay / Sketch Cluster Inspector 模式（这两种模式下整组按钮已经被换成"返回"，问题不存在）。
- 不会触发 `useQuestionRunner` 重跑模型——它只挑 `status==='pending'` 的节点，`done` 节点完全是数据快照。
- 节点上显示的文字 = 第一条 user 消息全文。如果是 `@Agent` 之类的外部 binding 会话，保存出来的节点也会带上对应 binding，replay 时仍然走 ACP 路径。
- 改动文件：[apps/web/src/components/Panels/ChatPanel/NewChatMenu.tsx](apps/web/src/components/Panels/ChatPanel/NewChatMenu.tsx)、[apps/web/src/components/Panels/ChatPanel/index.tsx](apps/web/src/components/Panels/ChatPanel/index.tsx)。

## 2026-06-22 · Agent Sideband：HST 工具能正常下发、write-node 正确回传节点 ID

**What Changed**

修复 Agent Sideband 的三个问题，让外部 agent 真正能用上 Huabu Sideband Tool（HST）：

1. **HST 脚本一直没被下发到 agentlet daemon。** agentlet 控制连接握手成功后，server 端从不触发 `onConnection`/`onReconnection` 回调（只有 agent-session 角色会触发），导致 `server-mount` 里"推送 HST 脚本"的逻辑形同虚设——daemon 永远收不到资源，缓存目录也不会被创建。
2. **`write-node` 拿不到新建节点的 ID。** HST 之前从 `result.results[0].command.nodes[0].id` 取 ID，但引擎在内部用 `createId('node')` 生成 ID 后并不会回写到提交的命令上；真正的 ID 是通过 `pendingEffects.mutatedNodes`（新建节点排在最前）返回的。
3. **`AGENTLET_SIDEBAND_DIR` 在 Windows 下的临时目录路径有 bug。** 改为指向可丢弃且默认被 gitignore 的 `node_modules/.cache/agentlet/sideband`，并统一 `resolve()` 成绝对路径（相对 daemon cwd），避免外部 agent 用不同 cwd 时找不到脚本。

**Notes**

- HST 现在在 daemon 首次连接和挂起后重连（idle 自动 suspend / resume）时都会重新下发，缓存被清掉也能恢复。
- 修复后 daemon 日志会出现 `[acp] sideband tools pushed to agentlet` 与 `resource_saved`。
- 改动文件：[server.ts](external/agentlet/packages/server/src/server.ts)（agentlet 握手补上 `onConnection`/`onReconnection`）、[agentlet.ts](external/agentlet/packages/local/src/agentlet.ts)（sideband 目录默认值 + 绝对化）、[server-mount.ts](apps/server/src/modules/agent/acp/server-mount.ts)（提取 `pushSidebandTools`、连接/重连都下发、修正 HST 脚本路径层级）、[huabu-sideband-tool.mjs](apps/server/src/sideband/huabu-sideband-tool.mjs)（从 `pendingEffects.mutatedNodes` 取新建节点 ID）。

## 2026-06-22 · 画布：frame ↔ 内部节点的边走"同侧外绕"

**What Changed**

修复 frame 节点和它**内部**的某个节点直接连边时，edge 角度奇怪的问题。

原先的智能 handle 选择（[`getSmartHandles`](packages/shared/src/canvas-engine/utils/edge.ts)）只考虑了两个矩形**并排（外部）**的情形，会从 12 个候选 handle 对里挑最短、最少穿障的一对。这套规则套到"一个 rect 完全在另一个里"的容器场景时，每条直线候选都从容器内部斜着穿过去，最后画出来的曲线就是一条丑陋的内部斜线。

现在在打分循环之前新增一段**几何包含检测**：

- 若 target 完全在 source 里 → source 是容器（通常是 frame），target 是内部节点
- 若 source 完全在 target 里 → 反过来

任一命中后，沿容器对角线把它划成 4 个三角形楔形（上 / 下 / 左 / 右），看内部节点中心落在哪个楔里——然后两端都用同侧 handle（`top-source ↔ top-target` / `left-source ↔ left-target` 等等）。React Flow 的 bezier / smooth-step 路径会沿每个 handle 的外法线方向离开，所以渲染出来就是一条**从容器同侧出去，沿外缘绕回到内部节点同侧**的干净外环，符合直觉。

楔形判断用的是**比例**（`|offsetX| > |offsetY|`），不是绝对像素距离：frame 通常宽 > 高，如果按"哪条边像素更近"算，几乎永远是上 / 下赢，左 / 右死活出不来；按比例分则左半边的子节点真的会走左侧。

**Notes**

- 用**几何**而不是 `parentId` 判断"是否在内部"：拖动过程中如果子节点暂时超出 frame 边界（甚至超过 4 px 容差），会自动 fallback 到原有的外部走法——视觉上"它现在不在里面了"，应该按外部走，行为反而对。
- 同样规则对**嵌套**容器也成立：outer frame → leaf 直接连边时，leaf 在 outer 的绝对 rect 内 → 同侧。
- 4 px `INSIDE_SLACK_PX` 容差用来吞掉拖拽中的半像素抖动和子节点贴边的常见情况，确保贴边布局也能命中。
- 改动文件：[edge.ts](packages/shared/src/canvas-engine/utils/edge.ts)（新增 `isInsideRect` / `closestContainerSide` / `sameSidePair` helper + `getSmartHandles` 短路分支）。

## 2026-06-22 · 画布：可选的 MiniMap 缩略图

**What Changed**

画布右下角现在可以开 MiniMap（缩略图），跟着画布内容实时更新。**默认关闭**——去 Settings → Canvas 里打开 "Show MiniMap" 开关即可启用。

打开后支持两种交互：

- **拖拽缩略图** 直接平移主画布视口；
- **在缩略图上滚轮** 直接缩放主画布。

视觉上沿用 xyflow 自带的默认配色（亮/暗模式自动适配），只在外面加了一圈 `border-edge-default` 描边 + 圆角 + 微弱阴影，跟其它浮层组件保持一致。

**Notes**

- 偏好持久化在 `localStorage`（key: `sediment.minimapEnabled`），是**全局**设置，所有画布共享，刷新 / 重启后保持。Private mode / 配额报错会静默 fallback 到 in-memory（仍可在当前会话切换，只是不落盘）。
- 改动文件：[Canvas.tsx](apps/web/src/components/Panels/Canvas/Canvas.tsx)（按 store 状态条件渲染 MiniMap）、[canvasStore.ts](apps/web/src/store/canvasStore.ts)（新增 `minimapEnabled` / `toggleMinimap` + localStorage read/write helper）、[CanvasSettings.tsx](apps/web/src/components/Panels/Header/CanvasSettings.tsx)（新增 Toggle 行）。

## 2026-06-22 · Settings 面板：底部新增当前版本号

**What Changed**

打开 Settings 弹窗，左下角现在会显示一行小字 `v0.1.2`（跟随桌面端 `apps/desktop/package.json` 的 `version` 字段，构建时通过 Vite `define` 内联进 bundle）。Close 按钮维持在右下角，整体一行排开。

**Notes**

- 版本号选用 `text-fg-subtle` + `text-[11px]` + `font-mono`，跟周围的"次要信息"风格一致，可以选中复制，便于反馈 bug 时贴出来。
- web 包自己的 `package.json` 一直是 `0.0.0`，不是有效的产品版本号；桌面端 `package.json` 才是真正发版用的，因此选它作为单一信源。后续只要 bump 桌面端的版本，UI 上就会自动跟上。
- 新增的全局类型 `__APP_VERSION__` 声明在 [vite-env.d.ts](apps/web/src/vite-env.d.ts)，所有客户端代码都能直接引用。

## 2026-06-23 · Question 节点正文统一到 `data.content`

**What Changed**

之前 Question 节点的提示词单独住在 `data.input.content`（一个只有 `kind: 'text'` 一种变体的 discriminated union），其它文本类节点（note / text / web / pdf / office）则统一住在扁平的 `data.content`。这种"特例"导致 web 自动保存队列、服务端 PUT 路由和 AI executor 三处都得各自写一段"如果是 question 就读 `data.input.content`"的分支，正好被这次代码评审标记为 P1。

- **数据形状统一** —— Question 节点的提示词现在写在 `data.content`，与所有其他文本类节点一致；`QuestionInput` 类型从 `@sediment/shared` 移除；三处自动保存 / 写盘的特例分支随之删除，新增一种文本类节点时只要往 `TEXT_BEARING_NODE_TYPES` 加一行字符串就行。
- **首次启动会自动迁移老画布** —— 服务端在 workspace 引导阶段会把每个 `canvas.json` 里的 question 节点从 `data.input.content` 平铺到 `data.content` 并删除旧字段，同时把提示词回填到 `nodes/<label>.md` 的正文里（之前老版本不写 sidecar 正文，仅迁移 JSON 会在下一次结构 PUT 被 `stripNodesForCanvas` 抹掉）。迁移由 `<workspace>/.question-content-v1` 哨兵控制，跑一次即终结。

**Notes**

- 用户无感知，无需任何操作；启动后 Question 节点的内容、AI 提问、画布搜索全部照常工作。
- 如果你写了画布插件并直接构造 `QuestionNodeData`：旧的 `input: { kind: 'text', content: '…' }` 形状不再被前后端接受，请改用 `content: '…'`。
- 哨兵 `.question-content-v1` 留在 workspace 根目录，请勿手动删除（否则下次启动会重复扫描，但语义上仍然幂等不会丢数据）。

## 2026-06-22 · Canvas 搜索：流式 meta 命中 + 就地查找条手感修复

**What Changed**

继上次"补齐 text / question 节点高亮和 PDF 视图入口"之后，本轮主要打磨[画布搜索](#2026-06-20--canvas-搜索cmd-f-一键找节点和正文)的响应速度和就地查找条的导航手感：

- **Meta 命中现在边读边返** —— 之前服务端 `searchCanvas` 要先 `await readAllNodes()` 一次性把所有 sidecar 都读上来才开始扫第一个字段，大画布上首条结果有明显的延迟。改为 `streamAllNodes` 边读边扫：每个 sidecar 一落盘就立刻匹配 label / summary / keywords 并通过 NDJSON 推到前端，第一条命中往往在剩余文件还在读的时候就显示了。content tier 仍走全量缓存，零额外 I/O。
- **预览查找条第一次按 `Enter` 跳到第 1 条而不是第 2 条** —— 之前打开就地查找条、视觉上"光标已经落在第 1 个高亮上"，但首次回车会把游标推到第 2 个，对惯了 VS Code 的人比较反直觉。现在第一次 `Enter` 锚定到 #1，第二次开始才前进 / 回退。
- **`n/m` 命中计数会跟随异步渲染自动刷新** —— pdf.js 的文本层和 Milkdown 的懒加载编辑器都是初次挂载之后才填字符，之前计数只在打开查找条那一刻数一次，pdf 翻页后数字不变。现在 `useTextHighlight` 把命中数和它内部的 `MutationObserver` 绑在一起，DOM 一变就自动重算。
- **搜索请求失败时不再泄漏一个 fetch 连接** —— 快速重打需求词时，老逻辑会在 `response.ok === false` 路径上直接 `throw` 而不消费响应体，Chromium 会保留底层 socket 直到 GC，长时间高频搜索会肉眼可见地积压网络面板的 pending 项。修复方法是在抛错之前先 `body?.cancel()`。

**Notes**

- 行为完全向后兼容，无需任何用户操作；老的 in-memory 测试入口 `runCanvasSearch` 也仍保留供单测使用。
- 如果你写了画布插件并直接调用了 `/canvas/:id/search` 的流式接口：事件顺序没变，仅 meta 阶段命中到达更早。

## 2026-06-21 · Canvas 搜索：补齐 text / question 节点高亮和 PDF 视图入口

**What Changed**

修复 [Canvas 搜索](#2026-06-20--canvas-搜索cmd-f-一键找节点和正文)落地后用户反馈的三类小问题：

- **文本类节点（`text` / `question`）也能被高亮** —— 这两类节点正文渲染在 `<textarea>` 内，浏览器原生 [CSS Custom Highlight API](https://developer.mozilla.org/docs/Web/API/CSS_Custom_Highlight_API) 无法穿透到 textarea 内部。新增一个只在"非编辑态"出现的同字体同布局只读镜像 `<div>`，让高亮层有真实 DOM 文本可以指向。编辑态自动还原成普通 textarea，无视觉切换感。
- **`question` 节点的 prompt 现在纳入画布搜索索引** —— 之前 question 节点的提问文本只活在内存中（`data.input.content`），不会落到 markdown sidecar，导致服务端扫描器看不到它。现在前端 autosave 会把 prompt 镜像到 sidecar 的 `content` 字段（服务端同步放行了 `question` 类型的 body 写入），下次再编辑提问后即可被搜到。
- **结果列表里的命中高亮不再撑开字距** —— `<mark>` 之前带了 `px-0.5` 内边距，看上去像把命中文字和左右字隔开了。改为只用背景色，字距复原。
- **PDF 展开预览也能用 `Cmd+F` 唤起就地查找条** —— 之前 PDF viewer 不接管键盘焦点，焦点停在 `<body>`，全局热键解析不到"节点 scope"就退到了画布浮层。现在如果当前页面已经挂着展开预览面板（`[data-search-scope="node"]`），即便焦点不在里面也优先把 `Cmd+F` 路由到这块预览。
- **PDF 命中高亮不再露出文本层的"幽灵字"** —— 之前 `::highlight(sediment-search)` 顺手把 `color` 也强设成 `--fg-default`，导致 pdf.js 那层本来 `color: transparent` 的可选中文本被强制可见，叠在真实页面之上像换了一种字体。去掉 `color` 属性，与浏览器原生 `::selection` 行为对齐：背景照亮，文字色继续 inherit。
- **画布搜索 ↑/↓ 现在实时聚焦到当前命中节点** —— 之前只有 `Enter` 或鼠标点击才会 `fitView`，所以方向键翻列表时视口不动，看上去就像"每次只聚焦在第一个"。改为 `activeIdx` 变化即触发 `fitView`（不打开预览），`Enter` 仍保留"内容命中则打开预览"的最终动作。

**Notes**

- 老的 question 节点要先被编辑一次，prompt 才会写入 sidecar 变成可搜索；纯历史节点不会自动回填。
- TextNodeBody 的镜像层仅在 `draft.length > 0 && !isEditing` 时挂载，空节点 / 编辑中保持原结构，避免影响光标定位和占位符渲染。

## 2026-06-20 · Canvas 搜索：`Cmd+F` 一键找节点和正文

**What Changed**

新增按节点级别的画布搜索能力，入口统一为 `Ctrl/Cmd+F`，按焦点位置自动分发到两种搜索面：

- **画布搜索浮层** —— 焦点在画布时打开，顶部居中弹出。结果分两段流式返回：先回 Meta 命中（标题 / 摘要 / 关键词），随后回 Content 命中（正文）。`↑ / ↓` 切换、`Enter` 跳转（自动 `fitView` 到目标节点，若命中正文则同时打开预览），`Esc` 关闭。
- **就地查找条** —— 焦点在右侧展开的节点预览中时打开，紧贴预览顶部。使用浏览器原生 [CSS Custom Highlight API](https://developer.mozilla.org/docs/Web/API/CSS_Custom_Highlight_API) 在预览正文上做无侵入式高亮（不会改动 Milkdown / pdf.js 自己的 DOM）。`Enter` / `Shift+Enter` 上下跳，`Esc` 关闭。

后端是新增的 `POST /canvas/:canvasId/search` 路由，走 **NDJSON 流式协议**：服务端按"先 Meta 后 Content"的两阶段顺序边扫边推（`progress` 帧包含 `phase: 'meta-done'` 与 `phase: 'content'` 的扫描进度），并发读取节点 sidecar。每次按键都通过 `AbortController` 取消上一次未完成的请求，socket 关闭后服务端会立即停止扫描。

**Notes**

- 不做应用层缓存：搜索是低频操作，OS 页缓存 + 一次性并发读已经足够；待单画布稳定突破 30MB 再评估接入 ripgrep。
- 默认 `limit = 100`（画布浮层）/ `200`（预览内）。命中过多时服务端会截断并在最后的 `done` 帧里把 `truncated: true` 透传到前端。
- 已注册的快捷键参考请见 [08 · 快捷键参考 → 搜索](./08-shortcuts.md#搜索)。

## 2026-06-19 · External agent：换电脑/清浏览器缓存后，斜杠菜单仍能秒显

**What Changed**

把每个 agent profile 最近一次拿到的斜杠命令列表也纳入 server 端的 **L3 per-profile cache**（落盘到 `data/acp-profile-schema-cache.json`）。之前这层缓存只覆盖 model / mode / config option 三类 schema 字段，斜杠命令的乐观秒显完全依赖前端 `localStorage`——清浏览器数据、换设备、隐私模式下都会退化成"等 agent 冷启动 + 首次推送"，最长十几秒。现在 server 也会缓存，新 thread 在 `ensureAcpSession` 创建 entry 时若命令仍为空，就用 L3 里的列表 warm-start，agent 实际推送 `available_commands_update` 后再静默对账。

**Notes**

- L3 与 localStorage 是双层乐观缓存，互不依赖：任一层命中即可秒显，任一层失效（清盘 / 清浏览器）都能由另一层兜底。
- 写入触发点保持对齐——`mirrorEntryToProfileCache` 现在也在 `available_commands_update` SSE 处理后调用，和 mode / model 的更新路径同源。
- 改动文件：[profile-schema-cache.ts](apps/server/src/modules/agent/acp/profile-schema-cache.ts)（entry 新增 `availableCommands` / `commandsUpdatedAt`，sanitize + merge 同步扩展）、[service.ts](apps/server/src/modules/agent/acp/service.ts)（mirror 包含命令，新建 entry 时从 L3 warm-start）。

## 2026-06-18 · External agent：服务器重启后，没发过消息的 thread 也能重新打开

**What Changed**

修复"服务器重启后，打开之前那条还没发消息的 external agent thread，弹出红色 `Failed to spawn external agent: Session bootstrap failed: session/load failed: Resource not found: Session ...`"。

根因：thread 在 `session/new` 成功的那一刻就把 sessionId 写到了磁盘（[session-store.ts](apps/server/src/modules/agent/acp/session-store.ts)），这样下次启动时能 resume。但 **Copilot CLI 不在进程之间持久化"空 session"** —— 没收到过 user prompt 的 session 重启后 Copilot 那边压根不存在，旧 sessionId 对它而言是 unknown id。服务器拿着这个旧 id 让 agentlet 走 `session/load`，Copilot 直接返回 `-32002 Resource not found`，agentlet 把它当 hard failure 上抛，spawn 整个失败。

修法是**把 per-thread 的 sessionId 落盘时机推迟到"第一次 prompt 成功之后"**：

- [session-registry.ts](apps/server/src/modules/agent/acp/session-registry.ts) 给 `AcpSessionEntry` 加了两个字段：`bindingRecipe`（保存 spawn recipe，方便 promotion 时不用重新查 profile）和 `persistedToDisk: boolean`（标记这条记录有没有进过 `acp-sessions.json`）。
- [service.ts](apps/server/src/modules/agent/acp/service.ts) 的 `openOrReuseSession`：fresh session（`!persisted?.sessionId`）创建时只放进 in-memory registry，**不**写盘；resume session（已有持久记录）照旧刷新一遍盘上记录，保持下次重启还能 recover。
- 同文件 prompt 派发处的 `.then(result => ...)` 里加 `promoteEntryToPersisted(entry, logger)`：第一次 prompt 真正跑完（Copilot 已经处理过一轮 user turn、内部 session 已经被它持久化）之后，才把 sessionId/profileId/cwd/recipe/meta 一次性写进 `acp-sessions.json` 并把 flag 翻成 `true`。后续 prompt 再调时是 no-op。

这样空 thread 重启后**根本不会有 stale record**，orchestrator 拿不到 `existingSessionId` → 直接走 fresh `session/new` → 干净打开。

**Notes**

- 调试用的 meta 写入（toolbar 上的 model/mode/configOptions 等）走的是 `writeAcpSessionMeta`，它内部有 `if (!existing) return false;` 保护，第一次 prompt 之前调用是安全 no-op，**不会**漏写 meta —— 真正的 meta 会在 promotion 那一步随 record 一起持久化。
- Per-profile 的 schema cache（toolbar 选项的来源，参见上一条 changelog）仍然在 agent push 时立刻填充，所以空 thread 第一次打开的 toolbar 体验完全不受影响。
- Resume 路径上的 `writeAcpSessionRecord` 仍然在 open 时跑，所以**真正发过消息的 thread**重启后照旧能 recover；只是把"还没开口"的 thread 排除掉了。
- 改动文件：[session-registry.ts](apps/server/src/modules/agent/acp/session-registry.ts)（加字段），[service.ts](apps/server/src/modules/agent/acp/service.ts)（推迟写入 + `promoteEntryToPersisted` helper），[spawn-orchestrator.ts](apps/server/src/modules/agent/acp/spawn-orchestrator.ts)（更新过时的 fallback 注释，说明新的 deferred-persistence 模型）。

## 2026-06-18 · Frame 拖拽提示：不再压在被拖节点上面

**What Changed**

接着上一条嵌套 frame 提示的工作，把 overlay 的层级修正了：之前 overlay 放在 `<ReactFlow>` 外面的 wrapper 里、`z-40`，处于一个独立的 stacking context，导致它高于 React Flow 内部所有节点（包括被拖到 `+1000` 的那个），看起来像"提示框把节点盖住了"。现在把 overlay 用 `<ViewportPortal>` 挪到 ReactFlow viewport 里、显式 `zIndex: 0`，正好夹在 frame body（`zIndex: -1`）之上、被拖节点（drag 期间 `zIndex` 被 React Flow 抬到 999~1000）之下。

Overlay 描绘的内容**保持上一条的设定不变** —— 还是用 `computeFrameFit` 算出"假如松手会变成的尺寸"，既兼顾 targeting 提示又预告 post-drop 布局。

**Notes**

- 改用 ViewportPortal 同时把"屏幕坐标换算"全省掉了：原 overlay 要算 `rfInstance.flowToScreenPosition` 再减 wrapper bounding rect；现在直接拿 flow 空间的 `position.x/y` 当 `left/top`，pan/zoom 由 viewport 的 CSS transform 自动负责，rAF tick 少做几次 layout 读。
- 改动文件：[Canvas.tsx](apps/web/src/components/Panels/Canvas/Canvas.tsx)（`FrameFitPreviewOverlay` 改 flow-space + `zIndex: 0`，渲染点移入 `<ViewportPortal>`，新增 `ViewportPortal` 导入）。

## 2026-06-18 · 嵌套 frame 拖拽：现在能一眼看出节点要进哪个 frame

**What Changed**

之前拖一个节点经过嵌套 frame（frame 套 frame）的时候，preview 会把所有"受影响的 frame"都用同一种淡蓝色填充画出来——既包括节点正要进入的内层 frame，也包括它正在离开的外层 frame，还包括只是被路过的父 frame。结果就是用户**看不出最后到底要落在哪一个 frame 里**。

现在每个 preview 都按"语义角色"上色：

- **Target（节点会落进去）** — 实线 `border-info` 蓝色边框 + 较深的 `info-bg` 填充 + shadow，视觉上最显眼。包括两种情况：拖到一个新 frame、或继续留在当前父 frame 里。
- **Source（节点正要离开）** — 虚线 `edge-default` 中性灰边框 + 很淡的 `bg-subtle` 填充，存在感弱，告诉用户"这个 frame 会缩"但不抢戏。

嵌套场景下：内层 frame 亮蓝、外层 frame 灰淡，一眼区分；同 frame 内部移动时，那个 frame 自己亮蓝，符合"我的目的地就是这里"的直觉。

**Notes**

- Role 在写入 `gesturePreviewStore` 时就定下，overlay 只负责按 role 切换样式，没有运行时再推导意图——避免每帧都重算。
- Resize 手势（拖 frame 子节点的尺寸柄触发父 frame reflow）一律是 `target`，因为没有"离开"语义，只有"这个 frame 正在被实时重排"。
- 分配规则在 [canvasStore.ts](apps/web/src/store/canvasStore.ts) 的 `onNodeDrag` 里：`leaving && !entering → source`，其它都是 `target`。注意"merely-current-parent"分支：节点在自己 frame 内部移动时，那个 frame 既不在 leaving 也不在 entering，依然算 `target`。
- 改动文件：[gesturePreviewStore.ts](apps/web/src/store/gesturePreviewStore.ts)（新增 `FrameFitPreviewRole` / `FrameFitPreview` 类型）、[canvasStore.ts](apps/web/src/store/canvasStore.ts)（drag 写入 role）、[resizePreview.ts](apps/web/src/store/canvasStore/slices/resizePreview.ts)（resize 写入 `'target'`）、[Canvas.tsx](apps/web/src/components/Panels/Canvas/Canvas.tsx)（`FrameFitPreviewOverlay` 按 role 渲染）。

## 2026-06-18 · 拖拽节点贴近 frame 边缘：所见即所得，松手不再"反悔"

**What Changed**

之前在 smart-snap 打开时存在一个偶发但很别扭的"漂移"现象：拖一个节点贴着 frame 边缘移动，**preview（拖动中实时显示）已经把节点收进 frame**，但松开鼠标的一瞬间节点又被弹出去回到 root；或者反过来——preview 显示已经脱离，松手却又被吸进去。根因是 preview 走 rAF 用的是"上一次 mousemove 的指针 + 未 snap 的原始位置"，而落点 resolver 走 mouseup 用的是"最终 snap 后的位置 + mouseup 指针"，这两套输入在边缘几像素的窗口里可能给出不一样的 unframe / 入框判断。

现在拖拽结束时严格按"用户最后一次看到的 preview"来落子：

- 每次 rAF preview tick 都把当前的 unframe / enterFrame 决定写进一个 gesture-scoped 的 cache；
- `endSnapSession` 把 cache 快照一份（与现有的 `_lastDragReparentBypass` 同一时机）；
- `onNodeDragStop` 把快照塞进 `NODE_DRAG_STOP` intent；
- resolver 看到 `cachedDecisions` 就直接按它执行（仍用 `moveNodeIntoFrame` / `moveNodeOutOfFrame` 走标准的位置保持），跳过自己重新计算 overlap / 指针 halo 的环节。

**Notes**

- WYSIWYG 契约：屏幕 60Hz，最后一次 paint 到 mouseup 之间最多 16ms，用户看不见这个间隙；与其在 mouseup 时再算一遍冒着不一致的风险，不如直接 honor 最后一次 cache。
- 三条 fallback 路径保留：① 没有 rAF 触发的极速点-放（无 cache）→ 走原来的 fresh 重算；② `autoLayoutEnabled === false` → 走 fresh 重算；③ 拖拽手势显式 `bypassReparent` → 仍优先生效，cache 让位。
- 改动文件：[snapSession.ts](apps/web/src/handler/snap/snapSession.ts)（新增 `DragDecision` + cache 与三个访问器）、[canvasStore.ts](apps/web/src/store/canvasStore.ts)（rAF 写 + dragStop 读）、[uiIntent.ts](apps/web/src/handler/canvasCommand/uiIntent.ts)（`NODE_DRAG_STOP` 新增 `cachedDecisions` 字段）、[resolveNodeDragStop.ts](apps/web/src/handler/canvasCommand/resolvers/resolveNodeDragStop.ts)（cache 快路径）。
- 新增覆盖 WYSIWYG 契约的 5 个 case：[resolveNodeDragStop.cache.test.ts](apps/web/src/handler/canvasCommand/resolvers/__tests__/resolveNodeDragStop.cache.test.ts)，分别验证 cache 在"fresh 想 unframe 但 cache 说不"、"fresh 想保留但 cache 说脱"、"cache 指定入新 frame"、"无 cache 时 fallback 正确"、"`bypassReparent` 优先于 cache" 这五种边界。

## 2026-06-18 · External agent：新 thread 第一次打开也能立刻看到 model / config 选项

**What Changed**

修复"新建 session、显示已连接、但 model 下拉是空的；发一条消息后才出现"的体验断层。

根因：`session/new` 在 agent 确认 session id 时就 resolve，**早于** agent 异步推送的 `config_option_update` / 模式&模型目录（Copilot CLI 通常晚 1-3s）。这些推送会落到 server 的 registry entry，**但只在 SSE 流打开时**（也就是用户发消息时）才会被送到 web 端。结果就是：badge 已经变绿、但 toolbar 是空的，必须发一条消息才会"突然"出来。

修法：`useAcpSessionMeta` 的 `refresh()` 在 ensure resolve 后，**如果 snapshot 是 schema-empty**（`configOptions` / `availableModes` / `availableModels` 三个 list 全空），按 `[400, 1000, 2000, 3000, 5000, 8000, 12000, 15000, 15000]ms` 偏移持续轮询 `/cached-meta`（read-only、不 spawn），总窗口 ~60s，抓到 schema 内容立刻 commit 然后停。

窗口必须够长：Copilot CLI 在一个全新 cwd 启动时，**auth 握手 + workspace 索引经常把第一次 `config_option_update` 推迟到 15–30s**，短窗口会悄无声息地退化成"只能靠首条消息触发 SSE 才有 options"——也就是这次修复的目标 bug。

**Notes**

- 只在 schema-empty 时才 poll：cache hit（profile cache / 持久化记录）已经有内容，直接跳过 polling，0 额外开销。
- `loading` 在 ensure resolve 瞬间就翻 false，**badge 不会在 polling 的 60s 窗口里一直显示 connecting**——polling 是后台 top-up，不是用户可见的"是否在连"信号。
- 每次 poll 失败（网络抖动）静默吞掉，不影响 badge（ensure 已经成功，错误状态不应该回滚）。
- 一旦 schema 落到了 profile cache，**同 profile 的所有后续新 thread 都直接命中 cache**，根本不会触发这条 polling 路径。所以这次修复只影响"profile 在本机的第一次使用"。
- 改动文件：[useAcpSessionMeta.ts](apps/web/src/hooks/useAcpSessionMeta.ts)。

## 2026-06-18 · External agent：连接失败现在告诉你"为什么"和"怎么修"

**What Changed**

之前 `POST /api/acp/threads/:threadId/session` 任何失败都返回 `{code: 'acp_session_failed', message: '<原始错误>'}`，UI 只能渲染一个通用的红色"FAILED"和原始 message。现在按失败原因分了 6 个稳定的 `code`，前端按 code 渲染针对性的提示和下一步动作：

| code                 | 含义                               | tooltip headline                                                                           |
| -------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------ |
| `profile_missing`    | 绑定的 profile 被删了              | "Profile for ... no longer exists. Re-create it in Settings."                              |
| `bridge_not_mounted` | 内嵌 agentlet bridge 还没起来      | "Sediment is still starting up. Try again in a moment."                                    |
| `worker_not_ready`   | agentlet worker daemon 没连上      | "Agent worker is offline. Try Restart worker in Settings."                                 |
| `spawn_failed`       | daemon 拒绝 spawn（recipe 不合法） | "Could not start ... Check command path / cwd."                                            |
| `connect_timeout`    | agent 进程起来了但 3s 内 WS 没握手 | "... started but never responded. May need to re-authenticate (Copilot OAuth) or crashed." |
| `internal`           | 兜底                               | 通用错误                                                                                   |

红色徽章上的短标签也按 code 切换：`Worker` / `Profile` / `Spawn` / `Timeout` / `Starting` / `Failed`，鼠标悬停看完整 headline + 原始 message。

**Notes**

- 服务端新增 [errors.ts](apps/server/src/modules/agent/acp/errors.ts) 定义 `AcpServiceError` 和 `AcpEnsureErrorCode`，所有可分类的失败点都用 `throw new AcpServiceError(code, msg)`；其它意外异常 fallback 到 `'internal'`。
- 此外把 `spawn-orchestrator.ts` 里的 `waitForAgentConnection(...)` 由"超时静默返回 false"改成"超时显式抛 `connect_timeout`"——这是之前 `503` 经常发生但日志里几乎看不到原因的根本原因之一。
- 共享类型 [packages/shared/src/types/api/acp.ts](packages/shared/src/types/api/acp.ts) 导出 `AcpEnsureErrorCode` 联合类型，web 端用它做穷举 switch。
- Hook [useAcpSessionMeta.ts](apps/web/src/hooks/useAcpSessionMeta.ts) 新增 `errorCode` 字段，从 `ApiError.code` 解析；未识别的 code（旧服务端 / 网络错误）返回 `null`。
- Wire 兼容：旧客户端只读 message，不影响；新客户端读 code 走分支。
- 改动文件：[errors.ts](apps/server/src/modules/agent/acp/errors.ts) (新增)、[service.ts](apps/server/src/modules/agent/acp/service.ts)、[spawn-orchestrator.ts](apps/server/src/modules/agent/acp/spawn-orchestrator.ts)、[threads.route.ts](apps/server/src/modules/agent/acp/threads.route.ts)、[packages/shared/src/types/api/acp.ts](packages/shared/src/types/api/acp.ts)、[useAcpSessionMeta.ts](apps/web/src/hooks/useAcpSessionMeta.ts)、[AcpConnectionBadge.tsx](apps/web/src/components/Panels/ChatPanel/AcpConnectionBadge.tsx)、[ChatPanel/index.tsx](apps/web/src/components/Panels/ChatPanel/index.tsx)。

## 2026-06-18 · Toast 与 Button 共享统一的 `tone` 语义；toast 内按钮匹配 toast 背景色

**What Changed**

之前 `Toast` 用 `variant` 描述颜色家族（`default | info | success | warning | error`），`Button` 用 `tone` 描述颜色家族（`neutral | info | danger`），词汇与命名都不一致；而 toast 里的 action / × 按钮统一用 `bg-inverse`（深色），落在彩色 toast 上（`info` / `success` / `warning` / `danger`）时会像贴了一块黑色"补丁"，视觉上和 toast 主体割裂。

- **`Button` 新增共享类型 `Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'`**（[apps/web/src/components/Common/Button.tsx](apps/web/src/components/Common/Button.tsx)），原 `ButtonTone` 收敛为 `Tone`；`solid` / `outline` / `ghost` 三种 variant 都补齐了 `success` / `warning` 两档配色。
- **`Toast` 的 `variant` prop 重命名为 `tone`**（[apps/web/src/components/Common/Toast.tsx](apps/web/src/components/Common/Toast.tsx)），值集合改为复用 `Tone`：`default → neutral`、`error → danger`。`ToastTone` 现在是 `Tone` 的别名。
- **Toast 内的 action / × 按钮自动继承 toast 的 `tone`**，所以红色 toast 上的按钮也是红色（同色家族），靠 label / icon 的对比 + hover 提亮提供可见性，不再出现深色"补丁"。
- **同步更新所有调用点**（约 19 处）：`toast(msg, { variant: 'error' })` → `toast(msg, { tone: 'danger' })`，`variant: 'warning'` → `tone: 'warning'`，`variant: 'success'` → `tone: 'success'`。涉及 [apps/web/src/store/canvasStore.ts](apps/web/src/store/canvasStore.ts)、[apps/web/src/store/canvasHistoryManager.ts](apps/web/src/store/canvasHistoryManager.ts)、[apps/web/src/store/canvasStore/save/nodeContentQueue.ts](apps/web/src/store/canvasStore/save/nodeContentQueue.ts)、[apps/web/src/components/Panels/Header/AcpSettings.tsx](apps/web/src/components/Panels/Header/AcpSettings.tsx)、[apps/web/src/components/Panels/Header/CanvasMenu.tsx](apps/web/src/components/Panels/Header/CanvasMenu.tsx)、[apps/web/src/components/Panels/Header/LLMSettings.tsx](apps/web/src/components/Panels/Header/LLMSettings.tsx)、[apps/web/src/components/Panels/ChatPanel/index.tsx](apps/web/src/components/Panels/ChatPanel/index.tsx)、[apps/web/src/pages/CanvasListPage.tsx](apps/web/src/pages/CanvasListPage.tsx) 等。

**Notes**

- 决策依据：一个设计系统中"颜色家族"这个概念只该有一套词汇。原先 `Button.tone` 已经在内部消化了 `variant`（形状/风格）与 `tone`（颜色）的区分，`Toast` 没有多形状需求所以把颜色塞进了 `variant`——现在统一到 `tone`，`variant` 这个词在整个系统里只表示"形状/风格"。
- `error → danger` 跟随设计 token（`--danger` / `bg-danger`），命名与底层一致。
- `default → neutral` 跟随 `Button.tone` 既有命名（更具描述性，避免"默认"二义）。
- toast 内按钮的"同色"策略：用 label / icon 的 `text-fg-inverse` 与 `enabled:hover:bg-X/80` 共同提供可见性。如果未来想要更强对比，可以在按钮上叠 `bg-black/10` 之类的 overlay，但目前无 issue。
- 该变更是**调用方有破坏性**的（参数名 `variant` → `tone`、值 `error` → `danger`、值 `default` → `neutral`），所有 in-repo 调用点已同步更新；如果有 fork 或 plugin 在用 `toast(msg, { variant: 'error' })`，请一并迁移。

---

## 2026-06-18 · "Canvas 已被其他端修改"提示加上 Reload 按钮 + 离开画布自动消失

**What Changed**

之前 `CANVAS_VERSION_CONFLICT` 弹出的红色 toast 是 `duration: 0` 永久挂着的（[apps/web/src/store/canvasStore.ts](apps/web/src/store/canvasStore.ts) `saveCanvas` 409 分支），但 toast 自身没有任何关闭手段，用户被迫看到刷新为止；而且就算用户切回 canvas 列表，提示还在屏幕上漂着，跟当前页毫无关系。

- **`Toast` 组件新增 `action` 槽位 + `dismissible` × 按钮**（[apps/web/src/components/Common/Toast.tsx](apps/web/src/components/Common/Toast.tsx)）。`duration === 0` 或带 `action` 的 toast 默认显示 × 关闭按钮，普通自动消失的 toast 保持原样不变。点 action 按钮会执行回调并自动 dismiss。
- **版本冲突 toast 加上 "Reload" 按钮**：点一下直接 `window.location.reload()`，比手动按 F5 / 找浏览器刷新按钮更顺手；同时保留 × 让用户先把未保存的文字复制出来再决定何时刷新。
- **离开 canvas 自动消失**：[apps/web/src/pages/CanvasPage/CanvasPage.tsx](apps/web/src/pages/CanvasPage/CanvasPage.tsx) 的 unmount cleanup 会调 `dismissVersionConflictToast()`，所以点左上角箭头回 canvas 列表 / 打开 settings / 进 docs 时，提示自动消失。
- **切换到别的 canvas 也消失**：`loadCanvas` / `switchCanvas` 在 reset `versionConflict: false` 时同步 dismiss 该 toast——新 canvas 有新的 version baseline，旧提示已无意义。

**Notes**

- 决策依据：modal 会遮住画布，用户没法先复制未保存文字；banner 改造范围太大。toast + action 按钮是 Sonner / MUI Snackbar / Radix Toast 行业标配，匹配"持续状态提示 + 可恢复操作"语义。
- toast id 用模块级变量 `_versionConflictToastId` 跟踪，不进 zustand state——纯 UI ephemera，没有组件 subscribe。
- `loadCanvas` 同时清 `versionConflict` flag 和 toast，保证 store 跟 UI 不漂移。
- 改动文件：[apps/web/src/components/Common/Toast.tsx](apps/web/src/components/Common/Toast.tsx)、[apps/web/src/store/canvasStore.ts](apps/web/src/store/canvasStore.ts)、[apps/web/src/pages/CanvasPage/CanvasPage.tsx](apps/web/src/pages/CanvasPage/CanvasPage.tsx)。

---

## 2026-06-18 · Rename / delete 失败提示：彻底告别 `window.alert`，warning vs error 分开

**What Changed**

接上一版"DELETE/rename 失败现在会通过 toast 告诉你"，这一版进一步把所有阻塞式 `window.alert` 换成非阻塞 toast，并按"用户输入问题"vs"系统真实故障"分了不同的视觉层级。也区分了**主动**（用户点改名）和**自动**（agent / 后台代码改 label）两条路径的 UX。

- **`Toast` 组件新增 `warning` variant**（[apps/web/src/components/Common/Toast.tsx](apps/web/src/components/Common/Toast.tsx)）。底色用设计系统的 `bg-warning` token（琥珀色），跟现有的 `info` / `success` / `error` 三档拉开层级，专用于"你输入的东西有问题，改一下就行"。
- **所有 rename / canvas-title 的 409 冲突由 `alert` 改为 `toast warning`**（[apps/web/src/store/canvasStore.ts](apps/web/src/store/canvasStore.ts) `tryRename`）。duration 5000ms，比默认的 3000ms 长一点，让用户来得及看完。
  - 用户主动改名命中本地 sibling 预检 → `toast warning`。
  - 服务端 409 `NODE_LABEL_CONFLICT` / `CANVAS_TITLE_CONFLICT` → 自动 revert 乐观更新 + `toast warning`。
- **`nodeContentQueue.flushNow` 新增 `source: 'user' | 'auto'` 参数**（[apps/web/src/store/canvasStore/save/nodeContentQueue.ts](apps/web/src/store/canvasStore/save/nodeContentQueue.ts)），缺省 `'user'`。debounce 自动保存 / `flushAll` / `flushAllKeepalive` 一律用 `'auto'`，只有 `tryRename` 显式传 `'user'`。
- **`handleSaveFailure` 按 source 分流**：500 失败时
  - `source === 'user'` → `toast error` + 自动 revert label。
  - `source === 'auto'` → 只 `console.error` + 自动 revert label。**不再弹 toast**，避免 agent 频繁改名时刷屏。
  - 两条路径都仍然做 label revert，保证 store 跟磁盘不漂移。

**Notes**

- 决策依据：409 是"用户输入跟现有数据冲突"（warning，用户可以马上修），500 是"磁盘/文件锁出问题"（error，系统侧故障，已自动回滚）。两类的紧迫度不同，分两个 variant。
- 自动 rename 的失败提示从"toast"降级为"只在 console"——理由是自动改名一般来自 agent 或 paste 去重器，用户没有"我刚改了名"的预期，弹 toast 反而打扰；label revert 本身就是足够的视觉反馈。
- 用户主动改名的 500 失败仍然弹 toast，因为用户有"我刚点了改名"的预期，需要明确告诉他"没成"。
- 改动文件：[apps/web/src/components/Common/Toast.tsx](apps/web/src/components/Common/Toast.tsx)、[apps/web/src/store/canvasStore/save/nodeContentQueue.ts](apps/web/src/store/canvasStore/save/nodeContentQueue.ts)、[apps/web/src/store/canvasStore.ts](apps/web/src/store/canvasStore.ts)。

---

## 2026-06-18 · External agent：per-profile schema 缓存——同 profile 新对话也立刻有工具栏

**What Changed**

把 ACP meta 缓存从 per-thread 升级为 per-profile + per-thread 双层。schema（`availableModels` / `availableModes` / `configOptions` 类型 + 可选值）对同一个 profile 的所有 thread 都是相同的，没必要每个新 thread 都重 spawn 一次去问。

- **服务端新增** `data/acp-profile-schema-cache.json`：按 `profileId` 缓存 schema + 上次该 profile 任意 session 推送过的 `currentModelId` / `currentModeId` / 每个 option 的 `currentValue`。每次 `config_option_update` / `current_mode_update` 落到 entry 上时，自动 mirror 一份到 profile cache（debounced 250ms）。
- **`GET /api/acp/threads/:threadId/cached-meta` 新增 `?profileId=` 参数**。查找顺序：
  1. 内存 registry（最新）
  2. 当前 thread 的磁盘记录（per-thread state）
  3. **per-profile schema cache**（同 profile 共享）
  4. 空快照
- **Web `useAcpSessionMeta` 把 `profileId` 也传上**。三层 cache 任意一层命中就**不再 auto-ensure**——同一个 profile 已经用过一次后，**所有新 thread 打开都是 0 spawn + 工具栏立刻可用**。
- **去掉了上一版的 post-ensure 后台轮询**（200/800/2000/4000ms 那个）。轮询是为了等 Copilot 异步推 config_options；现在第一次推完会写进 profile cache，下一个 thread 直接读，根本不需要再等。

**Notes**

- 真正 spawn 的入口缩到三个：发送消息 / 打开 `/` 菜单 / 切换 model · mode · config option。**打开新 thread 不再自动 spawn**（前提是该 profile 之前有 thread 用过）。
- 全新 profile 的**第一个 thread** 仍会 auto-ensure 一次（badge 蓝呼吸 → 绿）；ensure 完成 + agent 推送 schema 后写进 profile cache，**该 profile 之后所有 thread 都直接命中 cache**。
- 用户预选的 `current*` 是"上次该 profile 用过的"——绝大多数情况就是用户想要的（同一个 Copilot 几乎总是用同一个模型）；万一 agent 在 session/new 给出不同的 default，SSE 推送会自动覆盖。
- 新增文件：[apps/server/src/modules/agent/acp/profile-schema-cache.ts](apps/server/src/modules/agent/acp/profile-schema-cache.ts)。
- 修改：[service.ts](apps/server/src/modules/agent/acp/service.ts)、[threads.route.ts](apps/server/src/modules/agent/acp/threads.route.ts)、[\_routes.ts](apps/web/src/api/_routes.ts)、[acp.ts](apps/web/src/api/acp.ts)、[useAcpSessionMeta.ts](apps/web/src/hooks/useAcpSessionMeta.ts)。

---

## 2026-06-18 · 图层面板：into 提示叠加浅蓝底 + 虚线框；frame 子节点间插入也高亮 parent

**What Changed**

把 `into` / `isIntoFrameHighlight` 的视觉再加强一版：

- **浅蓝底 `bg-info-bg` + 虚线框 `outline-info` 叠加**：之前只有虚线框 → 后来改成只浅蓝底（被默认行的 `hover:bg-bg-default` 抢） → 现在两者叠加 + `hover:bg-info-bg` 显式覆盖 hover，最显著且不会被 hover 状态吃掉。
- **新增：在 frame 子节点之间插入也高亮 parent frame**。之前只有 `effectiveIntent === 'into'` 才高亮 frame；现在 `before`/`after` 落到 frame 的某个 child 上（drop 仍然落在 parent frame 里）也会高亮 parent，配合 caret 一起读 = "在这个 frame 内、在这两行之间插入"。

**Notes**

- Rule 4（after panel-bottom child → 跳出 parent frame）仍然 NOT 高亮 parent，因为 drop 实际离开了 parent。
- 改动文件：[apps/web/src/components/Panels/CanvasLayerPanel/CanvasLayerTree.tsx](apps/web/src/components/Panels/CanvasLayerPanel/CanvasLayerTree.tsx)、[apps/web/src/components/Panels/CanvasLayerPanel/TreeRowItem.tsx](apps/web/src/components/Panels/CanvasLayerPanel/TreeRowItem.tsx)。

---

## 2026-06-18 · 节点删除/重命名：失败现在会通过 toast 告诉你

**What Changed**

之前节点删除或重命名（包括用户主动改名 + label 自动保存）一旦在服务端 `.md` 写盘失败，前端是**完全静默**的——画布上节点看起来已经删了/改名了，磁盘上要么留下孤儿 `.md`，要么保留旧文件名，但 UI 没有任何提示，下次刷新才会发现"回滚"了。

这一版做了两件事：

- **删除失败 → toast 错误提示**。服务端的 `deleteNode` 现在返回 `'deleted' | 'absent' | 'fs-error'`，DELETE 路由在 `fs-error`（Windows EPERM/EBUSY 之类）时返回 500 而不是假装成功。前端的 `canvasHistoryManager.trackDelete` / 撤销重做同步路径在收到非 abort 的失败时，弹出 toast：「Couldn't delete a node's file on disk — it may be locked by another process.」。
- **重命名失败 → 回滚到上一个文件名 + toast**。`nodeContentQueue` 在每次成功 PUT 后记录"服务端确认持久化的 `label`/`labelSource`"。任何非 409 的 PUT 失败如果当前 store 里的 `label` 已经偏离了上次成功值，会自动把 `label` 回滚到上次成功值（保留 content/src/summary，只回退 label），并弹 toast：「Couldn't rename node — reverted to "<旧名字>".」。如果失败的 PUT 没改 label（纯内容编辑失败）或这是节点的首个 PUT（没有"上次成功值"可回退），则只 toast 不动 store。

**Notes**

- 这层逻辑同样覆盖用户主动改名（图层面板 / frame 标题 / Header CanvasMenu）和后台自动保存（label 在节点上被外部代码改、agent 改名等）——`tryRename` 走的就是 `flushNow → serializedFlush → performSaveSafely` 同一条链路。
- 409 行为不变：用户主动改名遇到 sibling label 冲突仍然走 `tryRename` 自己的 toast warning + revert 路径，不会被双重提示。
- 改动文件：[apps/server/src/modules/storage/canvas-store.ts](apps/server/src/modules/storage/canvas-store.ts)、[apps/server/src/modules/canvas/canvas.route.ts](apps/server/src/modules/canvas/canvas.route.ts)、[apps/server/src/modules/canvas/canvas-executor.ts](apps/server/src/modules/canvas/canvas-executor.ts)、[apps/web/src/store/canvasHistoryManager.ts](apps/web/src/store/canvasHistoryManager.ts)、[apps/web/src/store/canvasStore/save/nodeContentQueue.ts](apps/web/src/store/canvasStore/save/nodeContentQueue.ts)。

---

## 2026-06-18 · External agent：打开对话不再 spawn；工具栏立刻可用；badge 默认 connected

**What Changed**

- 修复"打开 external agent 对话一直显示 Connecting"的问题。原因是 `8bc97a2f`（lazy session creation）之后，`useAcpSessionMeta` 不再在 mount 时发起 ensure，但 badge 状态机仍按"启动即尝试"设计，初始 `{updatedAt: 0, loading: false, error: null}` 落到 `'connecting'` 默认分支。
- 新增 `GET /api/acp/threads/:threadId/cached-meta?canvasId=...` 端点：read-only、**绝不 spawn agentlet**。优先返回内存 registry 的最新快照，否则从磁盘读取上次持久化的 meta，cache miss 时返回空快照（200，不报错）。
- `useAcpSessionMeta` 在 mount / threadId 切换时**先调用 cached-meta 端点 hydrate**：
  - **cache hit**（老 thread，磁盘上有上次会话的 meta）→ 工具栏的 model / mode / config option 下拉**立刻填充**，badge 直接 connected，**0 spawn**。
  - **cache miss**（新建 thread / 磁盘无快照）→ 自动 chain 一次真正的 `ensureAcpSession`：badge `connecting`（蓝呼吸）→ ensure 返回后立刻 `connected` 并填充工具栏；之后在后台按 200ms / 800ms / 2s / 4s 轮询 cached-meta，把 agent 异步推送的 `config_option_update` / `current_mode_update`（Copilot 冷启动通常要 1-3s）拾回来填到下拉里——**badge 不会因为这段后台轮询继续 connecting**。
- Badge 状态机：
  - 默认（有 cache 或 idle）→ `connected`（绿色静默点）
  - 真正 ensure 在飞 → `connecting`（蓝色呼吸）
  - 最近一次 ensure 失败且**没有任何 cached snapshot** → `failed`（红色"FAILED"）

**Notes**

- **Slash menu (`/`) 行为不变**：仍然在打开时触发 `ensureAcpSession`，那是用户的明确意图。
- 真正触发 spawn 的入口：发送消息 / 打开 `/` 菜单 / 切换 model · mode · config option / **新 thread 首次打开（自动）**。这些动作完成后服务器会把最新 meta 写回磁盘，下次打开同一 thread 立刻可用（cache hit 路径，0 spawn）。
- 设计意图：**只要看到过一次的 thread 就不再 spawn**；新 thread 主动 spawn 一次把"启动开销"摊到首次开启，之后永远走 cache。
- 改动文件：`packages/shared/src/types/api/acp.ts`、`apps/server/src/modules/agent/acp/threads.route.ts`、`apps/web/src/api/_routes.ts`、`apps/web/src/api/acp.ts`、`apps/web/src/hooks/useAcpSessionMeta.ts`、`apps/web/src/components/Panels/ChatPanel/index.tsx`、`apps/web/src/components/Panels/ChatPanel/AcpConnectionBadge.tsx`。

## 2026-06-17 · Frame 拖拽：贴边即可放入，frame 内移动不再容易飞出

**What Changed**

- **拖拽节点到 frame 边缘也能放进去了。** 以前需要节点的 bbox 与 frame 至少有 50% 重叠才会被认定为"放入"，导致贴边或把比 frame 还大的节点拖入时不生效。现在只要**鼠标进入 frame 且节点与 frame 有任何正向重叠**即可放入，原本的 50% 面积重叠规则作为无指针位置时的兜底依然有效。
- **在 frame 内部移动子节点不会再被轻易"挤出去"了。** 以前节点的 bbox 一旦完全越出 frame 边界（且边距超过 10px）就会被解除父子关系，连带"用户只是想在 frame 里调整位置"也会被误判。现在 free-mode frame 也获得了一个**逐轴的指针捕获 halo**：halo 半径按 `max(24px, 节点尺寸 × 0.3)` 计算（横纵分别算），节点越大粘性越强；只要鼠标仍在 frame 或其周围 halo 范围内，节点就保持在 frame 里。结构化（`column` / `row`）frame 原有的 capture zone 保持不变。
- **拖拽预览同步对齐新规则。** 实时的 frame fit 虚框与"结构化 frame 插入位置 caret"都改为使用同样的指针感知判定，**所见即所得**——预览出现的时刻就是松手会真正生效的时刻。

**Notes**

- 实现层面：在 `wouldAutoFrame` / `wouldUnframe` / `autoFrameNodeByOverlap` / `autoUnframeNodeByNonOverlap` 这一组 frame 检测/变更原语上新增了可选的 `pointer` 与 `pointerCaptureMargin` 选项（后者支持 `number` 或 `{ x, y }` 两种形式以表达逐轴的 halo）；resolver (`resolveNodeDragStop`) 与画布拖拽预览 (`canvasStore` 内 `onNodeDrag` 的双 rAF 块) 都改为传入当前鼠标的 flow 坐标，并按 `max(FRAME_POINTER_CAPTURE_MARGIN, 节点尺寸 × 0.3)` 逐轴计算 halo。
- 新增常量 `FRAME_POINTER_CAPTURE_MARGIN = 24`（导出自 `@sediment/shared/canvas-engine`），作为 halo 的**下限**；想全局调整最小粘性距离只需改这一处。
- 不带 `pointer` 调用时所有原语行为完全保持不变，向后兼容；既有的 `margin: 10` 体积溢出兜底规则也保留。
- 改动文件：`packages/shared/src/canvas-engine/{utils/constants.ts, frame/{geometry,mutation,detection}.ts, index.ts}`、`apps/web/src/handler/canvasCommand/resolvers/resolveNodeDragStop.ts`、`apps/web/src/store/canvasStore.ts`；新增测试 `packages/shared/src/canvas-engine/frame/__tests__/pointerDrop.test.ts`。

---

## 2026-06-22 · Settings 中的 Provider 区块可折叠

**What Changed**

- **Settings 里的「LLM Provider」和「Image Provider」两个区块现在可以折叠**。区块标题右侧加了一个 ghost chevron 图标，点击标题（或图标）整张卡片就会收起 / 展开，方便在配置项较多时快速浏览。
- 默认是**展开**状态，所以打开 Settings 看到的内容和以前一样，需要折叠时再手动收起即可。

**Notes**

- 折叠状态目前不会持久化 —— 关掉 Settings 再打开会重新回到展开。
- 这是 `SettingSection` 通用组件的能力（新增 `collapsible` / `defaultCollapsed` 两个可选 prop），其他 Settings 区块（如 Canvas、External Agents）保持现有行为不变。

---

## 2026-06-18 · 从 chat 拖拽 AI 生成的图片到画布会直接建图片节点

**What Changed**

- **在 chat 面板里，把 AI 回复中的图片块拖到画布上现在会创建 image 节点**，而不是像以前那样创建一条包含 `![](src)` 原始 markdown 的 note 节点。比如让 AI 「画一只穿宇航服的猫」并拿到一张图，用 Crepe 的块拖拽手柄把它拖到画布上，就会得到一个原生的图片节点，可以直接调整尺寸、做为后续 AI 调用的视觉参考。
- 拖拽逻辑会先识别**整块是否只是一张图片**：纯 `![alt](src)` 走 image 节点；混排（图片 + 文字、列表里嵌图、外面包了链接 `[![](src)](href)` 等）依然走 note 节点，避免丢失上下文。
- 如果图片指向当前画布的 artifact（被 `rewriteChatImageUrls` 展开过的 `/api/canvas/<id>/artifact/<key>` URL），新建的 image 节点会把 `data.src` 还原成裸 key `art_xxx.png`，与上传 / 粘贴产生的图片保持同一存储形式；指向其他画布或外部 URL 的图片则保留绝对地址。

**Notes**

- 拖拽时按住 Shift 仍然是「MOVE」语义，但 chat 卡片本身是只读的（没有可写入的 source node），所以 Shift 在此场景下等价于 Copy。
- AI 回复中的图片 alt 文本会作为新 image 节点的 `label`；alt 为空时 label 留空，由后续的 preprocess 流程自动生成标题。

---

## 2026-06-18 · Settings 拆成 LLM Provider + Image Provider，输入即保存

**What Changed**

- **「Image Provider」从「LLM Provider」里独立出来**，现在是两个完全分开的 Settings 区块，凭据互不影响：
  - **LLM Provider** — 驱动聊天 (`llmStream` / `llmComplete`)，可以是 OpenAI / Anthropic / GitHub Copilot / Azure …
  - **Image Provider** — 驱动 `generate_image` 工具，目前只支持 Azure OpenAI，但 endpoint / deployment / API version / API key 都是独立保存的。
  - 这样就可以「聊天用 GitHub Copilot，生图用 Azure」之类的组合，不用为了生图把聊天 provider 切到 Azure。
- **删除所有 Save 按钮，所有输入框现在都是输入即保存**（debounce 600ms）：
  - 文本输入 / 密码输入 — 你停止打字 600ms 后自动保存；
  - 下拉菜单（Provider / Model / Quality） — 选择后立即保存；
  - API Key 字段为空时不会触发保存（避免误清空已存的 key）。
- 服务端会自动迁移老配置：原来存在 `providers["azure-openai"].imageModel` 下的 `imageModel` / `imageQuality` 字段会被搬到新的顶层 `imageConfig`，并复用原 Azure chat 的 endpoint / apiVersion / apiKey 作为默认值。下一次保存时老字段会被自然清掉。

**Notes**

- 新增两个 API endpoint：`GET /api/llm/image-config`、`PUT /api/llm/image-config`，仍受 loopback-only 保护。
- 共享类型层面：`LLMConfig` 现在只承载聊天字段（移除了 `imageModel` / `imageQuality`），图片字段移到了新的 `LLMImageConfig`。
- 图片 provider 目前只有 Azure 一个选项，但 UI 已经按下拉菜单方式设计，未来加 OpenAI native / Replicate 等不需要再改 UI 结构。
- 如果同时在快速修改多个输入框，每个字段会各自单独发送一次保存请求（不会合并），按 600ms 各自防抖。

---

## 2026-06-18 · Settings 里可调图片生成质量（图片预览统一走 markdown）

**What Changed**

- **Settings → LLM Provider → Azure OpenAI 新增「Image Quality」下拉菜单**，可选 `low / medium / high / auto`：
  - `low`（默认）— 最快最便宜，适合日常对话；
  - `medium / high` — 出图更精细但更慢、成本更高；
  - `auto` — 让 Azure 自己决定。
    Agent 调用工具时也可以通过 `quality` 参数临时覆盖默认值。
- 同时也修了：之前 AI 写在 chat 里的 `![](art_xxx.png)` markdown 不会渲染，因为 `art_xxx.png` 是裸 artifact key，浏览器不知道怎么解析；现在 chat markdown 渲染前会自动把裸 key 转成完整的 `/api/canvas/<id>/artifact/<key>` URL。这样 AI 在回复里写一句 `![](art_xxx.png)` 就能看到图。

**Notes**

- `generate_image` 工具调用本身在 chat 里的展示和其他通用工具一致（紧凑 pill 显示标题 + 状态），没有专门的大缩略图卡片——图片预览统一通过 AI 在文本中插入 markdown 的方式呈现。
- 修改 quality 设置后立即对**下一次**生成生效，已生成的图片不受影响。

---

## 2026-06-18 · AI 现在可以直接为你生成图片并加到画布

**What Changed**

- **AI 助手新增两件工具：`generate_image` 和 `rasterize_node`。** 你可以直接在对话里让 AI 生成图片（例如「帮我画一只穿宇航服的猫，加到画布右下角」），AI 会调用 Azure OpenAI 的 `gpt-image-1` 生成图片，然后通过既有的 `canvas_commands` 把图片节点放到你指定的位置。
- **AI 能把画布上已有的内容作为参考图**。如果你说「参考这张涂鸦，把它改成水彩风格」并选中一个 sketch 节点，AI 会先用 `rasterize_node` 把 sketch / image / pdf 封面光栅化成 PNG，再喂给 `generate_image` 当视觉参考。支持参考的节点类型：`image` / `video`（直接复用原图）、`pdf`（用封面图）、`sketch`（服务端实时把笔迹渲染成 PNG）。
- **Settings → LLM Provider → Azure OpenAI 新增「Image Deployment」输入框**。需要在这里填入你的 `gpt-image-1` 部署名，AI 才会启用 `generate_image` 工具。

**Notes**

- 这个能力目前**仅支持 Azure OpenAI**。其他 provider（Copilot / Anthropic 等）的 chat 模型即使支持图片生成，也暂未接入这条管线。
- **图片部署和聊天部署是两个不同的 Azure 部署**：聊天用的 `Deployment` 字段不变，图片走新加的 `Image Deployment` 字段。这两个字段共用同一组 Endpoint / API Key / API Version。
- AI 生成的图片会写入当前画布的 `.artifacts/` 目录，与你自己上传的图片采用同一套存储和清理机制；删除节点后随画布的常规清理流程一起回收。
- 当前不支持把整个 `frame` 节点光栅化作为参考；如果需要参考一组节点，让 AI 分别参考其中的图片或 sketch 子节点即可。
- 对 `note` / `text` 节点 AI 不会把它们渲染成图片，而是直接读取其 markdown 文本写进 prompt——文字不适合当成视觉参考。

---

## 2026-06-17 · 桌面端 / 网页端 Logo 升级为带圆角白底的新版

**What Changed**

- **桌面端窗口图标、Dock 图标、安装包图标（`.icns` / `.ico` / `.png`）和网页端 favicon 全部更新为新版 Logo**：在原来的彩色圆点 + 黑色哑铃图形外，新增了圆角白底背景，整体观感更接近 macOS / Windows 原生应用图标的视觉层级。
- 之前 `apps/web/public/favicon.svg` 已经升级到新版，但同目录下的 `favicon.png` 和 `apps/desktop/build-resources/` 中三个二进制图标文件（`.icns` / `.ico` / `.png`）从未根据新 SVG 重新生成，导致打包后的桌面应用在 Dock / 任务栏 / 标题栏依旧显示旧版 Logo。
- 新增 `apps/desktop/scripts/build-icons.mjs` 脚本，使用 `sharp` + `png2icons` 把 `apps/desktop/build-resources/logo.svg` 一键转换为所有目标平台所需的位图格式；今后调整 Logo 时只需要更新这个 SVG，然后执行 `pnpm --filter @sediment/desktop run icons:build` 即可同步所有平台的图标。

**Notes**

- macOS Dock 在首次启动新版应用时可能依旧显示缓存中的旧图标，可执行 `killall Dock` 或重新登录账户清除缓存。
- Windows 资源管理器同样存在图标缓存（`IconCache.db`），如有需要可通过任务管理器重启 `explorer.exe` 刷新。
- 浏览器端 favicon 的更新依赖浏览器缓存策略，必要时使用强制刷新（Cmd/Ctrl + Shift + R）。

---

## 2026-06-17 · 桌面端画布标题旁恢复 Logo

**What Changed**

- **桌面端（Electron）画布页面的 `CanvasHeader` 现在会在画布名称（如 "测试"）左侧重新显示站点 Logo**。之前为了避免与窗口标题栏 `WindowChrome` 顶部的 Home 图标重复，桌面端隐藏了这个 Logo，导致浮动 / 内嵌头部和网页端样式不一致。现在两端表现一致，Logo 始终可见。

**Notes**

- 网页端外观不变。
- 桌面端窗口标题栏顶部的 Home 房子图标依然保留——现在标题栏和画布头部各自有一个返回首页的入口，两者都链接到 `/`，使用上等价。

---

## 2026-06-17 · 节点配色统一为单一 accent 字段

**What Changed**

- **节点颜色现在只有一个旋钮：`style.accent`**。原来分开的 `style.backgroundColor`（SURFACE_PALETTE）和 `style.textColor` 字段已被移除，所有节点（note / text / frame / question / 图片 / pdf / 网页 / sketch）的边框、填充和文本色都由同一个 accent token 同时驱动（边框 50% / 填充 10% / 文本 60% 的 `color-mix`）。
- **浮动工具栏的色板从 9 色精简为 7 色**：去掉只供 sketch 笔触使用的纯黑 / 纯白条目（grey / red / orange / amber / green / blue / purple）。Sketch 节点的画笔色盘保留黑白，因为画线需要不依赖填充的纯色。
- **AI agent 改颜色更可预测**：`canvas_commands` schema 同步收窄到只接受 `style.accent`，并且 `MERGE_NODE_DATA` 在合并 `data.style` 时改为深合并一层——AI 只想改 accent 时不会再把用户设置的 `fontSize` / `fontFamily` 等同级字段清空。
- **修复 NoteNode 只有边框上色、填充不变的 bug**：之前 Note 走的是单独的 white-accent hack，现在改成与 TextNode / FrameNode 共用 `NodeWrapper` 的统一上色路径。

**Notes**

- **历史数据兼容**：旧画布里残留的 `style.backgroundColor` / `style.textColor` 会被静默忽略——节点不会崩溃，但会回退到无 accent 的默认外观；用户重新从工具栏选一次颜色即可恢复。原来的 `accent: 'white'` 在新模型里会渲染成几乎不可见的浅色（白色与白底 mix），建议改选 `grey` 或清空。
- **QuestionNode 的浅黄背景没有变**：它现在通过 `NodeWrapper` 新增的 `fillColor` escape hatch 注入固定色，不再借用 `style.backgroundColor` 通道。
- AI 提示词里关于 "colored shadow on bottom-right" / "top stripe" / `cyan` 示例等错误描述已一并修正为实际的 7 个 token。

---

## 2026-06-17 · 画布节点边缘 resize 命中区扩大

**What Changed**

- **画布节点 4 条边的 resize 命中区从默认的 1 px 扩大到 8 px**。之前 `@xyflow/react` 的 `NodeResizer` line 控件只有 1 px 宽的透明命中条，极难精准抓取边缘；现在边缘上下/左右各有 8 px 的可点击区域，鼠标更容易拖动改变节点宽高。
- 4 个角点（corner handle）尺寸不变（鼠标 8 px / 触屏 12 px），多选 bounding box resizer 也不受影响。

**Notes**

- 改动仅在 `apps/web/src/index.css` 覆盖 `.react-flow__resize-control.line.*` 的 width/height，**视觉无变化**——边框依旧由组件层 `lineClassName="!border-transparent"` 隐藏，只是隐形的可点击区域更大。
- 如果未来感觉 8 px 还不够，可继续把这两条规则调到 10 px / 12 px。

---

## 2026-06-10 · Agent profiles are templates; sessions are lazy

**What Changed**

- 选择外部 Agent 时**不再立即创建 agentlet session**——Agent profile 现在是纯模板（`agentletId, cmd, cwd`），只有在真正发送消息或打开 `/` 命令菜单时才会懒创建 session。
- **`appId` 简化为 `threadId`**——每个对话线程拥有自己的 session，无需再拼接 `canvasId:threadId`。
- **空闲自动挂起 + 恢复**——agentlet daemon 会在 10 分钟无活动后自动挂起 session（`idleTimeoutSecs = 600`）；下次发消息时通过 `spawn({ sessionId })` 透明恢复，无需手动管理生命周期。

**Notes**

- 此变更是 session/agent 模型对齐讨论的结果：profile = 模板，session = 按需创建，canvas 不关心 session 生命周期。
- 还原了 `c9ea5ee` 中的 `bindingThreadMap` / `switchToBinding` 实现（方向不一致）。

---

## 2026-06-10 · Canvas agent 可以直接读图片节点

**What Changed**

- **Canvas agent 的 `read` 工具现在会把 image artifact 作为 vision 内容内联返回**（仅限光栅图：png / jpg / gif / webp / bmp）。之前 agent 只有在用户**选中**了 image 节点时才能看到图（走 selection → vision attachment 那条路），现在 agent 自己 `read("nodes/<label>.md")` 拿到 frontmatter 里的 `src`、再 `read(src)` 就能直接看图，不需要用户先选中。
- PDF / video / SVG 之外的二进制（archive / 编译产物等）仍然按"binary, refused"处理；SVG 走文本路径保持不变。

**Notes**

- 对模型侧无感升级：vision-capable 模型自动收到 `ImageContent` part；不支持视觉的模型会被 pi-ai 的下游转换降级为占位文本，不会报错。
- 改动文件：`apps/server/src/modules/agent/tools/handlers/fs-read.ts`、`executor.ts`、`index.ts` 以及 `prompt/skills/canvas/SKILL.md`。

---

## 2026-06-10 · Edge Label 失焦后边框颜色和边线保持一致

**What Changed**

- **新建 edge label 失焦（commit）之后，pill 边框颜色现在会和这条边的实际线条颜色一致**。之前对没有显式设置 `stroke` 的默认 edge，pill 在失焦后边框会回退到 info 蓝（`var(--color-info)`），而 SVG 线条实际是 React Flow 的灰色默认 (`#b1b1b7`)，两者对不上；现在 fallback 改成 React Flow 自身的 `--xy-edge-stroke` 默认 token，所以颜色完全跟随 SVG path 渲染结果。
- 已经显式选过 palette 颜色的 edge 行为不变（之前就会跟随）。
- 选中或正在编辑时仍然显示 info 蓝边框，与 `.react-flow__edge.selected` 的 stroke 高亮保持一致，未做改动。

**Notes**

- 仅影响 [LabelledEdge.tsx](apps/web/src/components/Panels/Canvas/edges/LabelledEdge.tsx) 中的 `borderColor` 计算，不涉及数据层或持久化。

---

## 2026-06-10 · Question 节点在 running 阶段也能在 chat panel 中打开

**What Changed**

- **Question 节点进入 `running` 状态后，工具条上的「View conversation」按钮和状态徽章都直接可点**（之前只在 `done` / `error` 才出现），点击后右侧 chat panel 会切到这个 question 的 thread，可以实时看着模型回复一点点流出来。
- 双击 running 的 question 节点也会直接打开对话面板（之前 running 阶段双击是无效的，因为既不能编辑也没法看回答）。
- 在 running 状态下按钮 / 徽章 hover 时显示的提示从 "Open conversation" 改为 "Watch live conversation"，更清晰地表达「现在过去会看到流式更新」。
- 配套调整 `viewed` 标记的时机：以前 `openInChat` 在任何阶段都会立刻把 `viewed` 置 true，导致用户在 running 阶段开了一眼又关掉之后，run 完成时不会再有「done · unread」呼吸光提示。现在改成：
  - `done` / `error` 时打开 → 立刻 `viewed = true`（和以前一致）；
  - `running` 时打开 → 不动 `viewed`；改由 runner 的 `onComplete` 检查「用户当前是否还在看这个 thread」，是则置 true，否则留 false，让呼吸光照常出现。

**Notes**

- 实现上 chat panel 这边不需要新增任何逻辑：`useChatHistory` 早就会先 fetch 已经持久化的 user 消息，再检测到 "最后一条是 user 消息" → 通过 `agentApi.reconnectStream` 接回正在跑的 SSE 流，所以打开 running thread 时会自动接上流式输出。
- 取消（Cancel）按钮在 running 阶段仍然存在，仍可中断当前回答。
- 这条对应改动文件：`apps/web/src/components/Nodes/question/QuestionNode.tsx` + `apps/web/src/hooks/useQuestionRunner.ts`。

---

## 2026-06-10 · Question 节点新增 Shift+Enter 快速执行快捷键

**What Changed**

- **编辑 Question 节点时按 `Shift+Enter` 直接提交并立刻执行**，跳过原本的自动倒计时（默认 ~10s），让用户在确认问题已经写完时可以一键开跑。
- 行为细节：先把当前 draft 写回节点（如果有变化），然后把节点状态切到 `pending` 并把 `runAt` 设为当前时间，`useQuestionRunner` 会马上拉起执行；同时退出编辑模式。
- 同时为该快捷键加了一道防护：触发 `Shift+Enter` 之后，textarea blur 不会再覆盖刚刚写好的 `runAt`（否则会被改回 `now + delay`）。
- 在 `?` 快捷键面板和 docs 的 Keyboard Shortcuts 页 "AI" 分类下新增了这条快捷键说明，文档的 Question 节点 Workflow 步骤里也补了一句提示。

**Notes**

- 普通 `Enter` 行为不变，仍然是在 textarea 里插入换行。
- 当 `@` mention 菜单展开时，`Shift+Enter` 仍然会直接提交并执行；如果想先选择 agent，请用 `Enter` 或 `Tab` 接受高亮项。
- 如果当前 draft 为空（trim 后为空字符串），`Shift+Enter` 不会触发任何动作，避免空问题进入 pending。

---

## 2026-06-08 · 边 label 的交互与外观调整

**What Changed**

- **选中边后会在边中点显示一个实线 label 占位框**，框内用浅色 "Add label" 提示文字。占位框和真正写有 label 的框是同一个 DOM 节点（占位文字由 CSS `::before` 渲染），所以两种状态下框的尺寸完全一致，不会"选中后变形"。
- **进入编辑的两种方式**：
  - 边选中、label 还没写时 —— 单击占位框 → 直接 focus 编辑；
  - 任何状态下 —— 双击边本身（不是节点 / 空白处） → 一步进入编辑。已有内容的 label 框保留"单击不动 / 双击编辑"，避免在画布上选边时误触清光文字。
- **Label 框的边框样式跟随它所属的边**：边框颜色 = 边的 stroke 颜色，边框粗细 = 边的 strokeWidth（在 1–3px 之间 clamp，避免 8px 粗边带出 8px 粗框）；选中 / 编辑时统一切到 `--color-info` 蓝（和 React Flow 选中边的描边颜色一致）。
- **边样式工具条不再压住 label 框**：浮动工具条相对边中点的偏移从 12px 提到 36px，工具条和 label 框之间始终有清晰的留白。
- **Label 框宽度自适应内容**，超过 ~120px 才折行（用 `whitespace-pre-wrap break-words`），不会再被钉死成长条；Shift+Enter 仍可强制换行。

**Notes**

- 单击进入编辑只在"占位框"状态生效（即边选中且 label 仍为空）。如果 label 已经有文字，单击只保持选中状态。
- 双击进入编辑依赖 React Flow 的 `onEdgeDoubleClick`，通过 `sediment:edit-edge-label` window 事件通知对应的 `LabelledEdge` 进入编辑模式；点到节点 / 空白处行为完全不受影响。
- 占位文字"Add label"由 `.sediment-edge-label:empty:not(:focus)::before` 渲染。`textContent` 不会包含 `::before` 内容，所以不会污染 label 提交到 store 的字符串。

---

## 2026-06-08 · macOS 全屏时收起标题栏左侧的"红绿灯"留白

**What Changed**

- **macOS 桌面端进入全屏（绿灯按钮 / `⌃⌘F`）时，标题栏左边给红绿灯按钮预留的 76px 空白会自动收起**，Home 按钮贴回到窗口的左边缘（保留 8px 内边距，和 Windows 一致）。
- **全屏切换的过程中先把 Home 按钮整体淡出再淡入**，避免动画进行时按钮和移出 / 移回的红绿灯叠在同一像素上：`resize` 事件触发后立刻把 `opacity` 切到 0（无过渡），尺寸稳定 ~180ms 后再带 180ms 淡入。
- 实现方式：主进程 `enter-full-screen` / `leave-full-screen` 通过新加的 `window:fullscreen` IPC 通道 + `electronBridge.window` 暴露给 renderer，渲染层根据当前全屏状态切换 `paddingLeft`；同时监听 `resize` 做 debounce 触发上面那段淡出 / 淡入。

**Notes**

- 仅影响 macOS。Windows 的标题栏按钮在全屏下不会被系统隐藏，留白逻辑不变；Linux 当前没有自定义关闭按钮，也不受影响。
- 普通的"最大化（Cmd + 绿灯）"不会进入沉浸式全屏，红绿灯仍然显示，留白保持 76px，行为与之前一致。

---

## 2026-06-08 · 左侧图层面板新增「外部 .md 文件」提示

**What Changed**

- **选好 workspace 后，服务端会持续监听每个画布目录下的 `nodes/*.md`**：用户在 Finder / 终端 / 其他编辑器里手动拖一个 `.md` 进 `<canvas>/nodes/` 后，左侧图层面板的列表顶部会立刻出现一行**灰色斜体的占位项**（图标 + 文件名）。
- **悬停时该行右侧出现 `+` 按钮**，点 `+` 或者**双击整行**即可一键导入：服务端读取文件内容、删除原 `.md`、客户端走和"工具栏上传 .md"完全相同的 `addNodes` 路径生成一个 note 节点。
- **冷启动也算**：选 workspace 时如果已经有未导入的 `.md`，下次打开画布就会直接看到提示项；无需重启。
- **外部新增的速度受 1.5s 的稳定窗口控制**：编辑器多次保存或拖文件中途生成的临时文件不会重复触发，仅在写完文件稳定后才出现提示。
- 切换画布 / 切换 workspace 时自动断开旧的 SSE 连接、对新的目录重新订阅。

**Notes**

- 只处理**新增** `.md`：外部修改已存在的 node 文件不会触发提示（节点本身已有 Milkdown 编辑器同步内容）。
- 删除外部新增的 `.md`（在导入之前）会自动从列表移除；删除已导入的节点的 `.md` 走原有兜底逻辑，无新增行为。
- 文件的 frontmatter 里如果带 `id:` 且这个 id 已经在当前画布的节点列表里出现过，会被认作"app 自己写出去的文件"，不会重复提示。
- 仅监听 `<workspace>/<canvasDir>/nodes/*.md` 一层，不会递归扫描更深的目录，避免与 `.artifacts/` `.history/` 等隐藏目录互相干扰。

---

## 2026-06-08 · 从笔记拖内容到画布：新增「按 Shift 移动」（默认保持复制）

**What Changed**

- **从笔记里拖一个 / 多个 block 到画布空白处，默认保持原来的「复制」行为**：被拖出的内容会落地为一个新的 note 节点，**源笔记保持不变**。这是无破坏性默认值，符合"拖出来的是副本"的直觉。
- **按住 Shift 拖** 切换为「移动」：新 note 出现在画布上，**同时从源笔记中删除**该段内容。
- 拖动过程中 **鼠标光标会区分 copy / move**：未按 Shift 时显示 copy 指针（→ 带加号）、按 Shift 时显示 move 指针（→ 不带加号）。
- **「移动」是一次撤销**：⌘Z 一次性恢复源笔记内容并销毁新 note，不需要按两次。
- 支持多 block 移动（含列表中间的若干项）：源笔记会按拖出的范围精准缩减，新 note 包含完整的多块内容。
- 同步修复了 **Shift+点击块手柄拖拽根本不启动** 的问题 —— 浏览器原本把 Shift+click 解释成"扩展文本选区"，会中断拖拽；现在在块手柄上侦测到 Shift 时会调用 `preventDefault` 抑制该默认行为，Crepe 自己的 NodeSelection 派发和 `draggable=true` 触发的拖拽均不受影响。
- 从 **AI 聊天卡片** 拖出始终是复制（聊天消息不可编辑，没有"源"可以从里头移走），Shift 在这一侧无效。

**Notes**

- 「移动」的源笔记被拖空后 **不会被自动删除** —— 留一个空 note 给用户自行处理，避免误删。
- 「移动」的源内容快照是在 _拖拽开始时_ 算好的；如果在拖拽过程中（极短时间窗口内）外部更新了源笔记，drop 时仍以拖拽开始那一刻的视图为准 —— 用 ⌘Z 即可还原。
- Shift 是在 _drop 那一刻_ 生效的：如果点击块手柄时不方便先按 Shift，也可以先开始拖拽，半路再按住 Shift，松手时即为移动。
- Web 浏览器和 Desktop 应用行为完全一致，无 Desktop 专属代码。

---

## 2026-06-08 · Bugfix：Settings 现在可以完整配置 Azure OpenAI 了（#220）

**What Changed**

- **修复 Settings → LLM Provider 切到 Azure OpenAI 报「Model is required」、且选中的 Provider 被悄悄回滚到之前那个的问题**。Azure OpenAI 没有内建模型列表（模型名是用户自己的 deployment 名），原先前端在切 Provider 时会立刻用空 model 调一次 `PUT /api/llm/config`，服务端 schema 校验直接 400 退回，导致 Provider 切换看起来没生效。`PUT /api/llm/config` 的请求体现在允许 `model` 为空字符串，先把 Provider 落到本地、再让用户继续填后面的字段。
- **Settings 里新增 Azure OpenAI 专属配置区**：选中 Azure OpenAI 后会出现四个字段并一次性 Save：
  - **Endpoint** — 例如 `https://my-resource.cognitiveservices.azure.com`，留空时回退到旧的 `AZURE_OPENAI_API_ENDPOINT` 环境变量。
  - **Deployment** — Azure 上的 deployment 名（例如 `gpt-5-chat`），同时也用作模型 id。
  - **API Version** — 例如 `2025-04-01-preview`；留空时使用 pi-ai 默认的 `v1`。
  - **API Key** — Azure 资源的 key；之前已经 Save 过的话留空即可保留。
- **后端在调 LLM 时会把这些值作为 `azureBaseUrl` / `azureApiVersion` / `azureDeploymentName` 透传给 pi-ai 的 Azure provider**，不再依赖 `process.env.AZURE_OPENAI_*` 才能用。原先服务端会在 baseUrl 上硬拼一个 `/openai` 后缀，新版 pi-ai 会自己规范化路径并加 `/openai/v1`，所以这个手动后缀拿掉了，避免变成 `/openai/openai/v1`。
- **同一 Provider 内做局部更新时会合并已保存的字段**：例如只改了 Deployment、没重填 API Key / Endpoint / API Version，之前保存的那些值会被保留，不会被这次 PUT 清空（之前只有 `apiKey` 走合并逻辑）。
- **`llm-config.json` 现在按 Provider 分桶保存**：切换 Provider 不再覆盖上一个 Provider 的字段。例如先配好 Azure，再切到 OpenAI，再切回 Azure —— Endpoint / Deployment / API Version / API Key 仍在，不用重填。每个 Provider 自己的 model 选择也会被记住（OpenAI 选过的 model、Anthropic 选过的 model 等切换时各自恢复）。
- 旧版 `llm-config.json`（单一 active 配置的扁平结构）会在下次保存时自动迁移到新结构，无需手工处理；活跃 Provider 由顶层 `active` 字段标记，每个 Provider 的字段挂在 `providers[providerId]` 下。
- **切到一个还没配置过的内建 Provider 时，服务端会自动挑该 Provider 模型列表里的第一个作为默认 model**（这条逻辑从前端搬到了后端，跟"恢复已保存 model"走同一条路径，避免前端强行用第一个 model 覆盖之前的选择）。

**Notes**

- 旧的 `AZURE_OPENAI_API_ENDPOINT` / `AZURE_OPENAI_API_VERSION` / `AZURE_OPENAI_API_DEPLOYMENT_NAME` / `AZURE_OPENAI_API_KEY` 环境变量在 Settings 里 _没填_ 对应字段时仍然作为兜底；填了就以 Settings 的值为准（每次请求都走 Settings 里的 Endpoint / API Version / Deployment）。
- 切换 Provider **不再**清掉旧 Provider 的 baseUrl / apiVersion / apiKey；它们各自保留在 `providers[providerId]` 桶里，对当前活跃 Provider 没有副作用（resolveApiKey 只看 active 的字段）。
- Azure 之外的 Provider 不受影响：仍然是 Provider → Model → API Key 三行。

---

## 2026-06-08 · Edge 支持文本 Label（人 / AI 都能加）

**What Changed**

- **Edge 现在可以挂一段文本 Label**，会渲染在线段中点上、带浅色背景的圆角胶囊里。
- **在边上双击直接编辑**：选中 edge → 中点出现虚线"Add label"占位 → **双击**进入编辑态、键入文字 → 单击别处（失焦）即提交保留；Enter 也提交，Shift+Enter 插入换行，Esc 撤销，清空即删除 Label。已有 Label 的边再次双击即可继续改字。Label 跟随画布缩放/平移，与边的路径始终对齐。
- **查看态与编辑态共用同一个元素**（`contentEditable` 切换），字体 / 间距 / 边框 / 宽度逐像素一致 —— 进入编辑模式不会出现宽度跳变。
- **超长文本自动换行**：胶囊最宽 200px，长文字会按词换行（`break-words` + `whitespace-pre-wrap`），不会撑出去把画布挤偏。
- **背景色 / 边框色跟随边的选中态**：当 edge 选中或正在编辑时，Label 胶囊的背景和边框统一变成 info-bg / info border —— 与选中 edge 的高亮颜色一致；未选中时回到浅 surface 背景 + edge-default 边框，安静不抢戏。
- 浮动工具栏不再有 Label 输入框（编辑入口完全搬到边本身）。
- **AI 也能加 Label**：`CONNECT_NODES` / `SET_EDGE_STYLE` 命令的 `style` 参数里新增了 `label` 和 `labelSource` 字段。Agent 传非空 `label` 时，服务端会自动把 `labelSource` 标成 `'agent'`（除非显式给了别的值），与 node label 现有的 user / agent / auto 来源体系保持一致。
- **`inspect_edges` 工具的返回值新增 `label` / `labelSource` 字段**，并新增 `byLabel` 谓词（大小写不敏感子串匹配），方便 agent 找"所有写着 'blocks' 的边"之类的场景。
- Edge label 持久化在 `canvas.json` 的 `edges[].data.edgeStyle.label`，与其它 EdgeStyle 字段同路径，复制粘贴 edge 也会一并复制 Label。

**Notes**

- Label 上限 120 字符；超过会在提交时被截掉，避免被粘贴超长内容时把画布卡住。
- 没有 Label 的边在未选中时保持视觉干净（不显示任何占位）；选中后才会浮出"Add label"虚线提示，避免画布上一堆空胶囊。
- 清空 Label 时，`labelSource` 也会被一并清掉；下一次有人 / agent 重新设置时再重新打标记。
- 旧的 edge 没有 Label 字段，不需要迁移；什么时候被设置过才会出现在 inspect 结果里。
- 历史 edge 因为以前 `applyEdgeStyle` 给它们打了 `default` / `straight` / `smoothstep` 这些 React Flow 内建 type，本次同时把这三个内建 type 也接管到新的自定义 edge 组件，所以老 edge 也能在边上直接编辑 Label，不需要重建。

---

## 2026-06-08 · Chat 面板：刷新后记住上次选的模式（Chat / Agent）

**What Changed**

- **Chat 面板顶部的模式切换（Chat / Agent，对应内部的 `ask` / `operate`）现在会跨页面刷新保留**。之前刷新后总是回到 Chat，即使当前 thread 之前一直在用 Agent 模式跑；现在会读取持久化在本地的 `lastAction`，恢复到上次离开时的模式。
- **从「+ New Chat」菜单里选 Agent / Chat 起新会话时，新 thread 会直接以所选模式起步**。原先内部状态会先被重置为 Chat、再被本地 React state 覆盖回 Agent，刷新一次就会暴露这个不一致；现在选什么就持久化什么，刷新表现一致。
- **Intent 弹窗里选中一个意图自动跑 Agent 时**，模式切换条会立刻并持久地变为 Agent，刷新后仍然停留在 Agent。

**Notes**

- 这是一次纯 UX 修复，不影响消息历史或 agent 绑定逻辑。1 thread = 1 binding 的约束没有变。
- 模式按"上次使用"全局记忆（与 zustand `persist` 里其他字段一致），不是按 canvas / thread 分别记。在 canvas A 里切到 Agent 后，回到 canvas B 也会先显示 Agent；点 + 新建一条 Chat 会话就会恢复 Chat 模式。

---

## 2026-06-05 · Web 节点 Preview：自动判断 Live / Reader，去掉切换条

**What Changed**

- **去掉 Preview 面板顶部的 Live / Reader 切换工具栏**。视图模式现在完全自动判断，不再需要用户操作：
  - **桌面端**：永远先用 live iframe 加载真站。主进程已经剥掉 `X-Frame-Options` / CSP `frame-ancestors`，几乎所有站点都能正常嵌入。
  - **纯浏览器**：服务端预处理时**主动嗅探响应头**（`X-Frame-Options` / CSP `frame-ancestors`），存到节点 metadata 的 `embeddable` 字段。前端拿到 `embeddable: false` 就直接跳到 Reader，不会让用户对着空白 iframe 干等。
- **二次保险：浏览器里 live 加载 3.5 秒还没成功就静默切到 Reader**。覆盖那些预处理时未抓到头（比如旧节点、CDN 缓存）但实际仍然拒嵌的站点。Reader 永远预先加载好，所以切换是瞬间的。
- **新增右上角悬浮工具条**：刷新按钮（重试 live）+ 外部打开链接，从顶部条搬到右上角的小卡片里，不占主体空间。
- **预处理管线新增 `embeddable` 元数据字段**。fetch 拿到 HTML 时同时记下嵌入策略，写进 node markdown 的 frontmatter。已存在的旧 web 节点字段会缺失（cache short-circuit 命中时不会重抽），前端把"undefined"当作"未知，乐观尝试 live"。

**Notes**

- 桌面端的体验几乎不变：之前手动切 Live / Reader 现在不用切了，省一步。
- 浏览器端体验有大幅改善：Google / Twitter / GitHub 这种发了 `X-Frame-Options: DENY` 的站点，之前要等 5 秒看到空白后手动切，现在打开就直接是 Reader。
- 想强制重试 live 站点：点右上角刷新按钮即可（也会重置自动选择的视图）。
- 如果你想看到一个具体节点的 `embeddable` 验证值，删掉旧节点重新拖一个 URL 进来即可触发新的 fetch；或者重命名节点（清空 cache）。

---

## 2026-06-05 · Web 节点支持真实网页预览 + 本地 HTML 文件

**What Changed**

- **Web 节点的 Preview 面板现在直接嵌入真实可交互的网站**。双击 Web 节点，新版 Preview 会用 iframe 加载源站本身：可以滚动、点击链接、填表单 —— 就和一个内嵌的浏览器一样。桌面端（Electron）默认会剥掉源站的 `X-Frame-Options` / `Content-Security-Policy: frame-ancestors`，所以**几乎所有网站**都能正常嵌入；纯浏览器环境因为没法改响应头，被拒嵌的站点会自动回退到下面说的 Reader 视图。
- **Preview 面板顶部新增 Live / Reader 双视图切换**：左边的"地球"图标是真实网页（Live），右边的"书"图标是 AI 提取的可读纯文本版（Reader）。如果 Live 视图 5 秒内没加载出来（多半是浏览器拦了 iframe），会自动切到 Reader。Reader 也可以手动切回 Live 重试。
- **节点视图也升级了**：进入 canvas 时，Web 节点上半部分会尝试用 iframe 渲染**网站缩略图**（不可交互、仅展示），下半部分仍然是 og:image + AI summary 兜底。Electron 里能看到真实页面静态截图效果；浏览器里如果 iframe 被拦，自动透出 og:image 卡片，外观和原来一致。
- **Web 节点支持拖入本地 `.html` / `.htm` 文件**了。把文件拖到 canvas 上会自动识别成 Web 节点，HTML 作为 artifact 存进 canvas，预处理管线和远程网页走完全一样的流程（Readability 抽正文 → AI 打 label / summary / keywords），Preview 面板里也能直接打开、交互。
- **服务端不再依赖 Tavily Extract API**。换成了完全本地的 `@mozilla/readability` + `linkedom` + `turndown` 组合：抽取质量在大多数静态页 / SSR 页面上和 Tavily 相当，但**不再需要 `TAVILY_API_KEY`、不再产生外部 API 调用费用、可以完全离线运行**。仍在用 Tavily 做"网络搜索"的 `web_search` agent tool 没有受影响。

**Notes**

- 这是首次让 Web 节点能"真的"打开网站 —— 之前 Preview 面板里看到的其实是 markdown 转的 reader 版 HTML，从来就没有渲染过原站。
- 极少数会主动检测 iframe 嵌入（例如银行、登录墙）的页面在桌面端也可能拒绝渲染（页面内部 `top !== self` 自检），这时点工具栏的 **Open externally** 用系统浏览器打开即可。
- 上传的 HTML 文件 iframe 沙箱**没有** `allow-same-origin`：HTML artifact 是同源的，给它 same-origin 会让一个攻击者上传的 HTML 拿到我们的 cookie。如果你的 HTML 严重依赖访问自己的 localStorage / cookie，先转成远程 URL 再用。
- 旧的 Web 节点不需要手动迁移，下次预处理触发时会用新管线重新抽内容；如果只想保留以前已存的 markdown，不会动它（cache short-circuit 命中后不会重抽）。
- 桌面端剥 `X-Frame-Options` 仅作用于 renderer 进程的跨源响应；同源响应（我们自己的 `/api/*`、SPA 资源）不会被修改，主进程安全模型不变。

---

## 2026-06-05 · 桌面端启动遇到端口冲突会自动换端口

**What Changed**

- **打包后的桌面端启动时遇到 `EADDRINUSE`（端口被占用）不再静默失败**：之前主进程会拿 `get-port` 探测一次 3001，如果在 `app.listen()` 真正发生前那一瞬间端口被别的进程抢走（最常见的是上一次 `pnpm dev:desktop` 留下的孤儿 `node.exe`），server 子进程会立刻崩溃，但主进程不知情，仍然把 BrowserWindow 指向 `127.0.0.1:3001` —— 结果加载到的其实是占用端口的"另一个" server，于是首页返回 `Route GET:/ not found` 的 JSON 404。
- **新增的逻辑**：主进程现在最多尝试 3 次，每次拿一个**全新的**空闲端口（避开已经失败过的端口），并把 `waitForPort` 与 server 子进程的 `exit` 事件做了竞速 —— 子进程先死就立刻报错重试，绝不会把 BrowserWindow 接到不属于自己的端口上。
- **`dev:desktop` 的 orchestrator 端口探测修复 Windows 弱绑定误判**：Windows 下,绑在 `0.0.0.0:N`(wildcard)的进程**不会**和 `127.0.0.1:N`(specific loopback)的 `listen()` 冲突,所以原来只探测 loopback 的逻辑在有僵尸 Vite 占着 5173 时会误以为端口空闲,把 5173 传给新 Vite。新 Vite 用 `host:true` 绑 wildcard 真冲突了,静默滑到 5174,但 orchestrator 不知道,继续告诉 Electron `WEB_DEV_SERVER_URL=http://127.0.0.1:5173` —— 结果 BrowserWindow 加载了那个上周遗留的 Vite,页面空白、Console/Network 都没东西。现在 probe 同时尝试两种地址,只有两个都成功才算端口可用。
- **`apps/web/vite.config.ts` 加 `strictPort: true`**:Vite 默认遇到端口冲突会静默滑到下一个,这在 orchestrated dev 下很危险。改成 strict 后端口冲突会硬报错,让 orchestrator 立刻看到失败而不是悄悄走偏。
- **Predev 也覆盖到 `dev:desktop`**：补了一个 `predev:desktop` 钩子，每次 `pnpm dev:desktop` 之前都会跑一次 `pnpm build:agentlet`，避免 agentlet `dist/` 没跟上源码导致 daemon 启动报 `required option '--agent <command>' not specified`。

**Notes**

- 正常机器上你看不到任何变化 —— 端口 3001 没被占,第一次尝试就成功了。
- 如果三次尝试都失败（极端情况：本机所有 ephemeral port 都被耗光，或防火墙阻止 loopback），会回退到"Huabu failed to start"对话框，而不是 BrowserWindow 加载到无效页面。
- 退出应用时的端口释放逻辑没变 —— `before-quit` 仍然 `kill()` server 子进程并等最多 3 s。问题只出现在**不正常退出**的场景：dev orchestrator 在 Windows 上靠 `taskkill /T`，如果在 Ctrl+C 的瞬间 tsx-watch 的孙进程还没起完，就有可能漏杀。下次启动遇到孤儿端口现在会自动避开。
- 如果你以前手动跑 `pnpm dev:web` 习惯端口被占时它自己滑动,现在它会改成报错退出 —— 这是刻意的,可以让你显式处理冲突而不是迷糊地连到一个意外端口。需要的话可以临时在命令前加 `VITE_PORT=5174` 之类的指定一个空闲端口。

---

## 2026-06-05 · 打包后首次连接 External Agent 不再误报 503

**What Changed**

- **拉长了 ChatPanel 等待 agentlet daemon 上线的窗口**：原来固定 5 s，现在改成 20 s。打包后的桌面端首次启动需要付出 ASAR 解包、杀毒软件按需扫描新解出的 Node 子进程二进制等额外开销，daemon 握手在某些 Windows / macOS 机器上很容易突破 5 s，导致 ChatPanel 一进去就拿到 **503 `acp_session_failed`**（前端表现为 `Failed to load resource: the server responded with a status of 503`）。
- **遇到永久性故障会立刻退出等待**：supervisor 已经判定放弃重启（找不到 daemon 入口、失败预算用尽等）时，等待函数会立即返回 `null`，不会继续轮询到 20 s 才报错。

**Notes**

- 正常情况下 daemon 通常在百毫秒内就上线，所以多数用户不会感知到这个变化。只有首次冷启动或机器很慢的场景下，原来"先弹错、点重试又能用"的体验会被消除。
- 真正卡住的极端场景（例如 daemon 一直起不来）现在最长会让 ChatPanel loading 状态保持 20 s 才显示失败，但前提是 supervisor 仍在尝试重启；一旦它放弃，错误会立刻浮出来，用户可以走 Settings → External Agents 的 **Restart worker** 重置。

## 2026-06-05 · AI 画布操作迁移到服务端 Headless Executor

**What Changed**

- **AI 的 `canvas_commands` 工具现在在服务端执行，而不是把命令吐给前端再让前端跑引擎**。新增了 `POST /api/canvas/:canvasId/execute` 接口、一个 per-canvas 异步互斥锁、以及共享 `executeCanvasCommands` 引擎在服务端的封装。命令在服务端跑完后，服务端会同步落盘：更新 `canvas.json`（含 `version` 自增）、写入每个 Markdown 化节点的 sidecar 文件、并在 `<canvasDir>/.history/delta-log.jsonl` 追加一条 batch 记录（包含 fromVersion → toVersion、原始 commands、最小化的 deltas、来源标记）。
- **前端不再二次执行 AI 命令**。`useAgentStream` 现在消费工具响应里携带的 `deltas + toVersion + pendingEffects`，通过新的 `applyDeltasFromAgent` action 把节点/边的最小变更原子地合到本地 store，并把 `mutatedNodes` 交给已有的 web 端 post-effects（预处理调度、Frame fit 等）继续走原来的路径。版本号严格跟随服务端，autosave 不会因此被触发，避免双写。
- **撤销 / 还原 / "AI 改过的节点" 高亮、Frame 自动 fit、内容预处理调度** 这些既有行为全部保留：snapshot 在调用 `applyDeltasFromAgent` 之前抓取，命令上还是带着服务端预分配好的稳定 id，所以 `useCanvasChanges` 系列逻辑无需改动。

**Notes**

- **Sketch 识别流程在本版本仍走前端执行**（`origin.type === 'sketch-recognized'` 会从 handler 直接返回旧版 envelope，跳过服务端执行），以避免与 `sketch.service` 里已经做的客户端 `executeCommands` 重复施加。Sketch 会在 M3 接入跨标签广播时统一收回到 headless 路径。
- **既有画布在第一次跑 AI batch 时会自动生成 `.history/delta-log.jsonl` 文件**；老画布不需要任何迁移，没有 AI batch 就不会出现这个文件。
- **OCC 冲突语义不变**：服务端写盘仍然走原来的 `version` 校验路径；agent 这条链路因为有 per-canvas 互斥锁，多个 AI batch 不会互相打架。
- 服务端尚未广播 deltas 给其它打开同一画布的客户端 —— 跨标签同步是 M3 的事；本版本只解决"AI 改画布"这一条入口，前端 UI 操作仍然走老的 PUT `/canvas/:id` 路径，不受影响。

---

## 2026-06-05 · External Agent 编辑器：分区布局 + 折叠高级选项

**What Changed**

- **重排 Profile 编辑器为四个语义分区**，按使用频率从高到低排列：**Agent**（选哪个 CLI / 自动批准开关 / Custom 模式下的 Launch command）→ **Workspace**（Working directory）→ **Advanced**（折叠）→ **Display name**（自动生成、可覆盖）。每个分区有小号大写标题，区块之间用细横线分隔，整页一眼就能扫完。
- **高级选项默认折叠**。**Extra args**、**Environment variables**、**Auto-restart on crash** 三项搬进 Advanced 区块，点击标题旁的 chevron 才展开；新建 Profile 或关闭对话框后会自动收起，避免一进来就被一堆字段淹没。
- **"Agent CLI" 重命名为 "Auto detected agent"**，明确这是"系统自动探测到的 CLI 列表"。下拉里仍然提供 **Custom command** 选项给写自定义命令的高级用户。
- **结构化模式下不再显示 Launch command 预览**。当你选中检测到的 agent 时，命令行完全由勾选项 + Extra args 拼出，不需要再让你确认；只有切到 Custom command 时才会出现可编辑的命令输入框。
- **Display Name 改为自动生成、可选覆盖**，默认值是 `"<agent> (<working folder basename>)"`（例如 `Claude Code (sediment)`）。输入框的 placeholder 直接显示这个默认值，下方说明文字也以加粗形式重申一次。这个字段移到了对话框最底部——多数人不需要改它。

**Notes**

- 改动只影响编辑器 UI；落到磁盘的 Profile 结构与字段含义与上一版完全一致，老 Profile 打开就是新布局。
- 折叠状态不持久化（每次打开 Modal 都从"收起"开始），这是刻意的：默认隐藏让你聚焦在主要选项上，需要时一键展开就行。
- 如果你写了一个完全空的 Display Name 并保存，后端拿到的依然是非空字符串——前端会在提交前把 placeholder 那个默认名填进去。

---

## 2026-06-04 · External Agent 设置面板：结构化编辑器 + 弹窗交互修复

**What Changed**

- **修了 Settings 弹层在打开"New / Edit agent"对话框后会立刻消失的 bug**。原因是 Modal 通过 React portal 挂在 `document.body`，被 Popover 的 outside-click 判定为"点到外面了"。现在 Popover 会忽略任何落在 `[role="dialog"]` 元素（或显式标注了 `data-popover-dismiss-ignore` 的节点）内的 pointer-down，对话框打开时 Settings 弹层保持挂载。
- **Profile 编辑器加回了结构化的命令拼装界面**：
  - **Agent CLI** 选择器现在编辑时也可见（以只读形式展示当前绑定的 CLI；底层 `cliId` 不允许修改）。
  - 选中检测到的 CLI 后会出现 **Auto-approve all tool calls** 复选框（仅对支持该开关的 CLI 显示，例如 Copilot 的 `--allow-all`），勾上会自动把开关追加到启动命令；旁边附有简要的风险提示。
  - 新增 **Extra args** 文本输入，用来追加结构化复选框未覆盖的 CLI 参数（例如 `--model claude-sonnet-4 --max-tokens 4000`）。
  - **Launch command** 预览块以只读 `<code>` 展示最终拼出的命令行，所见即所得。
  - 编辑已有 Profile 时，编辑器会反向解析 `command`：若它仍匹配 `{binary} {acpArgs...} [allowAllFlag] [extraArgs...]` 的形态，会自动还原复选框与 Extra args 的初始值；若用户曾手动改写或绑定的 CLI 已卸载，则自动退回 **Custom command** 模式并保留原始命令不变。
- **Environment 字段加了说明文案**，明确这是合并到 agent 进程环境变量的额外 `KEY=VALUE`，常见用途包括 API key、HTTPS_PROXY、CLI 自身的配置项；占位符也换成了更具代表性的 `ANTHROPIC_API_KEY=...` / `HTTPS_PROXY=...`。
- 顺手清理了 External Agents 卡片里那一条多余的空白行——daemon 在线（happy path）时 Health Banner 现在完全不渲染，不再留下一段带顶部分割线的占位条。

**Notes**

- 历史 Profile 数据完全兼容：持久化 schema 没有变化，新增的"结构化 vs 自定义"是纯编辑器层的概念，保存到磁盘的依然是单一的 `command` 字符串 + `cliId`。
- 结构化模式只显示后端通过 `GET /api/acp/agent-cli` 返回的、当前在 PATH 上探测到的 CLI；想给一个未检出的 CLI 写 Profile（例如自定义安装路径），直接在选择器里挑 **Custom command** 自己写完整命令即可。
- 如果你自己写的 Popover 弹层里也想嵌入一个非 `role="dialog"` 的浮层而又不希望它被误判为外部点击，可以给浮层根节点加 `data-popover-dismiss-ignore` 属性，效果等价于 Modal。

## 2026-06-10 · 外部 Agent 新版接入：Profile 编辑器 + 后台 Worker

**What Changed**

- 设置面板里的"External Agents"区域被整体重写：旧的"复制启动命令 → 在终端粘贴 → 等配对码"流程已经下线。现在你直接在 Settings 里维护"Agent Profile"列表——每一项就是一份完整的启动配方 `{cli, command, cwd, env, autoRestart}`，由 Sediment 自己负责拉起进程。
- 新增"Add agent"对话框：
  - **Agent CLI** 下拉会列出 Sediment 在本机 PATH 上探测到的 ACP 适配的 CLI（Copilot / Claude / Gemini）。选中后会自动填好 `command`（例如 `copilot --acp`）与 `Display name`。
  - 想要更精细的命令可以选 **Custom command** 自己写，配合 `Working directory`、`Environment`（一行 `KEY=VALUE`）与 `Auto-restart` 复选框。
- 聊天侧的 `@mention` 与"New chat → external"菜单不再展示"配对成功的临时 agentId"，而是直接展示你创建的 Profile。每个条目右侧会显示运行态：`running · pid N`（worker 当前已经拉起这个 agent）或 `idle`（尚未唤醒，将在第一次发消息时按 Profile 启动）。
- Sediment 启动时会自动 fork 一个 agentlet daemon worker，并以指数退避兜底重启。绝大多数时候你完全感觉不到它的存在；只有 worker 真的连不上时，设置面板顶部才会出现一条琥珀色提示，附带 **Restart worker** 按钮强制立即重连。

**Notes**

- **迁移影响**：之前已经创建并绑定过外部 agent 的旧聊天线程会因为 binding key 从 `agentletAgentId` 换成 `profileId` 而失效——这些线程会自动回落到内置 agent。**还没有写入消息的空线程会无缝重置**；已经有对话历史的线程建议新开一个并选择 Profile。
- 配对码 / 启动命令 / wrapper 路径相关的 API 与 UI 都已经移除；如果你写过基于 `/api/acp/pair/*` 的脚本，需要改用 `/api/acp/profiles` 的 CRUD 接口（详见 `packages/shared/src/types/api/acp.ts` 中的 zod 契约）。
- Worker 的 token 不再经过 HTTP 边界——它由 server 直接通过 IPC 注入到 daemon 进程，前端永远拿不到也不需要它。
- 想自定义 daemon 二进制路径（例如指向另一个 agentlet build）可以设置环境变量 `HUABU_AGENTLET_DAEMON_PATH`；不设置时 Sediment 会优先用 `<bundleDir>/agentlet/index.js`，最后回落到 monorepo 内的源码路径。

## 2026-06-05 · 桌面端硬化：快捷键作用域、导航沙箱、退出兜底

**What Changed**

- 调试 / 刷新快捷键不再走 `globalShortcut` 全局注册，改为 BrowserWindow 的 `before-input-event` 监听：F12 / Ctrl(Cmd)+R / F5、macOS 上的 Cmd+Alt+I、其他平台的 Ctrl+Shift+I 都仅在 Sediment 窗口已经获得键盘焦点时才生效。
- 渲染进程现在以 `webPreferences.sandbox: true` 启动；preload 只用到 `contextBridge` + `process.versions` + `process.platform`，这些在 sandbox 模式下都可用。
- 主进程新增 `will-navigate` 兜底：任何想把顶层 frame 导航到非 loopback URL 的尝试都会被拦截，HTTP/HTTPS 链接转发到系统默认浏览器，其它协议直接 deny。
- 应用退出现在会等待 server 子进程真正退出再关掉 Electron，最长等 3 秒；超时会强制 `app.exit(0)`，避免被卡住的 server 拖死整个 quit 流程。

**Notes**

- 上一版"全局注册 F12/Ctrl+R"会让快捷键即便在 Sediment 处于后台时也被吞掉，影响其它应用，本次改回作用域内监听后与系统主流应用行为一致。
- sandbox 模式属于 Chromium / Electron 的安全推荐默认值；外部行为完全不变，仅是渲染进程多了一层 OS 级别的隔离（seccomp / Windows Job Object）。
- 打包版本（DMG / NSIS / AppImage）暂时不再附带 `bin/agentlet` 外部 agent 启动脚本。该 wrapper 依赖 monorepo 内的 `pnpm`、源代码与仓库根 `.env`，在 packaged 环境下原本就跑不起来；现在服务端会上报 `agentletWrapperPath: null`，设置界面里的"复制启动命令"展示退化为占位符 `bin/agentlet`。需要用 Copilot / Claude / Gemini ACP 桥接的用户暂时使用 monorepo 源码运行 `pnpm dev:desktop`；后续会补一个真正可在打包版里跑的 CLI。

## 2026-06-04 · 桌面端开发：全栈热更新脚本 `pnpm dev:desktop`

**What Changed**

- 新增根脚本 `pnpm dev:desktop`（`scripts/dev-desktop.mjs`），一条命令拉起桌面端的"开发模式三件套"：`tsx watch` 起的 server（默认 `:3001`）、Vite 起的 web dev server（默认 `:5173`）、以及 Electron 主进程，三者并行运行并互相清理。
- Electron 主进程新增 `EXTERNAL_SERVER_URL` 环境变量逃生口：dev 模式下若设置了该 URL，主进程会**跳过** fork 自己的 `dist-bundle/server.js`，直接复用外部已经在跑的 server。这是把 server 热更新串起来的关键。
- 热更新覆盖范围：
  - `apps/web/src/**` → Vite HMR，即改即生效；
  - `apps/server/src/**` → `tsx watch` 自动重启 server，Electron 不重启；
  - `packages/shared/src/**` → web 端走 Vite 直接读源码，server 端通过 `tsx watch` 跟踪 import 自动重启，**两端都生效**；
  - `apps/desktop/src/**`（main / preload）→ 仍需重跑脚本（Electron 主进程只在启动时加载一次）。

**Notes**

- 之前的 `pnpm dev:desktop` 是"Vite + Electron + 一次性打包 server bundle"的模式，改 server 必须重跑脚本，体验上等同冷启动。这次重写后日常迭代基本不再需要重启 Electron。
- server 自动重启的瞬间，开着的 SSE / WebSocket 流（聊天、ACP 推送）会被断开。普通 HTTP 请求会在下一次用户操作时重新发起，无感知；如果你正在跑 agent 任务，可能需要 `Ctrl+R` 刷新一下渲染端。
- 端口约定与现有 `pnpm dev` 完全一致：`SERVER_PORT` / `PORT` 控制 server，`VITE_PORT` / `WEB_PORT` 控制 Vite，都从 `.env` / `apps/web/.env` 读取，CLI 临时覆写也照常生效。
- 不影响生产打包路径：`EXTERNAL_SERVER_URL` 只在 `IS_DEV` 时被识别，packaged 应用一定 fork 自己的 server bundle。

## 2026-06-04 · 桌面端自定义窗口标题栏

**What Changed**

- 桌面（Electron）版本不再使用系统默认的应用菜单栏（File / Edit / View / Window / Help），改为一条 36px 高的自绘标题栏（`WindowChrome`）：左侧 Home 按钮回到画布列表，居中显示当前画布名（或在非画布页显示应用名 "Huabu"），右侧承载全局 ⚙ 设置入口；整条标题栏即为窗口拖拽区域，类似 Figma 桌面端的样式。
- Windows 上通过 `titleBarOverlay` 让系统自带的最小化 / 最大化 / 关闭按钮叠加在标题栏右上角，按钮颜色与背景对齐；macOS 保留原生红黄绿"红绿灯"，并在左侧预留 76px 让出按钮位置；Linux 暂时使用无边框窗口（v1 不内置自定义关闭按钮）。
- 由于不再有应用菜单，常用调试 / 刷新动作改为全局快捷键直接生效：`F12` 切换 DevTools；macOS 上 `Cmd+Alt+I` 切换 DevTools、`Cmd+R` 刷新；其他平台 `Ctrl+Shift+I` 切换 DevTools、`Ctrl+R` / `F5` 刷新。
- 画布编辑页的 `CanvasHeader` 与画布列表 / 组件 playground 用的 `Header` 在桌面端会自动隐藏内部的 Logo Home 和设置入口，避免与新标题栏重复出现两套相同按钮；浏览器端样式完全保持原样。
- 画布列表页（`/`）在桌面端把"当前 workspace 文件夹名"提升到了标题栏正中：点击即跳转到 workspace 切换页（`/setup`），hover 显示与原来一致的提示（完整路径 + 画布数量 + "Click to switch"）。原本列表页顶部那条 "Huabu | Path: …" 的副标题在桌面端被隐藏，浏览器端继续显示。

**Notes**

- 浏览器（vite dev / 部署后的 SPA）模式不受影响：`WindowChrome` 在没有 `window.electronBridge` 时返回 `null`，所有页面继续以原来的全屏布局渲染。
- **本次刻意没有引入多 Tab**：当前 agent 的画布写命令实际是发回前端在 `useCanvasStore` 中执行，再由前端持久化到 `canvas.json`；若把跑着 agent 的画布切到后台 Tab 并卸载（>60s 后服务端 `eventBuffer` 会清理），这一段 AI 工作将无法落盘，且下一轮 agent 通过 `inspect` 工具看到的会是过期磁盘状态。等服务端能直接完成 canvas mutation 之后再补 Tab 体验。
- 为了让标题栏占用真实的 36px 高度而不破坏页内布局，应用根节点改用 `flex h-screen flex-col` 包裹路由内容；同时把多处原本写死 `h-screen` / `min-h-screen` 的页面（`CanvasListPage`、`ToolCallPlaygroundPage`、`CanvasPage` 的 not-found 兜底、`WorkspaceSetupPage`、`DocsLayout`、`LoadingState`）改为 `h-full` / `min-h-full`，以适配父容器减去标题栏后的可用高度。视觉效果应与之前一致。
- Linux 当前没有自定义的最小化 / 最大化 / 关闭按钮（窗口仍可通过窗口管理器关闭），属于已知限制，会在后续版本补齐。

## 2026-06-03 · Intent ↔ Memory 闭环：让推荐学会个人偏好

**What Changed**

- Intent 识别（Cmd+I / 工具栏 🧠）现在会把 **Workspace memory + Canvas memory** 折成一段轻量 preamble 一起喂给模型；候选会主动贴近你已经保存的偏好和当前画布目标。
- 后台 Memory Curator 在 op-counter 触发时除了原来的画布快照 / 聊天 / 操作三路来源，**新增 Intent digest 一路**：统计自上次分析以来用户选了什么、丢弃了什么、执行成功还是失败，并把最近 20 条 episode 以 oneliner 形式喂给 curator，由它沉淀成 `.huabu.md` / `.memory/canvas.md` 的长期记忆。
- 选中 intent 之后 chat 执行的成败也会被回写到同一个 `IntentEpisode`（新增 `outcome.execution` 字段：`success` / `error` / `stopped`），让"用户点了但跑挂了"和"用户点了画布也变了"在 memory 视角里被区分开。
- `MemoryState` 新增 `lastSeenIntentCursor`，按 episode 时间戳推进，保证每条 episode 只被 curator 消化一次，不会在每轮分析里重复刷屏。

**Notes**

- **行为变化**：第一次升级后老 episode 一次性全量进入 digest（cursor 是 `null`），之后只看新增；不会重复回流。
- **隐私边界不变**：所有写入仍然只通过 memory sub-agent 的 `fs_write` 工具，仍然受 4 KB / 80 行 cap 约束；intent digest 只在 curator prompt 里临时存在，不落到任何用户可见文件。
- **接口兼容**：`POST /api/intent/recognize` 与 `/recognize-stream` 的 body 新增可选 `canvasId`，缺省时退化为不注入 canvas memory（仍能跑），老前端版本无需修改。
- **失败处理**：Memory 读 / preamble 拼接失败一律 swallow，intent 识别照常进行，只是这次不带 memory bias。
- **测试覆盖**：依赖现有 memory worker 集成测试覆盖，没新增专门用例。

## 2026-06-03 · 画布工具栏新增单键快捷键 + 角标提示

**What Changed**

- 画布顶部工具栏的大部分按钮现在右下角会显示一个浅灰色的小角标快捷键，类似 Figma / Excalidraw 的工具提示样式。选择型工具的快捷键采用字母：`S` Select、`P` Pan、`L` Lasso，节点放置型工具采用连续数字键：`1` Frame、`2` Note、`3` Text、`4` Sketch；Question Sticker 用 `Q`。
- 工具栏的"选择类"工具按钮维持原有的 SplitSelect 结构：左侧主按钮的图标会跟随当前激活的工具变化（Select / Pan / Lasso），右侧 ▾ 下拉可以切换；下拉菜单中每一项右侧也会显示对应字母快捷键，与 Figma 的菜单样式一致。
- 按下对应键即可触发按钮等价行为：例如 `1` 等同于点击 Frame 按钮——再按一次会取消 pending；`S` / `P` / `L` 分别切到 Select / Pan / Lasso 并清掉 pending node。当前激活的工具，其角标会变成品牌蓝以提供视觉反馈。
- 按钮的 tooltip 也补充了快捷键，比如 "Frame (1)"、"Select (S)"、"Question Sticker (Q)"；同时在 `?` 帮助弹窗的快捷键列表中新增 **Toolbar** 分组列出全部绑定。

**Notes**

- 快捷键只在不在输入框 / textarea / contentEditable 元素中、且没有 Ctrl / Cmd / Alt / Shift 修饰键、且没有打开 Upload / Link 模态框时才生效；在 Note / Text 节点里继续输入数字 / 字母完全正常。字母键区分大小写（只响应小写），避免跟 shift 组合挥击。
- Upload / Link 下拉菜单、Intent、以及非鼠标模式下露出的 Undo / Redo 按钮都没有单键绑定。鼠标用户继续使用既有的 `Ctrl/Cmd+Z` / `Ctrl/Cmd+Shift+Z` 做撤销 / 重做。
- Pan 仍可通过按住 `Space` 临时进入；按 `P` 或在 Select 旁的 ▾ 下拉菜单里选 Pan 同样可切到 Pan 工具。
- `Button` 与 `SplitSelect` 公共组件新增 `shortcutBadge` / `primaryShortcutBadge` 等 props；SplitSelect 的 `SplitSelectOption` 另增 `shortcut` 字母键提示字段，其他地方如需相同样式的小角标可以直接复用，避免一次性 hack。`Button` 另外在检测到 `iconOnly + shortcutBadge` 时会用不对称 padding 把图标向左上偏移 2px，让右下角出一块干净的角标空间（按钮尺寸保持不变），避免角标贴图标肉。

---

## 2026-06-03 · 修复聊天消息卡片按 `Tab` 仍会编辑文字

**What Changed**

- AI 消息列表里的 `MilkdownMessageCard`（以及任何用 `MilkdownPreview` + `enableBlockDrag` 的只读富文本卡片）之前按 `Tab` 还能改文档：因为为了显示 Crepe 的 block drag 把手必须保留 `contenteditable=true`，而原先的按键拦截器把 `Tab` 列在 `NAV_KEYS` 白名单里直接放行——ProseMirror 的 keymap 就把 Tab 当成"列表缩进 / 切换嵌套层级 / 在 cell 间移动选区"等编辑动作执行了。
- 现在 `Tab` 从 `NAV_KEYS` 里移除，单独走一条分支：只调用 `stopPropagation()`，**不**调用 `preventDefault()`。结果是 ProseMirror 完全收不到这个事件（再也不会改动文档），但浏览器原生的"Tab 把焦点移到下一个可聚焦元素"行为保留下来，无障碍体验不受影响。

**Notes**

- 影响范围：聊天气泡里的 AI 回复卡片、Note 收起态的预览卡片——任何走 `MilkdownPreview` 且开启了 `enableBlockDrag` 的只读富文本。普通可编辑的 `MilkdownEditor` 不受影响。
- Arrow / Home / End / PageUp / PageDown / Escape / Ctrl+C / Ctrl+A 等导航和复制快捷键继续放行，块拖拽、复制选区文本的体验完全没变。
- 没有改 Crepe 的 keymap 或 ProseMirror 插件，只是在外层 React capture 阶段把 Tab 截住——升级 Milkdown / Crepe 时不需要 patch 上游。

---

## 2026-06-03 · 修复鼠标点选 `@agent` 菜单时误触发倒计时

**What Changed**

- 在 QuestionNode 里用鼠标点选 `@` mention 菜单中的 agent 选项时，textarea 会瞬间失去焦点，导致 `handleBlur` 被触发：之前这会立刻退出编辑态并启动 auto-run 倒计时，但用户其实只是在选 agent，prompt 还在编辑中。
- 现在 `handleBlur` 会检查焦点是否转移到了 mention 菜单内部（`role="listbox"` / `aria-label="Mention agent"`）。如果是，就直接 return，不退出编辑、不写入 store、不排队 pending 倒计时；`acceptMention` 仍会在下一帧把焦点和光标还回 textarea，编辑流程无缝继续。

**Notes**

- 键盘选择（Tab / Enter）路径走 `handleTextareaKeyDown`，焦点根本没离开 textarea，原本就没问题；这次只修复鼠标点选场景。
- `TextNodeBody` 的 `onBlur` 现在接收 `React.FocusEvent`（之前是无参 callback）。TextNode 的 handler 忽略参数，行为不变。
- 没有改 mention 菜单的渲染、过滤逻辑或 `agentBinding` 写入策略；只是把"失去焦点"的判定收紧了一格。

---

## 2026-06-03 · Note 富文本 / 源码切换按钮移到展开面板 header

**What Changed**

- 之前 Note 展开预览右上角浮在编辑区里的 **rich text ↔ raw markdown 切换按钮**，搬到 `ExpandedNodePanel` 顶部 header bar 右侧，跟"Split view"和"Close"放成一排——再也不会盖住第一行正文或 H1 标题。
- 当前处于 raw 模式时，按钮带上 `text-info bg-info-bg` 的"按下"高亮，和 header 里的 Bot / Split view 等其他 toggle 视觉语言一致；WYSIWYG 模式下保持普通 ghost 样式。
- 实现方式：新增 `apps/web/src/components/Nodes/PreviewHeaderSlot.tsx`（一个轻量 context + `usePreviewHeaderSlot` hook），`ExpandedNodePanel` 在 header 里放一个空的占位 `<div>`，把它的 DOM 元素通过 context 暴露给嵌套的 preview 组件；`NotePreview` 用 `react-dom` 的 `createPortal` 把自己的切换按钮渲染进那个占位元素——按钮的 React state、event handler 仍然挂在 `NotePreview` 上，只是输出位置被搬到了 header。

**Notes**

- 行为完全没变：点按钮依旧在 WYSIWYG / raw 之间切换，`aria-pressed` 仍然汇报当前模式，`readOnly` 预览下按钮仍然不出现。
- 同一份数据通路（`writePatch` + provenance 处理）丝毫未动；切换不会触发额外的 patch。
- Slot 机制是通用的——以后别的 preview（PDF / Web / Sketch 等）如果也想往 header 加自己的 action 按钮，只需要在组件里 `usePreviewHeaderSlot()` 然后 `createPortal` 就行，不用改 `ExpandedNodePanel`。
- 极少数 preview 不被 `ExpandedNodePanel` 渲染时 `headerSlotEl` 会是 `null`，portal 自动跳过，不会报错。

---

## 2026-06-03 · Keyboard Shortcuts 弹窗用 chip 渲染，修正 `+` / `−` 显示

**What Changed**

- Keyboard Shortcuts 弹窗里的每个按键现在都渲染成一个独立的 `<kbd>` chip：组合键不再挤成 `Ctrl++` 这种容易看错的字符串，而是 `[Ctrl] + [+]`、`[⌘][+]` 这样按平台原生约定排列。
- `apps/web/src/config/shortcuts.ts` 里把含字面 `+` / `-` 的快捷键改写成 `Ctrl/Cmd+Plus` / `Ctrl/Cmd+Minus`，避免和 `+` 分隔符撞车。`apps/web/src/utils/platform.ts` 新增 `shortcutTokens(template)`，统一处理 `Plus` / `Minus` / `Equal` 等占位符以及 `Ctrl/Cmd` / `Shift` / `Alt` 在 Mac 与 Win/Linux 上的展示差异。
- 顺手修复了一个 Mac 下的小 bug：原来的 `formatShortcut` 会把 `Ctrl/Cmd++` 一路 strip 成 `⌘`，键位整个丢失；改用 token 化输出后 `⌘+` 会正确显示。

**Notes**

- 菜单里的 shortcut 提示（CanvasMenu 的 Undo / Redo 等）继续走 `formatShortcut` 字符串形态，输出与之前一致（`⌘Z` / `Ctrl+Z`），无视觉变化。
- 新的 chip 样式只用了既有语义 token（`bg-bg-default` / `border-edge-default` / `text-fg-default`），未引入新颜色

---

## 2026-06-03 · Note 源码模式：CodeMirror 主题对齐 Sediment design token（light）

**What Changed**

- 接着上一条"升级到 CodeMirror 6"的工作，**把默认浅色主题换成自定义的 `sedimentLightTheme`**，让 raw Markdown 源码模式视觉上和应用其他部分彻底贴齐——不再有"突然换了一套配色"的违和感。
- 新增 `apps/web/src/components/CodeMirror/sedimentLightTheme.ts`，把 CodeMirror chrome（编辑器底色、滚动区、光标、选区、行号槽 / 当前行 / 当前行号、tooltip、autocomplete、search panel、bracket matching 等）以及 Lezer Markdown 高亮 tag 全部映射到 `var(--*)` 设计 token 引用：
  - **编辑器底色 / 文字**：`--bg-default` + `--fg-default`，行号槽透明，右侧用 `--edge-default` 一条分隔线。
  - **标题、链接、列表标记**：统一走 `--info`（H1–H3 加粗 700，H4–H6 加粗 600，保持等宽栅格不被字号撑乱）。
  - **行内 code / 围栏 code 标记 / 关键字**：`--warning`（不加背景色，避免代码块出现碎片化的色块）。
  - **字符串**：`--success`；**数字**：`--danger`；**布尔 / 原子值**：`--warning`。
  - **引用 / 注释 / 强调标记**：`--fg-muted` / `--fg-subtle` 配合 italic，强调"次要装饰"的语义。
  - **选区**：focused 用 `--info-bg`，非 focused 与原生 `::selection` 都退化到 `--bg-hover`，避免高对比的蓝块在失焦时还在抢眼。
  - **搜索 / 替换面板、autocomplete**：复用 `--bg-surface` / `--bg-default` + `--edge-default` 边框 + `--info-bg` 选中态，整张面板和 Sediment 其他浮层一致。
- `RawMarkdownEditor` 的 `extensions` 数组追加这个主题（放在 `EditorView.lineWrapping` 之后、`readOnlyCompartment` 之前），原有 `basicSetup` 默认高亮被自定义的 `syntaxHighlighting(...)` 覆盖（默认高亮带 `{ fallback: true }`，自动让位）。
- `NotePreview` 渲染 `RawMarkdownEditor` 时把容器上多余的 `text-sm` 去掉，CodeMirror 内部字号现在由主题统一控制（13px / line-height 1.65 / `ui-monospace` 系统字体栈）。

**Notes**

- **作用域：仅 light**。按用户要求本次只实现 light 主题，dark 暂未做——目前 `sedimentLightTheme` 是 `{ dark: false }` 的 `EditorView.theme`，但内部用的是 `var(--token)` 而不是 hex，所以即便切到 `.dark` 大多数颜色会跟着 CSS 变量自动级联（除了 `dark` flag 影响的少量内置默认值）。完整 dark 主题（含光标 / 选区 / autocomplete 的暗色优化）留作下次工作。
- **新依赖**：`@lezer/highlight`（直接 dep，用来 import `tags` 给 `HighlightStyle.define` 用）。不会增加运行时体积——Lezer parser 本身已经被 `@codemirror/lang-markdown` 间接引入。
- **不替换 `basicSetup`**：保留 `basicSetup` 提供的 `highlightActiveLine` / `highlightSelectionMatches` / `closeBrackets` / `autocompletion` / search keymap 等行为，本主题只负责"上色"，不动行为。
- **没给围栏代码块加每字符背景**：尝试过 `.cm-line` 内 token 加 `bg-bg-hover` 高亮带，视觉上会变成碎片色块；现按 GitHub / Notion 等惯例只给 token 上色、不带 background，整段代码块本身的辨识度交给 Lezer 已经识别出的 `monospace` tag 配色完成。
- **想要 dark 主题** / 想调具体某个 tag 颜色（比如 H1 想加大字号、code 想加浅色背景），告诉我就行。

---

## 2026-06-03 · Note 源码模式升级到 CodeMirror 6（语法高亮 + 编辑器能力）

**What Changed**

- 上一条引入的 raw Markdown 模式底层从原生 `<textarea>` 换成 **CodeMirror 6**，带来真正的 Markdown 源码编辑体验：
  - **语法高亮**：标题层级、`**bold**` / `*italic*` / `` `code` `` 行内强调、`>` 引用、列表 / 任务项、链接、围栏代码块（` ```lang `）等都由 Lezer parser 精确识别并上色（暂用 CodeMirror 内置默认浅色主题，先观察效果再决定是否对齐 Sediment 设计 token）。
  - **行号、当前行高亮、行包裹**（`EditorView.lineWrapping`），长行不再被横向滚动条藏住。
  - **多光标编辑**（Alt+Click 加光标、Ctrl/Cmd+D 选下一个相同词）、**列编辑**（Shift+Alt+拖拽）。
  - **括号 / 引号自动配对**、**智能缩进**（列表项 Enter 自动续接 `- ` / `1. ` / `> `，Tab/Shift+Tab 调整层级）。
  - **Ctrl/Cmd+F 搜索 & 替换**，**Ctrl/Cmd+Z / Ctrl/Cmd+Shift+Z 独立的撤销栈**（不再和浏览器 / canvas 的撤销混在一起）。
- 新增 `apps/web/src/components/CodeMirror/` 子目录托管所有 `@codemirror/*` 依赖：`RawMarkdownEditor.tsx`（受控组件）+ `index.ts`（barrel）。和现有 `apps/web/src/components/Milkdown/` 一样属于"被严格隔离的第三方编辑器封装层"，外部只能从 barrel 拿到 `RawMarkdownEditor` / `RawMarkdownEditorProps`，不允许直接 import 任何 `@codemirror/*` 包。
- `NotePreview` 用 `React.lazy` + `<Suspense>` 包住 `RawMarkdownEditor`：CodeMirror 体积（约 80kb gzipped）只在用户**真的点切换按钮进 raw 模式**时才下载，对首屏完全零影响。Suspense fallback 显示 "Loading source editor…" 一闪而过。

**Notes**

- **主题**：当前用 CodeMirror 默认浅色主题，**视觉上和应用其他部分会有色差**——这是有意为之的第一版，先确认整体能力到位再来对齐 design token（一次性把高亮配色映射到 `text-fg-default` / `text-info` / `text-warning` / `bg-bg-default` 等会更细致）。如果觉得太突兀想立刻换主题，告我一声很快能加。
- **新依赖**：`codemirror`（meta 包，提供 `basicSetup`）、`@codemirror/lang-markdown`、`@codemirror/state`、`@codemirror/view`、`@codemirror/language`。tree-shake 后约 80kb gzipped。
- **`codeLanguages: []`**：暂未启用围栏代码块（` ```ts `、` ```py ` 等）的子语言高亮。开启需要按需 dynamic-import `@codemirror/lang-javascript` / `@codemirror/lang-python` 等，包体积会随之增大。后续如果用户反馈"想看 fenced code 里的 ts 高亮"再加。
- **`readOnly` 切换**：通过 `Compartment` 热重配 facet，不重建 View，光标 / 选区 / 历史栈全部保留。
- **数据通路不变**：仍然走原来的 `writePatch` + `lastEmittedMarkdownRef` 去重逻辑——同一份 `data.content` 在 Milkdown / CodeMirror 之间无损往返，AI 实时改写、undo / redo 等行为和上一版本一致。
- **provenance 高亮 / Accept / Reject** 仍只在 WYSIWYG 模式显示（CodeMirror 模式无法依赖 ProseMirror block-key），行为没有变化。

---

## 2026-06-03 · Note 展开视图：一键切换富文本 / 原始 Markdown 模式

**What Changed**

- Note 节点的展开预览（`NotePreview`）右上角新增一个**模式切换按钮**，让用户在 Milkdown 富文本所见即所得（WYSIWYG）模式和原始 Markdown 源码模式之间一键切换。
- WYSIWYG 模式下按钮显示 `<Code2>` 图标，提示 "Edit raw markdown (source)"；切到源码模式后变成 `<BookOpen>`，提示 "Edit rich text (preview)"。按钮带 `aria-pressed`，对屏幕阅读器明确暴露当前模式。
- 源码模式渲染一个等宽字体（`font-mono text-sm`）的 `<textarea>`，直接读写 `data.content`，编辑流程沿用与 Milkdown 相同的 `writePatch` 通路——同一字符串在两种编辑器之间无损往返，互改不丢内容。

**Notes**

- **使用场景**：富文本模式适合大多数日常笔记编辑；源码模式适合需要精细控制 Markdown 语法（如 raw HTML、math 分隔符、复杂表格、对齐空格、HTML 注释）或快速大段粘贴的情况，弥补 WYSIWYG 编辑器对某些边角语法支持不完整的问题。
- **Provenance 行为**：AI 改写块的高亮 / Accept / Reject / 底部"AI edited N blocks"汇总条只在 WYSIWYG 模式渲染——它们基于 ProseMirror 的 block-key 寻址，对自由文本的源码编辑不适用。如果有未处理的 AI 块标记，建议先在富文本模式下 Accept / Reject，再切到源码模式做大段重写；不然块标记会在你切回 WYSIWYG 时根据新内容重新对齐，部分原先的 marker 可能因块身份不再匹配而消失（这是预期行为）。
- **数据安全**：模式切换不会触发额外的 `writePatch`，也不会清空 `data.provenance`。即使在源码模式里改了内容，未匹配上的 provenance 条目仍保留在数据里（只是不再显示），不影响 undo / redo。
- **只读模式**：当 `NotePreview` 以 `readOnly` 渲染时（如 source / readonly 节点），切换按钮被隐藏，保持原有行为不变。
- **现阶段不影响 canvas 上的卡片视图**：节点卡片本身使用的是 `MilkdownPreview`（只读富文本渲染），切换按钮只出现在通过 `openExpanded(id)` 打开的展开模态里。

---

## 2026-06-03 · Canvas 下拉菜单：缩小字号 + 显示快捷键

**What Changed**

- Canvas 标题旁的下拉菜单（Undo / Redo / Export Canvas / Keyboard Shortcuts）整体调整为更紧凑的样式：菜单项字号从 `text-sm` 缩小到 `text-xs`，左右内边距与图标间距也相应收紧。
- 移除菜单项左侧的 lucide 图标，改为更接近原生编辑器菜单的纯文字布局。
- 拥有快捷键的菜单项（Undo、Redo、Keyboard Shortcuts `?`）在右侧以 subtle 色显示对应快捷键提示，与 `docs/user-guide/08-shortcuts.md` 文档保持一致。
- 快捷键提示现在会**根据操作系统自动切换**：Windows / Linux 显示 `Ctrl+Z`、`Ctrl+Shift+Z`，macOS 则显示原生的 `⌘Z`、`⌘⇧Z`。检测逻辑封装在新增的 `apps/web/src/utils/platform.ts` 里（导出 `isMac` 与 `formatShortcut`），其它需要展示快捷键提示的菜单也可以复用。
- 应用 `?` 打开的 Keyboard Shortcuts 弹窗也接入了 `formatShortcut`：每条快捷键直接显示当前平台的原生写法；顶部那段"Use Ctrl on Windows/Linux and Cmd on macOS"提示因此变得冗余，改成更直白的"Showing shortcuts for macOS / Windows·Linux"。

**Notes**

- 字号与间距调整作用于通用 `DropdownMenuItem` 组件，因此应用内其他使用该组件的菜单（如 `IntentSelectMessage`、Showcase 页）也会变得更紧凑——这是预期的视觉统一，不影响交互。
- `icon` 与 `shortcut` 仍是 `DropdownMenuItem` 的可选 prop，其它消费者无需改动。
- `formatShortcut` 只识别 `Ctrl/Cmd` / `Shift` / `Alt` / `Option` 这几个常见占位符，未识别的子串原样输出，避免在不熟悉的按键组合上做"聪明但错误"的替换。

---

## 2026-06-03 · ACP 配对码：修复"自动重连一定失败"的回归

**What Changed**

- 修复了 6 月 2 日重构后的回归：claimed 状态的票据在 agentlet 任意一次 WebSocket 断开（wifi 抖动、dev hot-reload、合盖醒来）后会被**立即删除**，导致客户端自带的指数退避重连永远收到 `Invalid or expired pairing code`，与 README/Settings UI 上"重连仍可继续使用"的承诺相反。
- 现在 `onDisconnection` 改为**启动一个 5 分钟的宽限计时器**，而不是立即作废 ticket。这 5 分钟与 agentlet wrapper 的 `--reconnect-max` 默认值（300 秒）对齐，覆盖典型的网络抖动 / 笔记本休眠场景。
- 宽限窗口内同一 `agentId` 重新发 `bridge/hello` 成功，计时器被取消，ticket 继续有效；超时还没回来才真正删除——既保留了"防止泄漏码被长期复用"的安全初衷，也不再误伤合法重连。
- Settings popover 现在每次打开都会强制 `refresh()` 一次配对码列表，避免上一轮窗口里看到的票据已经被服务端清掉、UI 还显示"Paired · …"的陈旧态。
- `useNow` 250ms 计时只在**有 pending 票据可见**时才转，popover 长时间开着也不会再无意义地强制 React 重渲染。

**Notes**

- **行为变化**：合法用户基本无感——重连恢复了；多了 5 分钟"幽灵 ticket"窗口，期间被 revoke / 服务器重启仍然立即生效。
- **安全考量**：5 分钟选择基于 agentlet 默认 reconnect 上限。如果你把 agentlet 的 `--reconnect-max` 调高，宽限窗口期间的票据可能被你自己的 client 抢救回来；想缩短这个窗口可以改 server 端的 `PAIRING_RECONNECT_GRACE_MS` 常量。
- **测试**：`token-store.test.ts` 新增 4 个 case（不立即 drop / 宽限内重连 / 宽限耗尽真删除 / markDisconnected 幂等不延长窗口）。
- **未做的事**：仍然没有在 UI 上把"grace 中"状态展示出来（暂时和 Paired 一样显示），后续如果用户反馈想看 reconnect 状态再加。

---

## 2026-06-03 · 外部 Agent 一键启动（检测安装 + 自动 PATH）

**What Changed**

- Settings → External Agents 上方新增 **Detected Agents** 区块：server 在 host 上自动探测 `copilot` / `claude` / `gemini` 三种 ACP-capable CLI（用 `which` / `where` + `--version`），只显示**已安装**的；未检测到的不再占位。
- 每张 Detected Agent 卡片暴露 **Connect** 按钮：一次点击同时完成 ① 生成新的配对码、② 拼出完整的 `agentlet --token <CODE> --agent "<binary> --acp …"` 命令、③ 复制到剪贴板，并 toast 提示用户在 60 秒内粘贴到终端。原来"先生成码，再自己拼命令"的两步流程简化为一步。
- 卡片上的 **Auto-approve tool calls** toggle：仅在 CLI 支持显式的自动批准 flag 时显示（目前只有 Copilot 的 `--allow-all`），默认开启。Claude / Gemini 没有等价的简单 flag，因此**不**渲染该 toggle——用户如果要类似行为，仍可走下方"Pair manually (advanced)"自行拼命令。
- 原有"Generate code"按钮保留为 **Pair manually (advanced)**，给需要自定义 binary、远程 shell、定制参数的高级用户作为兜底。
- `pnpm install` 现在会自动把 `<repo>/bin/` 加到当前用户的 PATH（POSIX 写入对应 shell rc：zsh → `~/.zshrc`、bash → `~/.bashrc`、fish → `~/.config/fish/config.fish`；Windows 调 PowerShell 写 User-scope PATH）。安装完打开**新终端**即可直接敲 `agentlet`，不再需要手动 `export PATH=…`。
- 后端新增 loopback-only 路由 `GET /api/acp/agent-cli`，返回探测到的 agent 列表 + `agentletOnPath` 标志 + `bin/agentlet` 的绝对路径；前端用后两者决定复制命令时用 `agentlet …`（短）还是 `<abs>/bin/agentlet …`（长）。

**Notes**

- **PATH 写入的安全开关**：postinstall 脚本在以下三种情况下**完全跳过**写入：① `process.env.CI === 'true'`（防止污染 CI shell rc）、② `HUABU_NO_AUTO_PATH=1`（用户显式 opt-out）、③ `bin/` 已经在 PATH 里。失败永远不会让 `pnpm install` 退出非 0——最差情况只是不复制 PATH，wrapper 仍可以走完整绝对路径调用。
- **PATH 写入的幂等性**：通过 `# Added by Sediment — agentlet CLI` 哨兵注释 + `binDir` 字面量双重检查。多次 `pnpm install` 不会重复追加。
- **Windows 注意**：`bin/agentlet` 本身是 POSIX sh 脚本，只能在 Git Bash / WSL 里直接运行（cmd.exe / PowerShell 不行）。把 `bin/` 加到 User PATH 仍然有意义——Git Bash 会继承 Windows PATH。如果你只用原生 PowerShell，目前需要走 WSL 或在 `bin/` 旁加 `.cmd` shim（暂未实现）。
- **Auto-approve 的 scope**：只在 Copilot 一家上提供 toggle 是有意为之。Claude 的 `--dangerously-skip-permissions` 与 Gemini 的对应能力都属于"明确警告级"的 flag，不该作为一键勾选——如果默认勾上+复制到剪贴板，用户很可能在没读完 prompt 的情况下粘贴执行。
- **检测时机**：Settings 面板每次挂载都会重新探测，所以你新装一个 CLI 之后只要刷新 Settings popover 就能看到，无需重启 server。

---

## 2026-06-02 · ACP bridge 改用阅后即焚的配对码（破坏性变更）

**What Changed**

- 移除 Settings → External Agents 的 enable/disable toggle。ACP bridge 现在**永远挂载**，安全边界完全交给一次性的配对码。
- 旧的"持久化共享 token"换成了**ephemeral pairing code**：
  - 在 Settings 里点 **Generate code** 会得到一个 8 位的码（如 `XXXX-XXXX`），UI 上明文显示并附 60 秒倒计时
  - 60 秒内第一个用该码 `bridge/hello` 成功的 agentlet 会**锁定**这个码到自己的 `agentId`；之后同一个 agentlet 的重连（wifi 抖动、dev hot-reload、合盖醒来等）仍可继续使用
  - 60 秒过期未被认领 → 自动失效
  - agentlet 优雅断开 / 用户在 Settings 点 ✕ / Sediment server 重启 → 立即失效
- 同时可以生成多个码、配对多个 agent，互不影响。
- `bin/agentlet` wrapper 不再从 `data/acp-config.json` 读 token——这个文件不再使用，启动时会自动删除残留。
- `bin/agentlet` 现在必须通过 `--token <CODE>` 或 `AGENTLET_TOKEN` 环境变量传入配对码，缺失时报清楚的引导信息。

**Notes**

- **破坏性变更（接前次 ACP 重构）**：原本走 Settings UI 启用 + 自动复用 token 的工作流被废弃。每次启动一个新的 agentlet 实例（不是重连）都需要现去 Settings 生成一个码。日常重连（同一个 agentlet 进程被 wifi/sleep 打断）不需要重新生成。
- **安全模型**：HTTP 上的 `/api/acp/pair*` 三个端点仍然是 loopback-only；token 永远不落盘；server 重启全部失效。`/api/acp/agent` 的 WS 端点本身无条件挂载，是 token store 把守。
- **多人/多 agent 同时使用**：完全支持。每张票据独立，互不影响。
- **如果你之前依赖 token 长期有效**（例如脚本里硬编码了 token）：现在不行了，需要改为每次启动 agentlet 前先调 `POST /api/acp/pair` 拿一个新码。一般用户不受影响。

---

## 2026-06-02 · Frame col/row 布局：子节点尺寸任何方式变化都会触发重排

**What Changed**

- 在 column / row 布局的 frame 里，无论子节点是怎么改变尺寸的，整个 frame 现在都会自动重排：
  1. 手动拖拽 resize 把手（之前已支持）。
  2. 在 node toolbar 里输入精确 W/H（之前已支持）。
  3. **新增**：node toolbar 里的"高度自适应 / 固定"切换按钮（之前只刷新了外接矩形，不会重新分槽）。
  4. **新增**：在 note 节点里输入内容把节点撑开 / 删除内容把节点收缩（之前完全不会通知父 frame）。
  5. 新增图片/PDF 等异步资源加载完成后尺寸变化，也会一并触发重排。

**Notes**

- 实现上分两步：
  1. `postEffects.web.ts` 把原本的 `scheduleDeferredFrameFit` 升级成 `scheduleDeferredFrameRelayout`，DOM reflow + ResizeObserver 完成后先跑 `applyStructuredFrameRelayout`（重新分槽 + 重写 frame 大小），再跑 `fitFrames`（让外层祖先 frame 跟着 cascade）。多次调用在同一个 tick 内被合并成一次 double-rAF，避免高频 RO 触发重复工作。
  2. `canvasStore.onNodesChange` 里新增一个 watcher：每次 ReactFlow 派发 `dimensions` change 时，如果目标节点的父节点是 column/row frame，且新尺寸跟显式 pin 的 `style.{w,h}` 不一致（避免 commit 后 RO 回声触发空转），就调用上面的 scheduler。live drag / resize 会话期间会跳过（手势结束时的 `SET_NODE_GEOMETRY` 自己会触发重排）。
- 这条路径是"绕过 command 管道的尺寸变化"的统一兜底通道。未来再有新的此类来源（比如新增节点类型的异步 resize），不需要单独再处理。
- 不引入新的 undo 步骤：被动重排走的是普通 `set({ nodes })`，跟原有的 `scheduleDeferredFrameFit` 行为一致——属于视觉收敛，会被 autosave 持久化但不进 undo 历史。

---

## 2026-06-02 · 聊天气泡显示 `/skill` 调用

**What Changed**

- 用 `/<skill-id>` 调用 skill 后，聊天气泡顶部会用一个 AI 主题色（紫色字 + 浅紫底）的小 chip 把被调用的 skill id 显示出来，例如发送 `/canvas-memory 帮我整理` 时，气泡里会先出现 `/canvas-memory` 的 chip，下面再是消息正文 `帮我整理`。
- 多个 skill 会一行平铺显示，按用户输入顺序去重，与 server 实际注入的列表一致。
- 刷新页面后从历史里恢复出来的用户消息同样会显示这些 chip。

**Notes**

- 实现上：parser 仍然会从消息正文里把 `/<id>` 前缀剥掉（避免它在 LLM context 里被当成自然语言），但 chat store 的 user message 上新增 `invokedSkills?: string[]` 字段，由 `UserMessage` 渲染成 chip。
- 历史持久化：server 端在用户消息正文末尾追加 `[SYSTEM invokedSkills:[...]]` 元数据 tag（与 `selectedNodeIds` / `attachments` 同套机制），history endpoint 读出时再剥掉并填回 `invokedSkills`。ACP preprocessor 也会同步剥掉该 tag，避免泄漏给外部 agent。

---

## 2026-06-01 · 内置 `/create-skill` 与 `/update-skill` 两个 slash skill

**What Changed**

- 新增两个系统内置 slash skill，**仅 operate (Agent) 模式可用**：
  - **`/create-skill <描述>`** — 按描述新建一个 user skill。Agent 自动取 id（kebab-case）、组合 frontmatter、写 body，最后调用 `fs_write({ path: "skills/<id>/SKILL.md", mode: "overwrite", rationale, body })`。整个过程无需用户确认细节，按描述生成即可。
  - **`/update-skill <目标 + 改动>`** — 按目标提示从 catalogue 里定位 user/merged skill，`read()` 现有内容后用 `fs_write({ mode: "replace_string" })` 做局部编辑，或在结构性重写时用 `mode: "overwrite"`。
- 两个 skill 都遵循前一次提交的 `/` 调用语义：选中后 server 把 SKILL.md body 强制注入到本轮 system preamble，agent 按 body 里的步骤执行。
- 写入完全复用 `fs_write` 工具，不新增任何 handler。Operate agent 的工具列表里新增了 `fs_write` 入口，并在 AGENT.md 系统提示里明确写出"仅在被显式 `/`-invoked skill 引用时才允许调用"。

**Notes**

- **新增一个 frontmatter 字段 `userInvokable: true`**：用来让"看起来像系统能力但又应该出现在 `/` 菜单里"的系统 skill 通过过滤器。默认为 `false`，所以原有 `canvas` / `sketch-gestures` 等 system skill **行为不变**，仍只出现在 agent 自己的 `{{skillCatalogue}}` 里。
- **菜单过滤规则更新**：`user` / `merged` 永远进菜单；`system` 只有在 `userInvokable: true` 时才进。server 端 `agent.route.ts` 的 invokedSkills 白名单走的是**同一条** `isUserInvokableSkill` 谓词，stale client 不能绕。
- **不要扩散 `fs_write` 到 operate 的普通 turn**：operate 的 AGENT.md 已经写明此约束。如果未来发现 agent 在普通画布操作里乱写 skill / memory，应在 AGENT.md 里加更强的措辞，而不是把 `fs_write` 拆出来。
- 文件位置：`apps/server/src/prompt/skills/create-skill/SKILL.md` 和 `apps/server/src/prompt/skills/update-skill/SKILL.md`（loader 只识别一层目录，所以平铺而非 `slash-skill/` 子目录；slash 性质由 `userInvokable: true` 表达，比物理目录更稳）。

---

## 2026-06-01 · 聊天面板新增 `/` 手动调用 skill 能力

**What Changed**

- 聊天输入框现在支持用 `/<skill-id>` 显式调用 user-authored skill（位于工作区的 `setting/skills/<id>/SKILL.md`）。键入 `/` 会弹出 typeahead 菜单列出所有可用 user skill，与外部 ACP agent 的 slash 命令共用同一套 UI（按 thread binding 自动切换数据源）。
- **仅在 operate (Agent) 模式下生效**：ask (Chat) 模式属于 Q&A 语义，键入 `/` **不会**弹菜单，开头的 `/foo` 也会被原样作为消息文本发送，不触发 skill 注入。
- 选中后送出消息时，server 会自动把对应 skill 的完整 markdown body 作为 `[SYSTEM Skill]` 前置消息注入到本轮上下文，相当于强制 agent 应用该技能——和原本"agent 自行决定是否 `read()`"的按需加载模式区分开。
- 一条消息最多可以连写多个 `/<id>` 前缀，例如 `/canvas-memory /workspace-memory 帮我整理一下`，所有 id 会按出现顺序去重后一次性注入（server 端硬上限 8 个）。
- 新增 `GET /api/skills?scope=ask|operate|sketch|external` 路由，返回当前 workspace 下可被用户调用的 skill 元数据；菜单按当前 mode 过滤。

**Notes**

- **菜单只列 user / merged skill，不列 system-only skill**：
  - `user` = 用户在 `setting/skills/` 下亲手或通过 memory agent 写的 skill；
  - `merged` = system 提供了同名基线、user 在 workspace 里写了 override / 扩展；
  - `system` = 框架自带 skill（如 `canvas` / `sketch-gestures`），仍保留在 agent 的 `{{skillCatalogue}}` 让模型自主选用，但不进 `/` 菜单（避免菜单被一堆用户不知情的 skill 灌满）。
- **server 端再做一次白名单校验**：客户端被改 / 旧版本 / 第三方直接 POST 都没法绕过菜单硬塞 system skill id；非 user/merged id 会被静默丢弃，server 日志会有一条 warn。
- **未知 id 处理**：operate 模式下，消息开头 `/foo` 若不在已知 skill 列表里（typeahead 也没匹配），会被当成普通文本送出去，不会触发 skill 注入。
- **mid-sentence `/` 不会被误识别**：解析器只看消息开头的连续 `/<id>` token，例如 `check src/main.ts and /canvas-memory` 不会被当成调用 `canvas-memory`。
- **外部 ACP agent thread 不变**：绑定到 Copilot / Claude Code / Gemini 这类外部 agent 时，`/` 菜单仍然来自 agent 自己推送的 `available_commands_update`，server 不会做 skill 注入；同名 token 由 agent 自己解释；与 ask/operate 模式区分无关。

---

## 2026-06-01 · 三个 memory 写工具收敛为统一的 `fs_write`

**What Changed**

- `memory_workspace_write` / `memory_canvas_write` / `memory_skill_write` 三个工具被合并为一个 `fs_write({ path, mode, ... })`。Agent 通过虚拟 `path` 选目标（`memory/workspace.md` / `memory/canvas.md` / `skills/<id>/SKILL.md`，与 `read` 工具接受的虚拟路径对称），通过 `mode` 选写法：
  - `mode: "overwrite"` — `body` 整体覆盖；文件不存在时即创建。
  - `mode: "replace_string"` — 找到唯一出现的 `oldString`，替换为 `newString`；文件必须存在；匹配 0 或 ≥2 次都 reject。
- Workspace memory 不再走 writer 层的 bullet-merge / dedup，agent 直接管理文档（先 `read` 再 `replace_string` 或 `overwrite`）。"只增不删"由 prompt 纪律保证。
- Skill 文件的 frontmatter 不再由 writer 渲染，`body` 必须由 agent 提交完整文件内容（含 `---\n...\n---` 前导 fence）。
- 创建新 skill（`mode: "overwrite"` 在不存在的 `skills/<id>/SKILL.md` 路径上）仍硬性要求 `rationale` ≥ 20 字符；其它情况 `rationale` 被忽略。

**Notes**

- **内部工具调整，普通用户无感知**：所有写入的目标文件、磁盘布局、cap（workspace + canvas 仍是 4 KB / 80 行；skill 仍无 cap）、并发锁、skill 缓存失效行为都保持不变。
- **自定义 agent 配置需要更新**：若你在自定义 prompt / AGENT.md 里引用了旧工具名（`memory_workspace_write` 等），请替换为 `fs_write`，并按新参数形态调整 schema。所有内置 prompt 已同步。
- **行级编辑能力顺带获得**：`mode: "replace_string"` 在三类 memory 文件上都可用，特别适合对长 skill 文件做局部修订，不再需要 LLM 整段重抄。

## 2026-06-02 · 默认本地绑定 + Host 白名单 + CSRF 防护（破坏性变更）

## 2026-06-03 · 外部 ACP Agent 一键启用（破坏性变更：env vars 不再生效）

**What Changed**

- 设置面板（右上齿轮）新增 **External Agents (ACP)** 区块，可一键启用/禁用外部 agent bridge，并自动生成、复制、轮换 `agentlet` 共享 token。
- 启用状态和 token 现在持久化到 `data/acp-config.json`（权限 `0600`），第一次启用时自动生成 64 字符 hex token；切换 enable 状态不再需要重启服务器。
- WebSocket 端点 `/api/acp/agent` 现在**无条件挂载**——安全边界改由 in-memory token store 把守，禁用时 store 为空、`bridge/hello` 全部拒绝，启用时同步注入 token。
- `bin/agentlet` wrapper 直接从 `data/acp-config.json` 读 token，用户不再需要复制粘贴。

**Notes**

- **破坏性变更**：环境变量 `ENABLE_ACP` 和 `ACP_DEV_TOKEN` 已**完全失效**，无论是服务器还是 `bin/agentlet` 都不再读取它们。原本走 `.env` 启用 ACP 的用户需要：
  1. 在 Settings → External Agents (ACP) 里点 **Enable**（会自动生成新的 token，旧的 `ACP_DEV_TOKEN` 值不会被迁移）；
  2. 从 `.env` 里删掉 `ENABLE_ACP` / `ACP_DEV_TOKEN` 两行（留着不会报错，但毫无作用，徒增困惑）。
- `ACP_URL` 仍然有效——`bin/agentlet` 在连接非默认 `ws://localhost:3001/api/acp/agent` 端点时仍会读这个变量（例如 TLS-fronted 远程部署）。
- Settings 面板的 token 读写都受 localhost-only 守卫保护，同 LAN 上的其它设备无法读取或修改 ACP 配置。
- 旋转 token 会立即吊销旧 token，所有正在连接的 agentlet 实例需要用新 token 重连。
- 服务器启动错误信息从 "set ENABLE_ACP=1 and restart" 改为 "enable external agents from the Settings panel"。

---

## 2026-06-02 · 默认本地绑定 + Host 白名单 + 跨站写入防护（破坏性变更）

**What Changed**

- 服务器现在默认只绑定 `127.0.0.1`（不再是 `0.0.0.0`），新装的实例不会被同局域网的其他人意外访问到。
- 新增 `HUABU_BIND_HOST` 环境变量，需要 LAN/远程访问时显式设置为 `0.0.0.0` 或具体网卡 IP。
- 新增 `HUABU_ALLOWED_HOSTS` 环境变量（逗号分隔的主机名列表），所有 HTTP 请求的 `Host` 头都会校验，不在白名单里的直接 403——防御 DNS rebinding 攻击。
- 新增 **跨站写入防护**：所有写请求（POST/PUT/PATCH/DELETE）按三层依次校验：
  1. **`Sec-Fetch-Site` (W3C Fetch Metadata)**——现代浏览器首选信号，JS 无法伪造（forbidden header）。`cross-site` 直接 403；`same-origin` / `same-site` / `none` 放行。
  2. **`Origin` 白名单**——老浏览器 / WebView 回退路径，主机名必须落在 `HUABU_ALLOWED_HOSTS` 里。
  3. **Loopback 兜底**——既无 `Sec-Fetch-Site` 也无 `Origin` 的请求（curl、原生 app、CI 脚本），只在 TCP peer 为 `127.0.0.1` / `::1` 时放行。
     无 token、无 bootstrap、无前端注入。
- CORS 同步收紧：只允许 `HUABU_ALLOWED_HOSTS`（含 loopback 默认项）对应的来源，阻断跨站读取敏感 GET 端点的路径。

**Notes**

- **如果你之前从局域网 / 其他设备访问过 Sediment**：升级后需要在 `.env` 里加上：
  ```dotenv
  HUABU_BIND_HOST=0.0.0.0
  HUABU_ALLOWED_HOSTS=your-lan-ip,your-hostname.local
  ```
  否则远程访问会出现 403 或连接被拒。强烈建议同时启用 `HUABU_BASIC_AUTH_USER`/`HUABU_BASIC_AUTH_PASS`，并在前面挂 HTTPS。
- 纯本机使用（默认场景）无需任何配置变更,体验和之前一致。
- **从非本机的脚本/原生 app 调用 API**：必须显式带上 `Origin: http://your-allowed-host` 头（落在白名单内），否则会被第 3 层兜底规则拒掉。这是相对旧实现的一处行为收紧——旧版本对"无 Origin"无差别放行。
- 第三方 ACP agent（agentlet CLI）的 WebSocket 连接不受影响——它继续走自己的 token 鉴权。

---

## 2026-06-01 · 图层面板新增正则搜索 + 类型过滤

**What Changed**

- 左侧 **Layers 面板**顶部新增一条**默认单行**的过滤栏（画布存在 ≥2 种节点类型时显示）：
  - **类型 chip 行（默认可见）**：左侧一排图标 chip + 右侧搜索按钮，没有额外文字标签——chip 本身（图标 + tooltip `Filter by Image` 等）就是过滤的视觉语义，避免 "Filter" 这种英文 jargon 造成的语言门槛。chip **只显示当前画布上实际存在的节点类型**（在 `CANVAS_NODE_TYPES` 的标准顺序里筛选）；**默认全部未选 = 不施加类型约束（显示全部类型）**；点击 chip 高亮选中（柔和的 `bg-info-bg` + info 色，不是刺眼的纯色 pill）→ 列表收窄到只显示该类型；多次点击不同 chip 把更多类型加入白名单；再点已选中的 chip 取消选中。chip 数量过多时优雅地 `flex-wrap` 到第二行，右侧搜索按钮始终保持在右上角。
  - 过滤栏底部用 `border-edge-default/40` 一条极淡的发丝线（约等于 `#f5f5f5`）作为分隔，比默认 edge 色淡 60%；既能暗示"过滤栏 vs 列表"的区段感，又不会和上方 workspace header 的 border 视觉上叠成"两条平行线"。
  - **正则搜索框（按需展开）**：点击右侧搜索图标按钮才展开输入行；自动 focus，输入即过滤，按 label 做大小写不敏感的正则匹配；非法正则会让输入框边框变红、列表清空，避免静默"降级到子串匹配"造成的误解。Esc 或栏内 × 关闭输入行并清空 query，但**保留 chip 选中状态**（chip 和 search 解耦，互不打扰）。
  - **fallback：画布只有 0–1 种类型时**，chip 行不渲染（chip 没意义），改在右上角浮动一枚低调的搜索图标（默认 50% 透明、hover 100%），点击直接展开搜索输入；与之前版本的行为兼容。
- 两种过滤**自动组合**为 AND：正则命中 ∧ （未选任何类型 ∨ 类型在白名单内）。
- **过滤激活时切换成扁平 list 视图**（VS Code 全局搜索式）：层级缩进消失、所有命中节点统一 `depth=0` 渲染。撤销所有过滤后**无缝回到原 tree 视图**。
- **过滤激活时禁用拖拽排序**（避免"跨越被隐藏节点"导致 z-order 意外变化）；折叠 chevron 也隐藏（扁平结果中折叠无意义）。

**Notes**

- **不破坏原有交互**：单选 / Ctrl 多选 / 双击重命名 / 锁定 / fitView 到画布节点等行为在过滤状态下全部继续工作；过滤命中节点点击后照常 fit 到画布对应位置。
- **匹配在 collapsed frame 里的节点也会浮现**：过滤模式直接跳过"折叠 frame 隐藏子节点"的视图过滤，确保搜索结果不被画布上的折叠状态意外屏蔽。
- **性能**：过滤是单遍 O(N)，并且复用了原有的 per-id 缓存（新增一层 flat 模式缓存），命中节点的 `SortableRow` 在 selection-only 变化时仍能命中 `React.memo`，不会触发 O(N) 重渲染。
- **过滤状态是面板本地的 `useState`**：折叠左侧面板再展开时状态保留；不进 zustand store、不持久化到 localStorage。
- **没有改 shared / server**：纯前端 UI 改动，节点 schema、canvas-engine、API 契约都没碰。

---

## 2026-06-02 · 没有锚点的新节点改成落在当前视窗中心

**What Changed**

- 通过没有"锚点"的入口添加节点时（聊天消息卡片底部的 **Add as note**、Floating Drag Handle 的 **Add as note / image** 按钮等），新节点现在会**以包围盒中心对齐到当前视窗中心**出现，而不是被丢到 (0, 0) 再由 force-directed `placeNode`（fCoSE）算法挪到某处。
- 同一批次有多个 fallback 节点时（例如一次性 paste 上传 3 张图），按 `+40, +40` 的步长依次错位，与现有 `Ctrl+V` 粘贴的视觉行为保持一致。
- 拖拽放置、画布右键、粘贴到画布某点、Sketch overlay、frame drag-to-create 等**已经带坐标**的入口完全不受影响——它们的 `placementPoint` 仍然原样使用。

**Notes**

- **没有触碰 agent 路径**：agent 通过 `CREATE_NODES` 创建节点时，如果带了 `position` 就照用，没带就仍走 force-directed 兜底——agent 的位置决策权和 LLM 行为完全不变。
- **没有触碰 shared canvas-engine**：viewport 是 web-only 概念，新逻辑只活在 web 的 `dispatchUiIntent` + `resolveAddNodes` 里；shared/server 看到的依然是带 `position` 的 `CREATE_NODES`。Headless executor 行为零变化。
- **没有做碰撞检测**：跟现有 `Ctrl+V` 粘贴一样，如果视窗中心已经被节点占住，新节点会盖在上面；用户拖动一下即可。要做"避开已有节点"以后再补。
- **fallback 兜底**：极端情况下（React Flow 实例还没注册 / 画布容器没挂载）`viewportCenter` 是 undefined，逻辑回退到原先的 force-directed `placeNode`，不会创建 (0, 0) 的孤儿节点。

---

## 2026-06-02 · ACP preprocessor 升级成可自主探索画布的 sub-agent

**What Changed**

- ACP **intent translator**（生成给外部 agent 用的 `task` 简报的那一层）从"一次性 LLM 调用 + 固定塞入选中节点正文"升级成了一个**带 read-only 画布工具**的 sub-agent，包括 `get_canvas_outline` / `inspect_nodes` / `inspect_edges` / `read` / `grep` / `find` / `ls`。
  - 它现在能**自己决定要不要读取节点内容**——简单问题（一句寒暄、纯文字指令、用户已经在聊天框里贴了代码片段）直接合成简报，根本不去碰画布；需要画布上下文的（"看看那几个节点说什么"、"那个 frame 里哪几个最相关"）会按需 `read` / `grep` / `inspect_*`。
  - 翻译期最多跑 6 轮（`runtime.maxIterations: 6`），多数 turn 应该 1-2 轮就结束；UI 看不到中间 tool call，只会看到最终的 `prepared_prompt` 卡片。
- 新增模板指令 `{{include:<path>}}`：可以把另一个文件（路径相对 `apps/server/src/prompt/`）整段塞进 AGENT.md 里。preprocessor 的 AGENT.md 就是用 `{{include:skills/canvas/SKILL.md}}` 把 canvas SKILL 原样拼进来，**和其他 agent 共用同一份画布知识，不再有 copy-paste 漂移风险**。
- 顺手修了一个潜在的 Windows 坑：`parseFrontmatter` 现在会把 CRLF 行尾正规化成 LF 再交给 YAML 解析器，避免 Windows 上写的 AGENT.md 把 `toolExecution: parallel` 解析成 `"parallel\r"` 然后被验证拒绝。

**Notes**

- **用户感知**：依旧是发出消息后看到 "Preparing…" 卡片，然后变成 PreparedPromptCard，外部 agent 那边收到的内容形态不变。差别在**简报质量**：preprocessor 不再被 16KB 阈值卡住——以前超过 16KB 的节点只能挂 attachments、永远不会被合成到 `task`；现在 agent 可以分块 read 出关键段落直接合成进去，attachments 只在真正需要逐字访问时才用（review 代码、二进制 artifact 等）。
- **不需要选中节点的 turn 更便宜**：以前哪怕用户问"你叫什么名字"，只要画布里有 selected node，preprocessor 也会先把它正文 stat + read 一遍；现在 agent 会跳过整个读节点环节。
- **失败回退保持不变**：translator 抛错（LLM 故障 / JSON 解析失败 / 用完 6 轮还没出 JSON）依旧 fallback 到原始 rawText，前端会看到 `prepared_prompt` 带 `error` 字段。
- **没有引入新的画布写入面**：preprocessor agent 没有 `canvas_commands` 工具，只能读不能写，不会动用户画布。
- **后续优化方向**：现在 preprocessor 已经具备探索能力，下一步可以把 frame 内兄弟节点 / 空间邻居自动注入提示，让 agent 不用每次都 `get_canvas_outline` 才知道附近还有什么。

---

## 2026-06-02 · question node 多轮对话也会重置未读状态

**What Changed**

- 之前在 question node 的 chat thread 里发**追加问题**（多轮对话），新答案流回来后节点的 `viewed` 标记**保持原状**，所以 Layer Panel 上的小圆点和画布上的 "done · unread" pill 都不会重新出现——视觉上看不出"有新答案没看过"。
- 现在每次在 question thread 里发新一轮消息时（走 `useAgentStream.startStream` 的 follow-up 路径），节点会一并被标记成 `viewed: false`，与首轮的 `useQuestionRunner` 行为对齐。
- 答案结束时，如果**用户仍在这个 question thread 里看着**（`viewingQuestionThread.nodeId` 还指向同一个节点），则在 `onComplete` / 中止处理里把 `viewed: true` 再补回去——他们已经看了一遍，不需要再用未读提示骚扰。
- 如果用户在 stream 期间已经切去看别的 chat 或 canvas，节点会保持 `viewed: false`，圆点和 pill 正常出现，直到下次再点开这个 question node 才会被标记成已读。

**Notes**

- **running 状态没变**：原来就在 follow-up 时正确把状态切到 `running`，这次只补了 `viewed` 字段，行为是叠加的，没动 status 流转。
- **影响范围只有 question thread 的 follow-up**：canvas chat 的普通对话不会触发 `viewed` 字段修改（节点没有 `questionNodeId`）；首轮自动运行依旧由 `useQuestionRunner` 单独管理。

**What Changed**

- 之前在 question node 的 chat thread 里发完问题后，如果**在流式返回结束前**关掉 question thread 切回主 canvas chat（或者打开另一个 question node），LLM 的回复消息会**追加到当前正在看的那个 chat session 的 message list 上**，而不是发起这次提问的那个 thread——视觉上像是"别人的对话突然多了一段我没说过的话"。
- 现在每个 chat session 的 message list 被**独立缓存在 `messagesByThread[threadId]` 里**：每次 send 时记录"这次 stream 属于哪个 thread"，所有 SSE 事件直接写入对应 thread 的 slice，UI 永远渲染当前 `threadId` 对应那条。
- 切回原 thread 时，消息列表是**内存里实时的那一份**——回复继续流进来不会丢，已结束的回答也立刻能看到完整版（不再需要触发 history refetch 才知道结果）；同时切去看别的 thread 时，那边也是各自独立的状态，**所有 thread 可以并行流式接收回复**。
- question node 自身的状态徽标（pending / running / done / error）**不受 thread 切换影响**——它是按 node id 标注的，无论用户当时在看哪个 chat，都会按时进入 `done`。

**Notes**

- **不会主动 abort stream**：用户的预期是"我只是去别处看一眼，问题应该继续跑"，所以切 thread 时不会取消服务端的 run，只是把回复落到正确的 list 里。要主动中止仍然请用 chat 输入框右下角的 stop 按钮（只对当前 thread 生效）。
- **顺带把 `isLoading` 也改成了 per-thread**：原来整个 chat panel 只有一个全局 `isLoading`，意味着 canvas chat 在跑的时候 question panel 的输入框也会被 disable（反之亦然）。现在每个 thread 各自有 loading 状态，**canvas chat 和任意 question node 可以并行 send**，stop 按钮也只停当前 thread 那条 run。每条 stream 在自己的 closure 里持有 `assistantId` / `resources` / abort controller，互不污染。
- **内存占用**：缓存只活在内存（不持久化），单 thread 平均 ~200KB。每次切 thread（打开/关闭 question thread、切 canvas、新建对话）会跑一次 `evictInactiveThreads`：缓存条数超过 10 时，把所有 **非 pinned** 的 thread 一次性丢掉——pinned 集合 = 当前可见 thread ∪ 正在 stream 的 thread ∪ question 视图下被压栈的 canvas thread。被丢掉的 thread 下次再切回时，`useChatHistory` 自动 refetch（沿用既有路径），用户最多感知一次 ~200ms 的 loading。写消息路径零开销：eviction 只在切换边界跑，不在 `addMessage` 里跑。
- **`useQuestionRunner`（首次自动 run）路径不受影响**：它只用最小化的 `onEvent` 翻一个 `sawDone` 旗子，从不写 `chatStore`，所以从一开始就没有这个泄漏。

---

## 2026-06-01 · Layer Panel 显示 question node 的执行状态

**What Changed**

- 左侧 **Layer Panel** 里的 question 节点行图标右下角现在会带一个 **6px 状态小圆点**，颜色含义和画布上 QuestionNode 自带的 `StatusBadge` 保持一致：
  - 🟠 `pending` — 自动运行倒计时中
  - 🔵 `running` — 正在执行
  - 🟢 `done` 且**尚未阅读** — 有未读回答（带 pulse 动画提示注意）
  - 🔴 `error` — 失败
- 鼠标悬停小圆点会出 tooltip，文案直接复用画布 badge 的措辞（`Pending` / `Running` / `Done · unread` / `Error — {errorMessage}`，error 消息超过 200 字符自动截断）。
- `idle` 状态和 `done` 且已读的节点**不显示**圆点——保持 panel 在"无事发生"时的视觉干净。

**Notes**

- **不是 chat session 列表**：这只是 ambient 状态指示，点击行为不变（依旧是选中节点）。要看完整对话仍然走"双击 question node → Chat Panel"那条路径。
- **性能**：`isSameTreeItem` 加了 `status` / `viewed` / `errorMessage` 三个字段的浅比较；非 question 节点通过 `type` 短路退出，原有 `SortableRow` 的 `React.memo` 行为对其它节点零影响。
- **文案单源**：`Common/StatusBadge` 新导出 `getStatusLabel(status)`，Layer Panel 和画布 badge 共用同一份 status → label 映射，未来加新 status 不会两边漂移。
- **不和 sketch 节点抢图标位**：sketch 节点的预览缩略图渲染逻辑完全没动；只有 `type === 'question'` 的节点会触发圆点叠加。

---

## 2026-06-01 · 一键开"和别的 agent 的新会话"——ModeSelector → NewChatMenu

**What Changed**

- 聊天面板顶部的 `[模式/Agent ▼]` 下拉（`ModeSelector`）被替换成一个 **`+ ▾` split button**（`NewChatMenu`），仍然在右上角原 `+` 的位置。
  - 左半 **`+`**：保留以前的 "开新对话" 单击行为，但现在会**继承当前 thread 的 (mode, binding)**——如果你正在和 claude 聊天，点 `+` 就直接开一个新的 claude 会话；正在用内置 Ask 模式，就开一个新的内置 Ask 会话。
  - 右半 **`▾`**：点开后是一个菜单，列出所有可选的起点（Chat / Agent / 每一个连接上的 ACP agent），**点哪一项就直接开一个新 thread 并绑定到那项**。底部仍有 "Refresh Agents" 按钮。
  - 菜单里会用 `text-info` 高亮当前 thread 的 (mode, binding)，方便看出现在用的是哪个。
- 当前 thread "绑定到谁" 这个信息，从下拉的 trigger 文本变成了直接显示在面板**标题**位置（例如 "Chat with claude" / "Chat with GPT-4o"），与 Sketch / Question replay 这类只读视图的标题样式统一。

**Notes**

- **解决了什么痛点**：以前想 "和 claude 开新会话" 要两步——先点 `+` 开新会话（会被强制重置成内置 agent），再打开下拉选 claude。现在 `▾ → claude` 一步搞定。
- **1 thread = 1 binding 的规则不变**：thread 一旦开始对话，agent 就锁死，只能开新 thread 才能换。NewChatMenu 的语义是 "开新 thread"，所以菜单永远可点；这和以前 ModeSelector "thread 有消息后所有选项灰掉" 相比，更符合直觉（以前那个状态下下拉看起来像坏了）。
- **持久化层小幅扩展**：`chatStore.clearMessages(canvasId, options?)` 新增可选 `options.binding` 参数，让 "重置 thread + 绑定到指定 agent" 在 zustand 内变成一次 `set`——避免菜单选项点击后 UI 闪一帧 "内置 binding"。其他调用方（不带 `options`）行为不变。
- **失联 binding 自动 fallback**：以前 ModeSelector 内部有个 effect 会在 "空 thread + 持久化的 external binding 已经断连" 时把 binding 重置成内置；这个逻辑被搬到 ChatPanel 里继续生效，避免新的 `+` 快捷键去尝试连一个不存在的 agent。

---

## 2026-06-01 · ACP preprocessor 不再回传对话历史

**What Changed**

- 给外部 ACP agent（Copilot CLI、Claude Code、Gemini CLI 等）发送消息前，Sediment 这边的 **intent translator**（即 `acp/preprocessor.ts`）会先把用户消息 + 选中的画布节点合成成一份自包含的 `task` 简报。之前为了帮翻译 LLM 解析"用那个"、"按你刚才说的改"这类指代，preprocessor 会把当前线程最近 4 轮对话也喂给翻译 LLM——但外部 agent 那边本来就通过 ACP `session/load` 维护着完整对话记忆，这部分历史等于发了两遍，是纯粹的 token 浪费。
- 现在 preprocessor **不再读取也不再发送对话历史**。指代词（"that" / "the previous one" / "上面那个"）会原样透传给外部 agent，由它用自己的 session 记忆去解析。
- preprocessor system prompt 里加了一段明确说明："你不会收到任何对话历史，外部 agent 自己有完整记忆，请把指代短语原样保留、不要尝试展开。"

**Notes**

- **用户感知近似无变化**：因为外部 agent 那边的历史一直在，指代解析能力没下降。
- **省 token**：每轮固定省下 truncate 后的 ~400-1500 tokens（4 轮对话 × ~800 字符上限），频繁画布编辑场景下累计可观。
- **后续优化方向**：preprocessor 当前还只能利用用户**显式选中**的节点，下一步会注入画布的空间结构（frame 内的兄弟节点 / 邻近候选清单），让外部 agent 能感知"放在一起的节点是相关的"——这条会单独在另一篇 changelog 里跟进。

---

## 2026-06-01 · ACP agent 选择器加载中提示

**What Changed**

- 当聊天面板绑定到外部 ACP agent（Copilot CLI、Claude Code、Gemini CLI 等）后，输入栏里的 mode / model / config 下拉是异步从 agent 拉取的——`session/new` 还在路上、或者 agent 还没推第一份 `current_mode_update` / `config_option_update` 之前，工具栏左侧那块本来是空白的，用户看不出 "还在加载" 还是 "这个 agent 没有可调项"。
- 现在在 `AcpSessionSelectors` 里加了一个轻量的占位 pill：`⟳ Loading agent options…`，**只在首次拉取还没拿到任何数据时**显示；agent 一公布出 mode / model / config 的任意一项，占位立刻消失换成真正的下拉，不会和实际下拉同时出现。
- 后续 SSE 推送（mid-turn 推新 mode 列表等）刷新数据时不会再触发占位，避免布局抖动。

**Notes**

- **不影响内部 Huabu agent**：内部绑定不走这条 fetch，输入栏左侧仍然保持原样。
- **agent 不公布就不显示**：如果初次拉取完成后 agent 没暴露任何 mode / model / config，占位会和真实下拉一起消失（行为与之前一致）；只有在 "请求还在飞" 这个窗口期内才有提示。
- **可访问性**：占位带 `role="status"` + `aria-live="polite"`，屏幕阅读器会朗读 "Loading agent options"。

---

## 2026-05-31 · ACP 外部 agent 现在能在聊天面板里切模式 / 模型 / 配置项

**What Changed**

- **聊天面板顶部新增 agent 选择器**：原来挂在输入框工具栏左侧的 `[copilot ▼]` 绑定下拉，被提升到 ChatPanel 头部（标题位置）。视觉上类似 ChatGPT 顶部那种 `ChatGPT ▼`：无边框、点开下拉选 built-in mode（Chat / Agent）或某个外部 ACP agent。`+` 新会话按钮仍在右上角。Sketch / Question replay 这类只读视图保留原来的纯文本标题。
- 当 thread 绑定到外部 ACP agent（Copilot CLI、Claude Code、Gemini CLI 等）后，聊天**输入栏**里会出现一组无边框的 ghost 下拉，**专门用于 session 进行中可调的设置**：
  - **Agent Mode**：agent 通过 `session/new` / `session/load` 响应的 `modes.availableModes` 公布的可选模式（例如 Copilot CLI 的 `agent` / `chat`）。
  - **Model**：agent 通过 `models.availableModels` 公布的可选模型；切换时调用 SDK 的 `unstable_setSessionModel`。
  - **Config Options**：agent 通过 `configOptions` 公布的每一项配置（Copilot 通常推 4 项：model / mode / thought level / auto-approve toggle），按 `type` 分别渲染为下拉或 On/Off 开关。
- 切换任意一项会立即调对应的 ACP 方法（`session/set_mode` / `session/set_model` / `session/set_config_option`），同时本地 UI 乐观更新，不等服务器回包就改高亮。
- agent 在 turn 进行中推送的 `current_mode_update` / `config_option_update` / `session_info_update` / `usage_update` 现在也会实时反映到这些下拉里——之前 translator 直接丢弃这些 SSE 帧，"已加载 session 复用" 的场景下 UI 只能看到一个空的 ModeSelector。

**Notes**

- **分层语义**：顶部的 agent 选择器是"这个 thread 委派给谁"——thread 一旦开始对话就锁死；底部输入栏里的下拉是"已委派的这个 agent 在 session 进行中可调的旋钮"——随时可改、agent 也可以推送更新。
- **仅对外部 agent 生效**：内部 Huabu agent 没有这些概念，输入栏里的下拉不会出现。
- **agent 不公布就不显示**：如果某个 agent 没在 `session/new` 响应里返回 `modes` / `models` / `configOptions`，对应下拉默认隐藏；不会出现"空列表"占位。
- **避免双胞胎下拉**：Copilot CLI 会把 `mode` / `model` 同时塞进 `modes`/`models` _和_ `configOptions`。当顶层 mode/model 下拉已经存在时，`configOptions` 里 `id` 为 `mode` / `model` 的项会被静默隐藏，避免两个完全一样的下拉并排出现；只通过 `configOptions` 公布 mode/model 的 agent 不受影响。
- **turn 进行中可切换**：mode / model / config 切换不被"streaming"状态禁用，因为 ACP 协议本身允许 mid-turn 切换；如果某些 agent 拒绝（返回错误），UI 会在 agent 下一次 push 时被覆盖回正确状态。
- 没有迁移成本：所有持久化结构未变；只是 SSE 事件流多了 4 个 `type`，外加聊天面板布局调整。

---

## 2026-05-29 · 重启 Sediment server 后 ACP 对话不再重置

**What Changed**

- 每个绑定外部 ACP agent（Copilot CLI / Claude Code / Gemini CLI 等）的 thread 会把 `sessionId` 持久化到 `<canvasId>/.history/acp-sessions.json`。**只重启 Sediment server、agentlet CLI 与 agent 子进程仍在跑** 的场景下，下一次发 prompt 会自动调 `session/load`：
  - agent 进程还认识这个 session（通常返回 `Session ... is already loaded`）→ 我们直接复用，外部 agent 的对话上下文、slash 命令缓存等完整保留。
  - agent 不认识 / 拒绝 → fallback 到 `session/new` 重开会话，行为与改造前一致，UI 不会卡死。

**Notes**

- **覆盖范围有限**：当前仅恢复"server 重启、agent 仍存活"的场景。如果 agentlet CLI 也重启了，它会重新生成 agent id（末尾随机 UUID 变化），我们会判定为不同 agent → 直接走 `session/new`。Copilot CLI 本身只在内存里保存 session，agent 进程一死状态就没了；Claude Code / Gemini CLI / Codex 这类把 session 落盘的 agent，未来通过放宽 agent id 匹配规则可以进一步覆盖（目前不做）。
- **不恢复断联期间的对话**：刷新前已完成的 turn 仍在 chat history（一直在）；断联期间 agent 在 CLI 继续输出但前端没收到的那部分内容，刷新后不会回灌到聊天面板。需要的话用户手动重新 prompt 继续。
- 持久化文件按 canvas 分文件，删 canvas 自然清理，无需手工迁移；从未用过外部 agent 的 thread 不会生成文件，零额外存储成本。原子写入，崩溃中段最多损失最后一条记录，整个文件不会损坏；读取容错任何形状错误。

---

## 2026-05-31 · 文本节点编辑：按回车现在会立即增高

**What Changed**

- 在 `TextNode` / `QuestionNode` 中编辑文字时，按下回车键节点会立即增加一行高度，不再需要在新行上多输入一个字符才看到容器变大。
- 节点尺寸自适应使用的 `measureTextContent` / `measureTextHeight` / `computeFontSizeForHeight` 现在会把"以 `\n` 结尾"的文本视为多一个可见空行。

**Notes**

- 行为差异来自 pretext 把 `\n` 视为 CSS 风格的行终止符——纯排版场景这没问题，但在可编辑的 textarea 里光标会停留在那个"看似空白"的下一行，所以节点必须为它预留一行高度。
- 仅影响输入时的高度反馈；已落盘的节点尺寸（`style.width` / `style.fontSize`）不变，无需迁移。

---

## 2026-05-31 · ToolPart 结构重构：富渲染工具升级为一等变体

**What Changed**

- 助手消息里的 `AssistantToolPart` 从"扁平形状 + 名字判断分发"重构为四个一等结构变体的 discriminated union：`generic` / `agent_tool` / `canvas_commands` / `web_search`。`variant` 标签在数据源头（服务端 history 重建、SSE 合并、sketch cluster 合成器）写定一次，所有渲染器按 `variant` 精确收窄分发，前端不再做名字字符串翻译，也不再有 `as ToolResponse<…>` 强转。
- `canvas_commands` / `web_search` 因为有独家形状（canvas commands、`WebSearchToolResponse`）而独立成型；`agent_tool` 收纳所有同名连续合并的内置 pi-ai 工具（如 `read` / `grep` / `inspect_nodes`），合并键现在是结构化的 `agent_tool:<toolName>`；其余外部 ACP `tool_call` 走 `generic` 通用渲染器。

**Notes**

- **没有用户可见的 UI 变化**：所有四类工具卡片的视觉、行为（撤回 / 预览 / 批量撤回 / 复制等）保持不变；重构只调整内部数据契约，让类型系统替代名字约定承担正确性。
- 历史 sidecar 与 SSE 线协议未变。`AgentToolCallEventData` 移除了 `internalToolName`（ACP `tool_call` 永远走 `generic`），不影响任何已落盘的旧消息——回放时由服务端按结构化数据决定 variant。
- 内部约定：新增需要"独家形状"的内置工具时（例如未来引入新的可视化卡片），优先升级为新 variant 而不是塞到 `agent_tool.data` 里。共享辅助 `variantForInternalTool(toolName)` 是 variant 解析的单一源点。

---

## 2026-05-30 · ACP rich-update 在聊天面板可见（PR-2）

**What Changed**

- PR-1 铺设的 `tool_call` / `tool_call_update` / `plan` 现在在聊天面板里渲染为一等公民的"段（part）"：
  - **工具调用卡片**：外部 ACP agent（Claude Code / Copilot CLI / 自研 agent）发出的 tool call 显示为一行可展开的卡片，带状态图标（pending → in_progress → completed/failed）、`toolKind` 图标（read / edit / search / execute …）、source locations 和富 content 块（文本 / 图片 / 资源链接）。同名连续的内置 agent 工具调用（如 3 条 `inspect_nodes`）合并为一行计数。
  - **Plan 卡片**：agent 发出的 `plan` 通知现在显示为可折叠的待办清单，支持 `pending` / `in_progress` / `completed` 三种状态、`high` 优先级徽章和"复制 plan（Markdown 格式）"按钮。
- 助手消息内部模型从"一条 text + 旁边一条独立 `tool` 角色消息"重构为"一条 assistant 消息持有 `parts: AssistantHistoryPart[]`"。`parts` 是 `text / thinking / tool / plan / status` 五种段的有序数组——同一段渲染分发既走实时流也走刷新回放，不再有双码路。
- 历史 sidecar 从 v1（positional `messageIndex / partIndex`）升级到 v2（stable id：`toolCallId` 作为 tool extras 的 key，`messageTimestamp` 作为 plan 的 key）。读取时旧文件自动 in-memory migrate 到 v2，下次写入即落地为 v2。

**Notes**

- **数据兼容**：旧的 chat-store 数据（messages 没持久化、只持久化 thread/binding 映射）不需要迁移。旧的 sidecar v1 文件透明升级，无人工动作。
- **内置 pi-ai agent**：内部 tools（`read` / `grep` / `inspect_nodes` / `canvas_commands` / `web_search` …）的现有富渲染（CanvasCommandCard / WebSearchToolDisplay / MergedAgentToolRow）保持不变；它们通过新的 `internalToolName` 字段从 part 上解析，原有交互（撤回单次变更、批量撤回、preview）行为一致。
- **遗留事件**：`tool_start` / `tool_result` 这两个 SSE 事件仍兼容并标记 `@deprecated`，内部 pi-ai 桥仍在用；下一个 PR-2.5 会把 pi-ai 也切到 `tool_call` / `tool_call_update`，届时会一并清理。
- 一个线程如果从未触发过 ACP 富更新，仍然不会生成 `.parts.json`——零额外存储成本不变。

---

## 2026-05-29 · 幕后：ACP rich-update 基础设施（PR-1）

**What Changed**

- 外部 ACP agent（Claude Code / Copilot CLI 等）的 `tool_call` / `tool_call_update` / `plan` 三类 `session/update` 通知现在会被翻译成新的 SSE 事件（`tool_call` / `tool_call_update` / `plan`），并以 sidecar 文件 `<canvasId>/.history/chat/<threadId>.parts.json` 形式持久化，刷新后不再丢失。原有的 `text_delta` / `thinking_delta` 行为不变。
- `packages/shared` 引入官方 `@agentclientprotocol/sdk@^0.22.1`：类型与 zod schema 通过该 SDK 复用，避免在客户端 / 服务端各自手抄。translator 在出口对每条 `session/update` 用 `safeParse` 做 trust-boundary 验证，并暴露三个计数器（invalidPayloads / toolCallMissingKind / unknownSessionUpdate）供后续 metric。

**Notes**

- **没有用户可见的 UI 变化**：本次只铺设管线，新的事件目前还没有渲染入口；PR-2/PR-3 会把它们接到聊天面板。
- 现有 `tool_start` / `tool_result` SSE 事件保留并标记 `@deprecated`：内部 pi-ai 桥仍然在用，PR-3 切换前别拆。
- 一个线程如果从未触发过 ACP 的 rich update（例如只跑了一条纯文本对话），不会生成 `.parts.json` 文件——零额外存储成本。
- Sidecar 写入失败（磁盘只读 / 权限错误等）不会中断会话，只会在服务端日志里打 warn，pi-ai 主历史文件仍然完整。

---

## 2026-05-28 · 修复：外部 Agent slash 命令偶尔为空

**What Changed**

- 修复了绑定到外部 ACP agent（如 Claude Code / Copilot CLI）的线程在打开聊天面板后，`/` typeahead 偶尔一直空白、且 Network 里 `commands` 始终是空数组的问题。根因是 agent 经常在 `session/new` 响应**之前**就把 `available_commands_update` 通知推过来，而服务端那时还没装上 listener，通知被静默丢弃。
- 服务端 `AcpAgentClient` 现在会把"还没有 listener 就到达"的 `session/update` 按 sessionId 缓存到一个有界 ring buffer 里；调用 `registerSessionListener` 时同步回放，确保不会再漏掉首次推送。

**Notes**

- 不需要前端配合，刷新页面即可生效。原有的"立即拉 + 200ms 后再拉一次"兜底逻辑保留不变，但绝大多数情况下首次 POST 就能返回完整命令列表了。
- 仅当 `ENABLE_ACP=1` 启用时该路径才会生效；内置 agent 线程不受影响。
- 如果 agent 本身从来不推 `available_commands_update`，菜单仍然保持隐藏 —— 这是 agent 的行为，不是 Sediment 的 bug。

---

## 2026-05-26 · ACP 外部 Agent 斜杠命令：聊天输入框 typeahead

**What Changed**

- 当聊天线程绑定到外部 ACP agent（如 Claude Code / Copilot CLI）时，在输入框中输入 `/` 会弹出该 agent 提供的 **slash command 候选菜单**。键盘交互：`↑/↓` 移动高亮、`Tab` / `Enter` 选中、`Esc` 关闭。点击候选项也可选中，选中后会把 `/<name>` 写入输入框并把光标放在参数位置。
- 服务端新增两个端点：`POST /api/acp/threads/:threadId/session`（幂等地打开/复用 per-thread ACP session 并返回当前缓存的 slash 命令）和 `GET /api/acp/threads/:threadId/commands`（读取最新缓存）。绑定到外部 agent 后，前端会自动调用前者预热 session 并拉取命令，无需用户先发送一条消息。
- 预处理器（intent translator LLM）对斜杠命令做 **short-circuit**：当 raw 输入以 `/<name>` 开头时跳过 LLM 重写，原样转发给外部 agent —— 否则 LLM 可能把命令拆成自然语言、丢失前导 `/`、或额外加噪声。

**Notes**

- 该功能要求线程绑定到 **external** binding（ModeSelector 中选了一个连接上的 ACP agent）。Internal（Sediment 内置 agent）线程没有 slash 命令，菜单不会出现。
- 命令列表是 agent 推送的 —— 由 ACP `session/update.available_commands_update` 通知决定。某些 agent 在 `session/new` 后才推送，前端会立即拉一次 + 200ms 后再拉一次，以兜底"晚到"的推送。如果 agent 完全不推送任何命令，菜单保持隐藏。
- ACP 协议本身没有"执行斜杠命令"的 RPC —— 斜杠命令是嵌在普通 `session/prompt` 文本里的，agent 自己解析。Sediment 只是帮你把命令名输入对，不会拦截执行。
- 仅在服务器启动时设置 `ENABLE_ACP=1` 才会注册线程端点；否则按 404 行为降级，菜单不展示。

---

## 2026-05-25 · Artifact 引用瘦身：只存裸文件名

**What Changed**

- Node 的 `data.src` / `data.coverUrl` 现在只存裸 artifact key（如 `art_abc.pdf`），不再存完整的 `/api/canvas/<canvasId>/artifact/<file>` 路径。完整 URL 只在渲染时由 `resolveArtifactUrl(key, canvasId)` 临时拼接。
- 新增一次性迁移 `migrateBareArtifactKeys`（sentinel：`.bare-artifact-keys-v1`），在工作区首次启动时把所有 `nodes/*.md` 里的旧 URL 形态 `src:` / `coverUrl:` 改写为裸 key，data: URL / 外部 URL / 已是裸 key 的值原样保留。

**Notes**

- 跨 canvas 复制粘贴的剪贴板载荷新增 `__sediment_canvas_id__` 字段，paste 端用它来判断是否需要克隆 artifact 到目标 canvas。从旧版本剪贴板（无该字段）粘贴时，按同 canvas 处理（不克隆）。
- 渲染节点的所有位置（PDFNode/PDFPreview、ImageNode/ImagePreview、VideoNode/VideoPreview）必须从 `useCanvasStore` 读取 `canvasId` 并传给 `resolveArtifactUrl(value, canvasId)`，否则裸 key 无法拼出正确 URL。
- Agent 路由处理 chat 附件时也支持裸 key：附件 `url` 若不是完整路径而是裸文件名，会与当前 thread 的 canvasId 配对解析。
- 删除节点不会清理 `.artifacts/` 中的对应文件 —— 上传文件被视为可独立保留的资源，避免因撤销 / 重做 / 误删而丢失原始数据。

---

## 2026-05-25 · Frame 结构化布局：自动重排 + Agent 可控

**What Changed**

- Frame 的 `column` / `row` 结构化布局现在由 canvas-engine executor 统一处理：只要 frame 的任何子节点发生**增删改大小**（包括 resize / 拖入 / 拖出 / 删除），executor 在 batch 末尾会自动重新排布子节点位置并把 frame 调整为内容贴合大小。无需 UI 层显式调用 relayout。
- 新增 `SET_FRAME_LAYOUT { frameId, mode, gridCount? }` canvas command — agent 可以直接用它把 frame 切到 `column` / `row` 模式并指定轨道数（1–12）。之前依赖 `MERGE_NODE_DATA` 写 `layoutMode` / `gridCount` 的路径已被新 command 取代（agent schema 里 `MERGE_NODE_DATA` 的 patch 字段是封闭白名单，写 `layoutMode` 会被 schema 校验拒掉，所以必须有专用 command）。

**Notes**

- 对终端用户：行为与之前一致，但更可靠 — 之前 child resize 不会触发 frame 自动适配，现在会。
- 对 agent：新的能力记录在 `skills/canvas/references/layout-recipes.md` 的 "Structured frame layout" 章节。可用于 kanban、列对比表、行 track 流程图等确定性布局。结构化 frame 的大小由内容驱动，agent 不应在同 batch 里给 frame 传 `size`。

---

## 2026-05-11 · Node label 与文件名解耦：frontmatter 保留原文

**What Changed**

- `nodes/*.md` 的 frontmatter `label:` 现在严格保存**用户/Agent 看到的原始 label**（含 `:` `?` `/` `\` 等标点和非 ASCII 字符），不再被「翻译」成文件系统安全形态。
- 文件系统里的 `.md` 文件名继续使用 `toSafeFilename(label)` 的安全形态，并在冲突时自动追加 `(2)` / `(3)` 后缀。
- 自动 dedupe 触发时，画布上显示的 label 也会跟着追加 `(2)` 后缀，但保留原始标点：例如 `"Hello: World?"` 冲突后显示为 `Hello: World? (2)`，而不再是之前那个把冒号和问号都替换成 `_` 的 `Hello_ World_ (2)`。
- 系统所有读取节点的路径（`readNode` / `listNodes` / canvas 水合 / Web 路由 / Agent 工具）都以 frontmatter `label:` 为准，不再回退到从文件名反推 label。

**Notes**

- 旧工作区的迁移修了两个会破坏文件名的 bug：
  1. 在已经迁移到新格式（只有 `label:`）的工作区上重新跑 label-naming 迁移时，原先只读 `meta.title` 会把 `My Note.md` 重命名成 `<nodeId>.md`，现在会优先读 `meta.label` 再回退到 `meta.title`，幂等安全。
  2. 为旧的 image / video / frame 节点补 `.md` 时，frontmatter 现在写新的 `label:` key 并不再写已废弃的 `content_hash` / `meta_json`。
- 这是一个保留语义的改动：现存的 `.md` 文件名不会被改动，但下一次保存这个节点时，frontmatter 里的 `label:` 会被刷新成原始（带标点）形态。

---

## 2026-05-08 · Agent 循环升级到 pi-agent-core

**What Changed**

- 服务端 agent 循环从自研 `while` 循环切换到 `@earendil-works/pi-agent-core` 的 `Agent` 类，为后续引入 read / write / edit 等文件工具铺路。
- 工具卡片现在在工具**真正开始执行**时出现（参数已通过 schema 校验），比之前模型完成 toolcall 序列化时触发更准确。
- 「最大轮次（默认 20）」从硬性 abort 改为优雅停止：到达上限时仍会完成当前 turn，把最后一条 assistant 文本送达，再附带一条「超出最大轮次」提示，而不是把整个会话标记为 interrupted。
- 中途按 Stop 中断后，刷新页面仍能在 chat panel 看到中断前已经打到一半的 AI 文本。

**Notes**

- SSE 协议、UI 组件、历史会话格式全部保持兼容；老的 `.history/<canvasId>/<threadId>.json` 直接可用，无需迁移。
- 工具卡片出现时间会**略微滞后几十毫秒**。
- # 新依赖：`@earendil-works/pi-agent-core@^0.74.0`，与已有 `pi-ai` 同版本。

## 2026-05-08 · 复制粘贴节点时连同边一起带走

**What Changed**

- 选中多个节点 Cmd+C 复制 → Cmd+V 粘贴：现在如果被选中的节点之间有连线，连线也会一起被复制过去（包括同画布粘贴和跨画布粘贴）。边的样式（颜色、虚实线、箭头方向、粗细）都会原样保留。
- 只有「两端都在选区里」的边会被带走。半截在选区外的边（比如只选了 source 没选 target）会被静默丢弃 —— 因为目标画布上没有那个对端节点可连。
- 之前只复制节点不复制边的旧行为已替换。

**Notes**

- 剪贴板 payload 新增 `__sediment_edges__` 字段（旧字段 `__sediment_nodes__` 不变），向后兼容：旧版客户端读不到 edges 字段也只会少连线、不会出错。
- Frame 节点连带子节点一起复制时，子节点之间的连线同样会跟着复制。
- 边的 ID 会重新生成（`edge-…`），不会撞到目标画布已有的边。
  > > > > > > > # 114687c (feat(canvas): preserve edges when copy/pasting nodes (cross-canvas too))

## 2026-05-08 · 跨画布复制粘贴含 artifact 节点

**What Changed**

- 在画布 A 选中一个 PDF / 图片 / 视频节点复制（Cmd+C），切到画布 B 粘贴（Cmd+V）：现在会真的把 artifact 文件本身复制一份到 B 的 `artifacts/` 目录下，并给 B 分配一个新的 artifact id。新节点的 `data.src` 自动改写成指向 B 的 URL，不再「借用」A 的文件。
- 同一画布内复制粘贴的行为不变：两个节点共享同一个 artifact 文件，避免无意义的磁盘副本。
- PDF 节点的 `coverUrl`（封面图）也会一起跨画布克隆。
- 新后端接口 `POST /api/canvas/<dst>/artifact/clone-from`，body `{ srcCanvasId, srcKey }`，返回新 artifact 的 `{ id, uri, filename, displayName, mimetype }`。

**Notes**

- 克隆走的是字节复制，所以源文件如果之后被删，目标画布不受影响。
- 如果源 artifact 已经不存在（比如源画布被删了），克隆请求会 404；前端会保留原 URL 并 console.warn，节点会显示 "File missing" 占位。
- 同名 artifact 在目标画布中通过 `<新 displayName> (2).ext` 自动去重。
  > > > > > > > # 4f05d4d (feat(canvas): clone artifact files when pasting nodes across canvases)

## 2026-05-08 · 文件系统外部改动的兜底机制

**What Changed**

- 用户在 Finder 里直接**改名 canvas 目录**：下次加载时后端会发现 dir 名跟 `canvas.json` 里的 title 不一致，把 title 同步成 dir 名（filesystem 是 source of truth），不再卡在「Canvas not found」。
- 用户在 Finder 里**改名 / 删除节点 .md 文件**：缓存的文件名索引会失效一次并重新扫盘；如果文件确实没了，节点保留在画布上，会在节点顶部显示一条「Note file missing — type to recreate it」的小条，用户随便敲几个字就会重新生成 .md；右上角带一个 Remove 按钮可以一键移除整个节点。
- 用户在 Finder 里**改名 / 删除 artifact 文件**：媒体节点（PDF / 图片 / 视频）会渲染成一个「File missing」的占位卡片，附带 Remove 按钮。
- 删除整个 `artifacts.json` manifest：下次访问 artifact 时索引会重建，loose 文件会被自动「领养」回 manifest（已有逻辑，未变）。

**Notes**

- 自愈走的是「先按缓存查 → 没找到就扫盘 → 再查一次」模式，命中率高时不会有性能损耗。
- `data.contentMissing` / `data.artifactMissing` 是后端 GET 时贴在 node data 上的 hint，前端读到就显示占位 UI；下次成功读到文件就会自动清掉，不会持久化。
- Note / Text 节点的 banner 只在内容为空时显示。一旦用户敲了字，banner 自动消失，重新写入 .md 文件。
- 这套兜底**不会**做模糊匹配 / 重链接，避免把不相关的文件错配到节点上。
  > > > > > > > # f4891b4 (feat(storage): self-heal canvas/node/artifact when files are touched outside the app)

## 2026-05-08 · 文件名改用语义化命名 + 重命名重名校验

**What Changed**

- 工作区目录、节点 markdown 文件、artifact 文件名都改成「用 label / 标题 / 文件名」直接做文件名，不再使用 ID。canvas 目录从 `<workspace>/<canvasId>/` 改成 `<workspace>/<canvas 标题>/`；节点文件从 `nodes/<nodeId>.md` 改成 `nodes/<节点 label>.md`，节点 frontmatter 新增 `id:` 字段保留稳定标识；artifact 文件从 `<artifactId>.<ext>` 改成 `<上传时的文件名>.<ext>`，多了一个 `artifacts.json` manifest 记录 id ↔ displayName 映射。
- artifact 命名优先级：用户改名 > AI 改名 > 上传原文件名 > 兜底 ID。AI 不会覆盖用户改过的名字。
- 重命名 canvas / 节点时如果会和同级别的同名项冲突（大小写不敏感、Unicode 归一化），后端返回 409，前端弹一个浏览器 alert，名字会自动恢复成原值。
- artifact URL 仍然是 `/api/canvas/<canvasId>/artifact/<artifactId>.<ext>`，不会因为改名而失效。
- 老的工作区第一次打开时会自动跑一次幂等的迁移脚本，把目录和文件名换成新的语义化名字，并把 artifact 写进 manifest。

**Notes**

- macOS / Windows 文件系统大小写处理不一致，所以重名比对一律走「全小写 + NFC 归一化」。Windows 保留名（`CON`、`PRN` 等）会被自动加 `_` 后缀。
- 文件名长度上限 120 字符；超长名字会被截断。原始 `displayName` 完整保留在 manifest 里，前端 UI 看到的仍然是完整名字。
- 节点 markdown 文件遇到重名时（在前端通过 alert 拦截之外的边界情况），后端会自动追加 `(2)`、`(3)` 之类的后缀。Frame 类型节点没有 label 时，文件名仍然回退到 ID。
- 取消编辑可以按 ESC 或者点开输入框外面：canvas 标题输入按 Enter 提交，按 ESC 还原；节点 label 双击进入编辑，按 Enter 提交，按 ESC 还原。
- 已发布给 LLM 或聊天附件的 artifact URL 不会因为后续改名而失效，因为后端通过 manifest 把 URL 里的 `<id>.ext` 反查回当前真实文件路径。
  > > > > > > > 590f53a (docs(changelog): label-based naming + rename validation)

---

## 2026-05-07 · 自动补齐：缺 label 的节点加载时自动触发 preprocessing

**What Changed**

- `loadCanvas` 加载完成后，会扫描所有需要 preprocessing 的节点（note / text / web / pdf / image / frame），凡是 label 为空的都会自动入队一次 preprocessing。
- 走的是已有的 `triggerPreprocessing` 防抖通道（每节点 1s 防抖），不会重复打到服务端。

**Notes**

- 主要兜底两类历史数据：(1) 旧版 frame 因 label 持久化 bug 丢掉的自动 label；(2) 任何首次 preprocess 没跑完就刷新的 media 节点。
- Frame 节点遵循已有规则：子节点没有任何 label 时仍然 skip（避免空 LLM 调用）。
- 如果用户/agent 已经手动设置过 label，节点已经有 label，本次 backfill 不会触碰。

---

## 2026-05-07 · 修复：Frame 自动 label 刷新后丢失

**What Changed**

- 修复了 frame 节点经 preprocessing 生成的自动 label（`labelSource: 'auto'`）在刷新后消失的问题。
- 服务端 `persistAndStripNodes` 现在只在该节点确实有 per-node markdown 标题可以回填时，才丢掉 canvas.json 上的 `label`；对于没有 markdown 文件的节点（典型例子就是 frame），auto label 会保留在 canvas.json 中。

**Notes**

- 起因：之前的策略是把 `label` 当作可重建数据丢弃，依赖加载时 `hydrateNodeContent` 从 `nodes/<nodeId>.md` frontmatter 把 title 重新装回去。Frame 节点没有 markdown 文件，所以 hydrate 阶段拿不回任何 title，刷新后 label 就空了。
- 用户/agent 设置的 label（`labelSource: 'user' | 'agent'`）的行为不变，仍然始终保留在 canvas.json 中。

---

## 2026-05-07 · 修复：Canvas 上传 PDF / 图片 / 视频失败

**What Changed**

- 修复了通过 toolbar、复制粘贴、拖拽上传 PDF / 图片 / 视频时返回 `500 Failed to save file` 的问题。
- 服务端 artifact 上传路由现在调用 `CanvasStore.writeArtifactStream()`，会在写入前自动创建 `<canvasId>/artifacts/` 目录。

**Notes**

- 起因：上传路由直接对 `artifacts/` 目录做 `createWriteStream`，但没有 `mkdirp`。任何还没写入过 artifact 的 canvas（包括所有新建 canvas）首次上传都会因为目录不存在而失败。
- 无需用户操作；重启 server 后即可恢复上传。

---

## 2026-04-30 · Annotation 识别管线精简：删除规则路径

**What Changed**

- 删除了 `classifyShape`（形状识别）和 `resolveByRules`（规则触发）两个模块，连同 `ShapeClassification` / `AnnotationShapeType` / `AnnotationNearbyNode` / `AnnotationNearbyEdge` 类型一起从前后端清理。
- 现在每一个 annotation cluster 都直接走服务端 vision LLM。规则路径不再触发任何动作，从源头消除了规则误判带来的「画一笔节点就消失了」这类问题。
- 发送给服务端的 `AnnotationClusterContext` 精简成「**只剩 ID**」：cluster bbox + stroke count + `nearbyNodeIds` / `enclosedNodeIds` / `nearbyEdgeIds`。不再发送任何 label / 位置 / 距离 / 方向 / 形状推断。
- 服务端 `recognizeAnnotationCommands` 改写成多轮 tool-calling 循环。LLM 可以在做决策前调用 `get_node_detail({ nodeId })` 工具按需读取节点的 label / content / metadata，最多 6 轮。
- 新增 `canvasId` 字段到 `AnnotationIntentRequest`，让服务端 `get_node_detail` 知道去哪个 canvas 找节点。

**Notes**

- Accept / Revert / Blend 的 overlay 行为、并发批次、详情面板这些都保持不变。
- LLM 调用次数会比以前多（原本一次就出结果，现在可能 1-3 次 tool round），延迟会稍微长一点，但识别准确率应当大幅提升。
- `AnnotationProcessingCluster.shape` 字段已删除；`source` 字段固定为 `'llm'`（不再有 `'rule'`）。如果有自定义代码读这两个字段需要更新。

---

## 2026-04-29 · Annotation 识别管线大改

**What Changed**

- 给 LLM 的结构化上下文加了 `bbox`、`strokeCount`、`shapeAlternatives`，并把 `nearbyNodes` 按 `direct/close/around` 分桶呈现，提示更清楚。

**Notes**

- 所有原有功能（Accept / Revert / Blend、并发批次、详情面板）保持不变。
- 主要受益场景：
  - 画 X 删节点 / 删边
  - 同一对节点反复连线方向不一致
  - 圈得不闭合的 circle
  - 画歪的 line / arrow
- 客户端依赖新增：`simplify-js`。

---

## 2026-04-29 · Annotation 识别支持并发批次

**What Changed**

- 在第一批 annotation 还在识别（`Pending` / `Running`）或刚到 `Done` 等用户处理时，用户继续在画布另一处画新的笔画，新一批会作为**独立请求并行执行**，不会再 abort 旧批次。
- 每个识别批次拥有自己独立的 `AbortController`，互不影响。

**Notes**

- 主动取消（如离开 annotation 工具、切换 canvas）通过 `cancelAnnotationRecognition` 一次性 abort 所有在飞批次。
- canvas 切换、笔画在识别前被删除等护栏行为保持不变；只是不再会因为"有新批次"被误伤。
- 修复回归：在已有批次处于 `Pending` / `Running` 时继续画新笔画，不会再把旧批次的 overlay 抹掉 —— 旧批次的 cluster 会原样保留，仅基于当前 pending 笔画重算新一批 `Preparing` overlay。
- 修复："LLM 看懂了但选择不操作"（返回 `commands: []` + reasoning）时，不再显示 "No intent recognised by LLM" 错误。详情面板会展示 LLM 的 reasoning，笔画照常变灰表示已处理。

---

## 2026-04-29 · Annotation 识别详情面板

**What Changed**

- Annotation cluster overlay 左上角的状态徽章（`Preparing` / `Pending` / `Running` / `Done`）现在可以点击。
- 点击后右侧 chat 面板会切换到 **Annotation Recognition** 视图，展示这次识别的完整轨迹：
  1. **User 消息**：触发的手势形状、置信度、所用空间上下文（包住 / 端点 / 邻近节点）。
  2. **Assistant 消息**：解析路径标签（`rule` / `llm`）+ reasoning 文本。
  3. **Tool 卡片**（`canvas_commands`）：复用 chat 面板已有的 canvas command 卡片渲染原始命令与变更列表，自带 Accept / Revert / Blend。
  4. **Error 行**（如有）：LLM 调用失败时显示错误信息。
- 顶部出现 ← 返回按钮，点击退出详情视图回到主聊天。
- Overlay 上原本的 Accept / Revert / Blend 按钮**保留**，可在 overlay 与详情面板任一处操作，效果一致。

**Notes**

- Annotation 识别没有真正的多步 agent tool call —— 详情面板里的"对话"是根据本地解析过程合成的，不写入 chat 历史，关闭详情视图后也不会留痕。
- Annotation 详情视图与 Question Replay 视图互斥：打开 annotation 详情时，若正在查看 question 线程会自动退出回到 canvas chat。
- 详情视图为只读，输入框被隐藏。

---

## 2026-04-29 · Annotation 识别流程的稳健性修复

**What Changed**

- 之前一批 annotation 进入 `Done` 状态后还在等用户处理时，如果继续画新的笔画，旧的 overlay（连同 Accept / Revert 入口）会被静默清掉；现在会保留旧 overlay，新一批与旧 cluster 并存。
- 同一批次内的多个 cluster 在走 LLM fallback 时，请求改为并行触发（`Promise.allSettled` 共享同一个 abort signal），多 cluster 场景下识别耗时显著下降。
- 识别开始时会绑定当前 canvasId；如果在 LLM 调用期间用户切换了 canvas，结果会被丢弃，不会再把命令打到错误的画布上。
- `triggerAnnotationRecognition` 早返回（如笔画在识别触发前就被删除）时，会清理掉残留的 `Preparing` / `Pending` overlay。

**Notes**

- 上述改动不影响交互方式：用户操作流程与按钮位置完全保持一致。
- `Done` 状态的 overlay 必须由用户主动 Accept / Revert 才会消失。

---

## 2026-04-29 · Annotation 推断结果的 Accept / Revert / Blend 操作

**What Changed**

- Annotation 推断完成后（`Done` 状态），cluster overlay 的右上角会出现 3 个图标按钮：
  - **Check（接受）**：保留 AI 生成的画布修改，并把 overlay + 灰色的 annotation stroke 一起从画布上清除。
  - **Undo2（撤销）**：把这一批 cluster 生成的所有画布修改恢复原状，并同时清除 overlay 与 stroke。
  - **Blend（对比预览）**：按住时画布临时回到修改前的样子，松手恢复当前结果。
- 操作仅作用于该 cluster 自己生成的命令；同一批次中其他 cluster 互不影响。

**Notes**

- 在状态变成 `Done` 之前（`Preparing` / `Pending` / `Running`）不会显示按钮。
- 没有任何可逆命令时，撤销与对比预览按钮会自动 disabled，但接受按钮仍可用以清除 overlay。
- 复用 ChatPanel 中 canvas command 工具消息已有的 `snapshotAndExtractChanges` 与 `useCanvasChangePreview`，行为与那边的 Accept / Revert / Blend 完全一致。

---

## 2026-04-28 · Annotation 截图与上下文增强

**What Changed**

- Annotation 推断现在按聚类（cluster）分别截图：每张截图只用一个红色边框标出当前手势的范围，不再为每条 stroke 单独打 ID 标签，画面更聚焦。
- 截图内会重新绘制画布上的连线（edges）。修复了 `html-to-image` 偶尔丢失 xyflow 内联 SVG edge 的问题，确保 LLM 能看到节点之间的现有连接。
- 发送给服务端的请求不再包含 annotation 节点 ID 列表；改为只发送 cluster 上下文 + 截图。
- Cluster 上下文新增 `Nearby edges` 字段：列出与手势相交或非常接近（≤50px）的画布边，帮助模型了解周围已有的连接关系，避免重复建边。

**Notes**

- 已执行（`executed`）的 annotation stroke 仍会以淡灰色保留显示，不受本次变更影响。
- 服务端 `/intent/recognize-annotation` 接口的 `annotationNodeIds` 字段已移除；前端 `recognizeAnnotationCommands` API 同步删除了对应参数。

---

## 2026-04-27 · Annotation 推断过程可视化

**What Changed**

- 在画布上绘制 sketch（连线 / 圈选 / 删除等手势）后等待推断时，对应的聚类区域会显示一个半透明浅灰色虚线框框，框左上角带有与 Question Node 一致的状态徽章。
- 状态会依次显示 `Preparing`（推断中）→ `Executing`（执行命令）→ `Done`（已完成），完成后约 0.7s 自动消失。

**Notes**

- 该提示完全只读，不会拦截鼠标事件；切换到非标注工具或撤销过程中正在等待的标注会即时清除浮层。

## 2026-04-27 · Note 节点高度模式与截断指示

**What Changed**

- Note 节点的高度有两种明确模式：**自动高度**（默认）与**固定高度**。自动模式下内容完整展开，不再有任何隐式上限；固定模式下保持用户手动设定的尺寸，超出部分被裁剪。
- 选中 Note 节点时，浮动工具栏新增一个 `MoveVertical` 切换按钮：高亮 = 自动模式，未高亮 = 固定模式。点击即可在两种模式之间切换。
- 当节点处于固定模式且内容被裁剪时，节点底部出现淡出渐隐，中间显示一个 `ChevronsDown` 角标按钮。

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
