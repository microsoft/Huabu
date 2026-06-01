# 功能更新日志

每次重要功能变更都会记录在此文件中，按时间倒序排列。

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
- **内存占用**：缓存只活在内存（不持久化），单 thread 平均 ~200KB，数十个并存可控；后续如果出现非常多 thread 共存的场景，会按 LRU 淘汰非活跃 thread——再次切回时从服务端 `fetchHistory` 重新拉，行为对用户透明。
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
