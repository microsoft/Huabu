# 功能更新日志

每次重要功能变更都会记录在此文件中，按时间倒序排列。

---

## 2026-05-13 · Wire/Server 边界拆分：prompt-shape 类型从 shared 退到 server

**What Changed**

- 把「LLM 看到的节点形态」（`AgentNodeRef` / `AgentNodePreview` / `AgentNodeOutline` 三段阶梯 + `buildAgentNode*` 构造器 + `extractAgentNodePreview` ladder + `toSafeFilename` 文件名规则）整体下沉到 `apps/server/src/modules/agent/node-ref.ts`，从 `@sediment/shared` 移除。前端打包不再带任何 prompt 形态相关代码。
- `@sediment/shared/types/api/agent.ts` 新增三种「线上」类型：`WireNodeRef`（id+type+label?）、`WireSelectionNode`（+ src + recursive children）、`WireCanvasNode`（+ content + src + position + size + parentId）。这些是 web 实际 POST 给服务端的形状——只搬「画布原始数据」，不计算 `filename`、不抽 `preview`、不做 `parentFrame.label` 父帧反查。
- `IntentContext.nodes` 由 `AgentNodeOutline[]` 改为 `WireCanvasNode[]`；`IntentContext.edges` 由 `Array<{source: NodeRef, target: NodeRef}>` 改为 `Array<{source: string, target: string}>`（端点只送节点 id，服务端按需查类型/标签）。
- `AnnotationClusterContext` 与 `AnnotationContext` 的 `nearbyNodes` / `enclosedNodes` 由 `AgentNodeRef[]` 改为 `WireNodeRef[]`，服务端在拼 prompt 之前再调 `buildAgentNodeRef` 加上 `nodes/<safeLabel>.md` 路径。
- 顺手修了一个老 bug：`resolveAddNodes` / `resolvePasteClipboard` 写入 `RecentAction.node_created.nodes` 时字段名一直是 `nodeType`（应为 `type`），所以服务端 intent 上下文渲染时读到的一直是 `undefined`。

**Notes**

- 没有持久化数据迁移：所有变化都在「画布到服务端的 JSON 报文形状」与「服务端到 LLM 的 prompt 形状」两层之间发生，磁盘上的 `canvas.json` / `nodes/*.md` / `events.jsonl` 无任何字段调整。
- 行为收益：之后想改 prompt 形状（preview 长度、`filename` 命名规则、是否带 `parentFrame.label`），只改 server 不需要 web 重新发布。
- 对外部脚本/工具的影响：直接 POST `/api/intent/recognize*` 的脚本，`nodes[i]` 字段名从 `parentFrame: {id, label?}` 退到 `parentId: string`，且不再带 `filename` / `preview`。`edges[i].source` / `edges[i].target` 从对象退化为字符串 nodeId。

---

## 2026-05-13 · Agent 节点引用统一为 AgentNodeRef 阶梯（外部协议变更）

**What Changed**

- 所有传给 LLM 的「这是一个节点」载荷现在共用一条阶梯：`AgentNodeRef`（id+type+label?+filename，最小集合）→ `AgentNodePreview`（+ preview 文本）→ `AgentNodeOutline`（+ position+size+parentFrame?）。`get_canvas_outline` / `inspect_nodes` 返回的节点字段名从 `parentId` / `width` / `height` 改为 `parentFrame: { id, label? }` / `size: { width, height }`，并新增 `filename` 字段（pre-computed `nodes/<safeLabel>.md`，可直接喂给 `read`）。
- 选中节点（`AgentChatContext.selectedNodes` / `IntentContext.selectedNodes`）的线上类型从 `SelectionPayload` 改名为 `WireSelectionNode`，shape 不变。Annotation cluster context 的 `nearbyNodes` / `enclosedNodes` 改用 `AgentNodeRef`。
- 节点 preview 抽取规则简化为 `summary > content[:120] > src`——**舍弃了 `keywords` 拼接回退**：之前没有 summary 但有 keywords 的节点会回退成 `kw1, kw2, kw3` 字符串，现在直接落到 `content[:120]` 或 `src`。
- 共享构造器 `buildAgentNodeRef` / `buildAgentNodePreview` / `buildAgentNodeOutline` 从 `@sediment/shared` 导出，server 与 web 各自的临时拼装代码（agent.route.ts / annotation.service.ts / canvas-spatial.ts / node-neighbourhood.ts / canvasStore.ts / annotation/context.ts）全部改用统一构造器。
- `IntentContext.edges` 的 `NodeRef` 字段从 `nodeType` 改名为 `type`。

**Notes**

- 这是一次纯类型/字段重构 + 一次 Agent 工具响应 schema 变更：调用 `get_canvas_outline` 或 `inspect_nodes` 的本地脚本/外部工具如果硬编码读 `nodes[i].parentId` / `nodes[i].width` / `nodes[i].height`，必须改为 `nodes[i].parentFrame?.id` / `nodes[i].size.width` / `nodes[i].size.height`。
- 关键收益：先前**不带 keywords 兜底**的 outline preview 与节点邻域 preview 现在保持一致，且 LLM 拿到节点 ref 时会同时拿到 `filename` 字段——再也不用根据 label 推 safeFilename，避免之前因空格/标点拼错 path 而 404 的 `read`。
- 数据盘上不存在迁移：所有变化都是「在内存中拼装给 LLM 的 JSON 形态」。无需重启或重建索引。

---

## 2026-05-12 · Agent 配置统一为 AGENT.md 单文件

**What Changed**

- 每个 agent（`ask` / `operate` / `intent` / `annotation`）的系统提示词、可用工具列表、运行时参数（`maxIterations` / `toolExecution` / `defaultOrigin`）现在统一写在一份 `apps/server/src/prompt/agents/<id>/AGENT.md` 配置文件里——YAML frontmatter 声明元信息与工具，Markdown body 即系统提示词。
- 调用端通过新的 `loadAgent(id)` API 读取配置，原本散落在 `prompt/agent.ts`、`prompt/intent.ts` 中的硬编码字符串、以及 `tools/index.ts` 里硬编码的 `askTools / operateTools / annotationTools` 工具数组都已删除。
- 模板支持 `{{skillCatalogue}}` 变量（自动按 `skillScope` 注入 SKILL.md 目录摘要），以及 `{{#skillCatalogue}}…{{/skillCatalogue}}` 条件块（无技能时整段省略）。

**Notes**

- 修改 prompt 或工具组合现在只需编辑对应的 `AGENT.md`，不再需要改 TS 代码——加载器在启动时严格校验 frontmatter，错误会立即抛出。
- 工具的 TypeBox schema 与 handler 仍然在 `modules/agent/tools/definitions.ts` 用 TypeScript 编写并注册到 `TOOL_REGISTRY`，AGENT.md 只通过 `name` 引用——schema 形态不适合塞进 YAML。
- 此前硬编码在 `annotation.service.ts` 中的 `ANNOTATION_MAX_ITERATIONS = 6` 与 `origin: { type: 'annotation-recognized' }` 现在分别由 `annotation/AGENT.md` 的 `runtime.maxIterations` 和 `runtime.defaultOrigin` 提供。
- 没有用户可见的运行时行为变化——是纯重构。

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

## 2026-05-09 · Frame 节点也生成 `.md` 文件

**What Changed**

- frame 节点不再是“完全只存在 `canvas.json` 里”了，会在 `nodes/` 目录下生成一个对应的 `.md`，格式与 image / video 一致——只有 frontmatter（`id`、`type: frame`、`title`），没有正文。
- 现在会生成 `.md` 的节点类型全集：note / text / web / pdf / image / video / **frame**。
- 打开旧工作区时会自动补齐：scan `canvas.json` 里现有的 frame 节点，谁没有对应 `.md` 就为谁生成一份。

**Notes**

- frame 重命名会跟着改它的 `.md` 文件名，同样会被 `tryRename` 检查同画布内重名冲突。
- frame 在 `canvas.json` 里仍然保留子节点层级等拓扑信息，`.md` 只是多一份可读的元数据限定。
- 仍然不生成 `.md` 的节点类型：annotation、question、intent。

---

## 2026-05-09 · Note 文件缺失占位 UI 与媒体节点对齐

**What Changed**

- Note 节点的 `.md` 文件在 Finder 里被删掉 / 改名后，原本顶部那条小灰带「Note file missing — type to recreate it」改成跟 PDF / 图片 / 视频节点一致的居中占位卡片：图标 + 「Note file missing」标题 + 一句说明 + 醒目的「Remove from canvas」按钮。
- 占位状态下编辑器不再显示，节点工具栏也会临时隐藏，避免在「文件已经没了」的节点上做编辑操作。

**Notes**

- 触发条件不变：只有当后端给的 `data.contentMissing` 为 true **且** 节点目前没有可回退的内存内容时才会显示这张卡片。
- 「敲字直接重建 .md」的旧行为下线了：现在只能选择「Remove from canvas」清掉孤儿节点，或者直接在 Finder 里把 .md 放回来。

---

## 2026-05-09 · Artifact 存储改造：隐藏目录 + 节点级 .md

**What Changed**

- 工作区里 `artifacts/` 目录现在改名为 `.artifacts/`（隐藏），并且 `artifacts.json` 清单文件被彻底删除。文件名不再依赖 displayName，统一就是 `<artifactId><ext>`，URL 与磁盘路径一一对应。
- 每一个有原始文件的节点（pdf / image / video / web / note / text）现在都会在 `nodes/` 下生成一个对应的 `.md`：text / web / pdf / note 的 `.md` 里有正文 + frontmatter；image / video 的 `.md` 只有 frontmatter（指向 `.artifacts/` 里的文件）。
- 不会生成 `.md` 的节点类型：**annotation、question、intent**。它们的全部信息只存在 `canvas.json` 里。（frame 节点随后也加入了 `.md` 体系，详见上面的条目。）
- 打开旧工作区时会自动迁移：`artifacts/` 重命名为 `.artifacts/`、按清单把文件名改为 `<artifactId><ext>`、清单文件删除、所有 image / video 节点补齐对应的 `.md`。整个过程是幂等的，重复打开不会出问题。

**Notes**

- 上传 / 克隆 artifact 的接口签名简化：不再接受 `displayName` / `source` 字段；服务端只关心 id 和扩展名。前端没有用到这些字段，行为没有可见变化。
- 节点 `.md` 的文件名仍然按节点标题生成（清理过非法字符），改名节点会改 `.md` 文件名；artifact 的文件名固定为 id，不会跟着节点标题走。
- 导出 `.sediment.zip` 时会一并打包 `.artifacts/`，对方导入后所有附件都能直接用。
- 如果你以前手动改过 artifact 文件名，迁移会保留你的改动（因为 URL 键 = 文件名）。

---

## 2026-05-10 · 修复：Annotation Agent 偶尔触发 `handler is not a function` 崩溃

**What Changed**

- **修复 annotation agent 返回未知命令类型时画布执行器崩溃的问题**。当 LLM 在批注识别（红色手绘 → canvas 命令）阶段产出一个超出 schema 的 `type`（拼写错误、小写、或臆造的命令名）时，前端 `executor.ts` 直接拿 `HANDLERS[cmd.type]` 当函数调用，触发 `Uncaught TypeError: handler is not a function`，整批命令全部丢失且后续 annotation 流水线状态卡死。
- 修复方式：
  - **服务端 `apps/server/src/modules/agent/intent.service.ts`**：在 `recognizeAnnotationCommands` 解析 LLM JSON 后，按共享常量 `AGENT_CANVAS_COMMAND_TYPES` 过滤命令，对未知 `type` 记 `console.warn` 并丢弃，再返回给前端。
  - **前端 `apps/web/src/handler/canvasCommand/executor.ts`**：作为兜底，若 `HANDLERS[cmd.type]` 不存在则 `console.warn` 并把该命令记为 `applied: false, reason: 'no-op'` 后跳过；同步给 `COMMAND_META` 的下游读取加上可选链。

**Notes**

- 影响范围：annotation agent（手绘红色批注 → 自动转成画布命令）。Operate agent 走 `canvas_commands` 工具时本来就经过 TypeBox `validateToolCall`，不会遇到这个问题。
- 当 LLM 偶尔产出错命令时，现在会跳过该条但其余正确命令仍会执行；overlay 状态会进入 `done`，方便用户接受/撤销其余有效部分。
- 控制台会打印 `[annotation-intent] dropping unknown command type from LLM output: …` 和 `[canvas-executor] Unknown command type — skipping: …` 帮助定位 prompt / skill 中导致 LLM 走偏的指令。

---

## 2026-05-10 · 修复：Agent 在 operate 模式下声称已修改画布但实际未生效

**What Changed**

- **修复 `canvas_commands` 工具结果被前端静默丢弃的问题**。Agent 调用 `canvas_commands`（连接节点、修改节点内容、创建节点等）后，消息列表会显示"已执行"，但画布上没有任何变化。
- 根因：服务端 `handleCanvasCommands` 在错误处理重构（提交 `056f4f3`）时去掉了 `{ tool, status: 'success', data: { … } }` 外层包装，直接返回 `{ source, canvasId, commands }`；但前端 `useAgentStream` 的 `applyCanvasCommandsFromToolResult` 仍然按旧 schema 检查 `parsed.status === 'success' && parsed.data.commands`，匹配失败 → 静默返回 `null` → `executeCommands` 从未被调用。
- 修复方式：在 `apps/web/src/hooks/useAgentStream.ts` 中调整解析器，按服务端当前真实输出形状读取顶层 `commands` 字段，并通过 `status === 'error'` 显式跳过错误信封。

**Notes**

- 影响范围：所有 operate 模式下经 `canvas_commands` 工具产生的画布变更（CREATE_NODES / CONNECT_NODES / MERGE_NODE_DATA / DELETE_NODES / SET_NODE_PARENT / DISSOLVE_FRAME / SET_NODE_GEOMETRY / REORDER_NODES / DISCONNECT_EDGES / SET_EDGE_STYLE / ALIGN_NODES / DISTRIBUTE_NODES / AUTO_LAYOUT）。
- Annotation / sketch intent 流不受影响 — 这些路径不经 `canvas_commands` 工具，命令以 JSON 形式从 LLM 直接返回。
- 历史会话回放：之前 Agent "假装"执行过的命令已经在服务端记录中标记为成功，但磁盘上没落盘。重新触发同一指令即可让 Agent 重新生成命令并真正执行。

---

## 2026-05-10 · Skill 体系收敛为 `canvas` + `annotation` 两层结构

**What Changed**

- **从三个 flat skill 收敛为一个核心 skill + references 的层级结构**。原来的 `canvas-commands` / `canvas-tools` / `build-flowchart` 三个 SKILL 合并为单一 `skills/canvas/SKILL.md`：心智模型 + 工具决策矩阵 + 命令目录都在入口文件里，深度内容下沉到 `references/`：
  - `skills/canvas/references/command-cookbook.md` — 组合 batch 套路（brainstorm / merge / 入框 / restyle / tidy …）。
  - `skills/canvas/references/layout-recipes.md` — 坐标系 + 层级 / 流向 / 网格布局 + 行轨道 flowchart 配方。
- **annotation 流水线独立成 `skills/annotation/SKILL.md`**，frontmatter `appliesTo: [annotation]`，只在 annotation prompt 的 catalogue 里出现，不污染 operate / chat / external 上下文。
- **`resolveSkillPath` 支持 references 子路径**：`read("skills/<id>/references/<file>.md")` 走和 `read("skills/<id>/SKILL.md")` 完全相同的解析路径（per-canvas override → global），并加了路径转义防御（`..` 越界返回 null）。
- **`agent.ts` 删除 inline 的 Layout strategies 段**（≈30 行），改为指向 `skills/canvas/SKILL.md`；catalogue 现在自动渲染为单行 `- canvas — …`。
- **`intent.ts` 的 ANNOTATION prompt 删除 inline 的 Gesture interpretation / Rules / CanvasCommand reference 段**（≈40 行），改为同一个指向 skill 的提示。
- **`canvas_commands` 工具描述里的 skill 链接** 同步从 `skills/canvas-commands.md` 改为 `skills/canvas/SKILL.md`。

**Notes**

- 兼容性：旧路径 `read("skills/canvas-commands.md")` / `read("skills/canvas-tools.md")` / `read("skills/build-flowchart.md")` 不再可用。仓库内已无残留引用，per-canvas override 若曾使用同名文件需要随之改名（一般情况下用户层不会有）。
- Catalogue 内容：`operate` / `ask` / `external` 各看到 1 个 skill（`canvas`）；`annotation` 看到 2 个（`annotation` + `canvas`）。
- 详见 [docs/agent-architecture.md](../agent-architecture.md) §3 Skill 设计。

---

## 2026-05-10 · Agent skill 系统数据化：`use_skill` 工具下线，改用 `read("skills/<id>/SKILL.md")`

**What Changed**

- **Skill 内容从 TS 字符串迁到磁盘 markdown**。每个 skill 现在是一个 `apps/server/src/prompt/skills/<id>/SKILL.md` 文件，带 YAML frontmatter（`id / name / description / appliesTo / triggers? / version?`）。新增加载器 `skill-loader.ts` 在启动期扫盘 + 校验，frontmatter 不合法直接抛错。
- **`use_skill` 工具被删除**。Agent 不再通过专门的工具调用拿 skill，而是用现有的 `read` 工具读 `skills/<id>/SKILL.md`。所有 agent（内置 / Copilot / Codex / Claude Code）只要有文件读权限就能用，不再需要专门集成。
- **支持 per-canvas skill 覆盖**：`<canvas>/skills/<id>/SKILL.md` 优先于全局 skill；skill 的补充材料可放在同目录下的 `skills/<id>/references/...`。
- **抽出两个 skill**：`canvas-commands`（命令语义 + 组合套路）和 `canvas-tools`（read / inspect_nodes / inspect_edges / grep 边界与决策矩阵）。`agent.ts` 与 `intent.ts` 中对应的长段已替换为指向 skill 的一句话；`canvas_commands` 工具描述也大幅瘦身，schema 仍由 TypeBox 单一来源决定。

**Notes**

- 兼容性：`use_skill` 是 LLM 可见的工具名，移除属于 agent 接口变更。已检查全 repo 无前端 / shared 调用。任何残留的旧 prompt 提到 `use_skill` 都已替换。
- 提示词体积：operate prompt 5106 字符（含动态 catalogue），annotation prompt 3650 字符，`canvas_commands` 工具描述从 ~1.7K 降到 912 字符。
- 详见 [docs/agent-architecture.md](../agent-architecture.md) §3 Skill 设计。

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
- 新依赖：`@earendil-works/pi-agent-core@^0.74.0`，与已有 `pi-ai` 同版本。

---

## 2026-05-08 · 复制粘贴节点时连同边一起带走

**What Changed**

- 选中多个节点 Cmd+C 复制 → Cmd+V 粘贴：现在如果被选中的节点之间有连线，连线也会一起被复制过去（包括同画布粘贴和跨画布粘贴）。边的样式（颜色、虚实线、箭头方向、粗细）都会原样保留。
- 只有「两端都在选区里」的边会被带走。半截在选区外的边（比如只选了 source 没选 target）会被静默丢弃 —— 因为目标画布上没有那个对端节点可连。
- 之前只复制节点不复制边的旧行为已替换。

**Notes**

- 剪贴板 payload 新增 `__sediment_edges__` 字段（旧字段 `__sediment_nodes__` 不变），向后兼容：旧版客户端读不到 edges 字段也只会少连线、不会出错。
- Frame 节点连带子节点一起复制时，子节点之间的连线同样会跟着复制。
- 边的 ID 会重新生成（`edge-…`），不会撞到目标画布已有的边。

---

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

---

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

---

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
