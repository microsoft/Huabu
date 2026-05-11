# Agent Context 设计文档

> 本文记录当前 Sediment / Huabu 把"画布上的思考"传递给 AI Agent 的完整链路:
> 暴露了哪些信号、它们如何到达模型、还有哪些可以优化的方向。
>
> 对应原则:README 中的 **Externalize Thinking** 与 **Share Cognitive Space**。

---

## 1. 总览

Agent 接收的所有上下文最终都收敛到一个结构体:

- **类型**: `AgentBaseContext` —
  [packages/shared/src/types/context.ts](../packages/shared/src/types/context.ts)
- **拼装位置**(浏览器): `useCanvasStore.getAgentContext()` —
  [apps/web/src/store/canvasStore.ts](../apps/web/src/store/canvasStore.ts)
- **请求入口**: `POST /api/agent`,请求体为 `AgentRequest` —
  [apps/web/src/api/agent.ts](../apps/web/src/api/agent.ts)
- **服务端拼接进 prompt**: [apps/server/src/modules/agent/agent.route.ts](../apps/server/src/modules/agent/agent.route.ts)

整体数据流:

```
浏览器 canvasStore.getAgentContext()
   │   抽取 snippet / selected / spatial / recentActions
   ▼
POST /api/agent  body = AgentRequest {
    content, threadId, mode,
    canvasContext: AgentBaseContext,
    canvasId, attachments,
    selectedNodeIds, intentData
}
   │
服务端 agent.route.ts
   ├─ loadContext(threadId, canvasId)        # 从磁盘加载历史 pi-ai Context
   ├─ collectImageAttachments()              # 选中的 image 节点抽 URL
   ├─ buildNodeSummaries(canvasId, ids)      # 仅对选中节点注入 enrich 摘要
   │     └─ 推一条 [SYSTEM Context] 系统消息
   ├─ buildUserContent(text, attachments)    # 构造多模态 user message
   └─ llmStream(context)                     # 进入 LLM
   │
   ▼ 工具循环
read / grep / find / ls / get_canvas_outline / inspect_nodes / inspect_edges /
canvas_commands / web_search / use_skill ...
```

---

## 2. 当前暴露给 Agent 的所有信号

### 2.1 节点级信号

| 字段                                  | 范围         | 内容                                                                                                                                                          | 来源                                                                   |
| ------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `nodes: NodeSummary[]`                | **全部节点** | `id` / `type` / `label` / `snippet`(前 120 字符)/ `frameLabel` / `position` / `size`                                                                          | [extractSnippet](../apps/web/src/handler/canvasCommand/utils/index.ts) |
| `selectedNodes: SelectedNodeDetail[]` | **当前选中** | `id` / `type` / `label`,image 节点带 `src`,frame 节点带 `children`(递归)。**不携带 `content` / `position` / `size` / `origin`**——节点正文与布局都靠工具按需取 | [buildSelectedDetail](../apps/web/src/store/canvasStore.ts)            |

> **关键限制 1**:`NodeSummary.snippet` 是 `content.slice(0, 120)` 的纯截断
> (见 [extractSnippet](../apps/web/src/handler/canvasCommand/utils/index.ts)),
> **不会**使用 enrich 阶段生成的 `summary`。
>
> 关键限制 2：`SelectedNodeDetail` 同样**不发节点正文**，只是
> “哪些节点被选中 + 这些节点的元数据”。Agent 想读完整内容必须调用
> `read("nodes/<nodeId>.md")`，布局 / 样式 / 空间关系调
> `inspect_nodes({ ids: ["<nodeId>"] })`。
> 对选中节点而言,服务端还会通过 `buildNodeSummaries` 把 enrich 的
> `summary + keywords` 注入一条**单独的系统消息**(见 §2.5)。

### 2.2 结构信号

| 字段           | 内容                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------- |
| `edges`        | 仅 `{ source, target }` 对。**无关系语义、无方向语义、无标签**                                    |
| Frame 包含关系 | **隐式**:通过 `NodeSummary.frameLabel` 与 `SelectedNodeDetail.children` 表达,没有显式 `frameTree` |

> **空间结构（clusters / arrangement / 几何）现在不再随 `AgentBaseContext` 下发**。
> Agent 通过 `get_canvas_outline()` 拿一次"画布地图"（节点几何 + 边 + 聚类），
> 用 `inspect_nodes` / `inspect_edges` 做按需查询。底层算法仍是
> [packages/shared/src/utils/spatial.ts](../packages/shared/src/utils/spatial.ts)
> 的 `buildSpatialSummary` 等函数，封装在
> [apps/server/src/modules/canvas/canvas-spatial.ts](../apps/server/src/modules/canvas/canvas-spatial.ts)。

### 2.3 视觉信号

- **screenshot** —
  [apps/web/src/handler/canvasCommand/utils/screenshot.ts](../apps/web/src/handler/canvasCommand/utils/screenshot.ts)
  - 通过 `html-to-image` 截 `.react-flow__viewport`,3× 倍率,base64 PNG。
  - **普通对话不发**;仅在 [intent 识别](../apps/server/src/prompt/intent.ts) 时附带。
  - 截图会做"标注增强":最近动作的节点画红框、左上角红色 banner 写
    `Last step: <action description>`,annotation 笔触以红色高亮。
- **annotation 笔触**:作为节点存在,但 `points` 几何数据 **不进 Agent 上下文**;
  仅在 intent 截图里以红色笔触可见。

### 2.4 时间 / 动作信号

- `recentActions: RecentAction[]` —
  [packages/shared/src/types/context.ts](../packages/shared/src/types/context.ts)
  - 环形缓冲,**最多 10 条**,16 种动作类型(`node_created` / `node_edited` /
    `node_moved` / `node_connected` / `node_framed` / `canvas_undone` / …)
  - **没有时间戳**,Agent 看不到动作发生的节奏。
- 聊天历史:服务端按 `canvasId + threadId` 隔离,从磁盘
  `.history/<canvasId>/<threadId>.json` 加载 pi-ai `Context`(系统 prompt
  - 全部消息 + tools),与本次 `canvasContext` 合并。
    实现:[apps/server/src/modules/agent/store/chat-store.ts](../apps/server/src/modules/agent/store/chat-store.ts)。

### 2.5 用户意图 / 选择信号

- `selectedNodeIds[]`:除了 `canvasContext.selectedNodes` 外,在 `AgentRequest`
  顶层另带一份 id 列表。服务端会用它调用 `buildNodeSummaries`,把
  **预处理 enrich 出的 `summary + keywords`** 拼进一条
  `[SYSTEM Context]\n[Selected Nodes (id / label / type only — read "nodes/<id>.md" for content, inspect_nodes({ ids: [...] }) for layout / style / spatial relations)]`
  系统消息。
  > **这是目前唯一一条让 enrich 摘要进入上下文的路径**,且只覆盖选中节点。
- `attachments[]`:用户聊天时显式贴入的图 / PDF / 文本 / 链接。
- `intentData`:候选意图列表 + 用户最终选定的那一条 —
  [packages/shared/src/types/agent.ts](../packages/shared/src/types/agent.ts)。

### 2.6 节点内容信号(默认不进上下文)

节点正文与 enrich 摘要默认 **不进** 初始上下文,Agent 通过工具按需获取:

| 工具                          | 返回                                                   | 何时调用                       |
| ----------------------------- | ------------------------------------------------------ | ------------------------------ |
| `read(path)`                  | 画布文件完整内容 + frontmatter（常用 `nodes/<id>.md`） | NodeSummary 截断不够用时       |
| `grep` / `find` / `ls`        | 在画布文件夹内检索 / 列出文件                          | 需要跨节点查找或枚举文件时     |
| `get_canvas_outline()`        | 一次取全画布几何 + 连线 + 空间 cluster                 | 刚进入画布需要一份“地图”       |
| `inspect_nodes(args)`         | 谓词驱动的节点查找 + 完整几何 / 样式 / 派生字段        | 查某个节点位置、邻近、连接 …   |
| `inspect_edges(args)`         | 边的完整 EdgeStyle（方向 / 虚线 / 颜色 …）             | 边的样式 / 过滤                |
| `canvas_commands(commands[])` | 执行 CREATE / DELETE / CONNECT 等                      | operate 模式做实际改动         |
| `use_skill(skillId)`          | 技能引导文本                                           | 复杂工作流（画流程图、提纲等） |
| `web_search(query)`           | Tavily 网络搜索结果                                    | 需要时新信息                   |

工具定义见 [apps/server/src/modules/agent/tools/definitions.ts](../apps/server/src/modules/agent/tools/definitions.ts)。

### 2.7 模式与全局信号

- `mode: 'ask' | 'operate'`,决定使用哪份系统 prompt:
  - ask: [apps/server/src/prompt/system.ts](../apps/server/src/prompt/system.ts)
  - operate: [apps/server/src/prompt/agent.ts](../apps/server/src/prompt/agent.ts)
    (附 skill catalogue)
- `canvasId` 会传给服务端用于鉴权与定位,但 **画布标题 / 工作区路径 / 其他 canvas 列表 / 用户偏好** 都不会进入上下文。

### 2.8 当前**未**暴露的信号(机会点)

- 视口 pan / zoom、当前可见节点
- 鼠标 hover、cursor 位置
- 节点 provenance(BlockProvenance:作者、时间、AI 修改痕迹、pending diff)
- 节点 **认知状态**(草稿 / 已确认 / 问题 / 归档)——尚未建模
- annotation 笔触的几何或语义解读(只在截图里给 LLM 看)
- **非选中节点**的 enrich summary(只对选中节点注入)
- 工作区路径、其他 canvas 列表、canvas title
- 用户偏好 / 设置

---

## 3. 信号汇总速查表

| 类别                   | 是否进入初始上下文       | 是否截断                             | 获取方式                                 |
| ---------------------- | ------------------------ | ------------------------------------ | ---------------------------------------- |
| 全部节点               | ✓ `NodeSummary[]`        | snippet 120 字符 (无 enrich summary) | `AgentBaseContext.nodes`                 |
| 选中节点元数据         | ✓ `SelectedNodeDetail[]` | 仅元数据,**不含正文**                | `AgentBaseContext.selectedNodes`         |
| 选中节点完整正文       | ✗ 必须工具               | —                                    | `read("nodes/<id>.md")`                  |
| 边                     | ✓ source/target 对       | —                                    | `AgentBaseContext.edges`                 |
| 空间布局               | ✗ 必须工具               | —                                    | `get_canvas_outline()` / `inspect_nodes` |
| 最近动作               | ✓ 最近 10 条             | 无时间戳                             | `AgentBaseContext.recentActions`         |
| Frame 层级             | ✓ 隐式(label + children) | —                                    | `NodeSummary` / `SelectedNodeDetail`     |
| 聊天历史               | ✓ pi-ai Context 加载     | —                                    | 磁盘 `.history`                          |
| 截图                   | ✗(仅 intent)             | —                                    | intent 端点 / 工具调用                   |
| 节点完整文本           | ✗ 必须工具               | —                                    | `read("nodes/<id>.md")`                  |
| 预处理摘要 / 关键词    | 选中节点 ✓、其他 ✗       | —                                    | `buildNodeSummaries` / hydrate           |
| 选中节点的 enrich 摘要 | ✓ 单独一条系统消息       | —                                    | `buildNodeSummaries`                     |
| 视口 / 缩放            | ✗ 未暴露                 | —                                    | —                                        |
| 用户偏好               | ✗ 未暴露                 | —                                    | —                                        |
| 工作区上下文           | ✗ 仅 canvasId            | —                                    | —                                        |

---

## 4. 已识别的痛点

1. **Snippet 截断且未用 enrich**:`NodeSummary.snippet` 是 `content` 的前
   120 字符纯截断,**没有**使用 enrich 阶段已生成的 `summary`。Agent 想要更
   完整的理解必须额外调 `read("nodes/<id>.md")`，大画布场景下 tool call 次数
   显著增加。
2. **选中节点也不发正文**：`SelectedNodeDetail` 仅含元数据，Agent 即便
   面对用户明确选中的节点，要读正文也要再发一次 `read`。
   服务端虽然为选中节点注入了 enrich 的 `summary + keywords` 系统消息,
   但完整正文仍走工具。
3. **Enrich 摘要利用不充分**:预处理流水线
   ([apps/server/src/modules/preprocessing/stages/enrich.ts](../apps/server/src/modules/preprocessing/stages/enrich.ts))
   已为可摄取节点生成 `summary + keywords`,但仅在节点被选中时通过单独
   的系统消息注入;非选中节点的高质量摘要在 `NodeSummary` 中完全没用。
4. **结构信号弱**:edges 无关系语义,frame 包含关系靠 `frameLabel` 字符串
   隐式表达,Agent 难以做层级遍历或语义推理。
5. **思考状态缺位**:草稿 / 待验证 / 已确认 / 问题等"中间认知状态"没有
   建模,无法被 Agent 区分对待。
6. **Provenance 丢失**:节点上的 BlockProvenance(作者、时间、AI 修改痕迹、
   pending diff)未传给 Agent,可能导致 AI 反复改自己的草稿、误覆盖用户内容。
7. **视觉布局对 LLM 不可见**：常规对话不发截图，Agent 只能从坐标和
   `get_canvas_outline` / `inspect_nodes` 的输出推断画布外观；sketch /
   annotation 的几何意图丢失。
8. **动作无时间戳**:`recentActions` 不含 timestamp,Agent 看不出节奏
   (连续操作 vs 隔了很久才回来)。
9. **跨 canvas 隔离**:Agent 不知道工作区还有哪些 canvas,无法形成跨画布
   的工作记忆。

---

## 5. 优化方向

按 **改动面 / 收益 / 实施顺序** 分四档。

### Tier 1 · 立即收益,改动最小

- **T1-A 全节点 aiDigest** —
  把 enrich 输出从"仅选中"扩到"全部 `NodeSummary`":

  ```ts
  interface NodeSummary {
    aiDigest?: {
      summary?: string;
      keywords?: string[];
      sourceId?: string;
      contentLength?: number; // 帮 Agent 估"是否值得展开"
    };
  }
  ```

  服务端在收到请求后批量查 `metaJson` 注入,**不动持久化、不动前端 store**。

- **T1-B RecentAction 加时间戳并扩到 ~20 条** —
  在 `pushAction` 加 `at: Date.now()`,让 Agent 看到节奏。

- **T1-C 显式 `recentlyFocused: NodeRef[]`** —
  暴露过去 N 秒内 hover / select / edit 过的节点,让 Agent 理解
  "用户在哪一片区域工作",不要求显式选中。

### Tier 2 · 中等改动,直接对齐 Externalize Thinking

- **T2-A 显式结构索引**:
  ```ts
  interface AgentBaseContext {
    structure?: {
      frameTree: Array<{
        frameId: string;
        parentFrameId?: string;
        childNodeIds: string[];
      }>;
      edgesByNode: Record<string, { in: string[]; out: string[] }>;
    };
  }
  ```
  从现有 nodes / edges 派生即可,不动持久化。
- **T2-B 边语义化**:`EdgeStyle.semantic?: 'supports' | 'contradicts' | 'derives' | 'references'`,
  允许用户 / Agent 标注。
- **T2-C 节点认知状态**:
  ```ts
  interface BaseNodeData {
    epistemicStatus?: 'draft' | 'confirmed' | 'question' | 'archived';
  }
  ```
  透传到 `NodeSummary`。prompt 加规则:`confirmed` 节点改动需要谨慎、
  `question` 节点优先纳入 intent 候选。
- **T2-D Provenance 进 SelectedNodeDetail**:
  把 BlockProvenance(`author / createdAt / aiModified / pendingDiff`)
  透传给 Agent,避免 AI 反复改自己的草稿、误覆盖用户内容。

### Tier 3 · 让 Agent 真正"看见"画布

- **T3-A 视口 / 焦点信号**:
  ```ts
  interface AgentBaseContext {
    viewport?: { x: number; y: number; zoom: number; visibleNodeIds: string[] };
  }
  ```
  React Flow 已有 transform,实施成本低。
- **T3-B 常规对话可选附带视口截图**(opt-in 开关):
  复用现有 [screenshot.ts](../apps/web/src/handler/canvasCommand/utils/screenshot.ts),
  对"帮我看看这片区域"类问题提升巨大。
- **T3-C Annotation 几何 → 结构化语义**:
  把 strokes 经一层简化(包围盒 / 圈住的节点 ids / 形状粗判:
  circle / arrow / cross),作为 `annotationSemantic` 字段。
  Agent 不必依赖图像也能理解"用户圈住了 A、B、C"。

### Tier 4 · 让"思考的轨迹"外化(长远)

- **T4-A 把 thought 镜像到 vault 的人类可读文件**:
  - Note 节点已经在 `sources/*.md`,把 `summary / keywords / epistemicStatus`
    写到 YAML frontmatter。
  - Canvas 状态 / digest 镜像出 `<canvasId>.digest.json`。
  - 价值:同一份格式被 **人类、Agent、未来导出工具** 共享消费,
    真正实现"画布是共享认知空间"。
- **T4-B 跨 canvas 轻索引**:
  ```ts
  interface AgentBaseContext {
    workspaceContext?: {
      canvases: Array<{
        canvasId: string;
        title: string;
        lastUpdated: string;
        topKeywords: string[];
      }>;
    };
  }
  ```
  搭配 `list_canvases / open_canvas_summary` 工具,让 Agent 知道工作区
  还有什么。

---

## 6. Context 分发策略(按功能切片)

前文的 Tier 1–4 是"我们能加什么";本节回答的是 **"加完之后,每个功能各自该
默认看到什么、该靠工具按需取什么"**。这是一份全局的分发契约,避免出现
"所有 LLM 调用都把所有 context 一股脑塞进去"的失控状态。

### 6.1 思想分层(再次明确)

| 层  | 字段                                                             | 谁产生            | 默认是否进上下文       | 真要的时候怎么拿                               |
| --- | ---------------------------------------------------------------- | ----------------- | ---------------------- | ---------------------------------------------- |
| L0  | `id` / `type` / `label` / `frameId` / `position` / `size`        | 用户 + 系统       | **总是**(Always-on)    | —                                              |
| L1  | `summary`(1–3 句)/ `keywords` / `origin` / `epistemicStatus`     | enrich + 用户标注 | **大多数 AI 功能默认** | 工具 `get_node_digest`                         |
| L2  | `content`(markdown)/ `contentJson` / `provenance` / `highlights` | 节点本体 + 历史   | **永远不默认**         | 工具 `read("nodes/<id>.md")` / `inspect_nodes` |

L0 是"画布的骨架",L1 是"画布的语义索引",L2 是"画布的全文"。

### 6.2 判定一个信号默认 vs 工具的三条准则

1. **基数与体积**:数量随节点数线性增长且单条 > 200 字符 → 默认走 L1 摘要,
   L2 走工具(典型:Note 正文、PDF 全文)。
2. **决策必要性**:Agent 是否**每次**都需要它来选择下一步动作?是 → 默认;
   否 → 工具(典型:`recentActions` 是;BlockProvenance 不是)。
3. **新鲜度敏感**:数据变化频繁且消费方对时延敏感(如 viewport / hover)
   → 走 **轻量轮询字段** 而不是塞历史消息;否则可以让工具按需取最新。

### 6.3 功能 × 信号 矩阵

> ✅ 默认提供 / 🛠 通过工具按需 / ✗ 不暴露 / 👁 通过视觉(截图)

| 信号                                  | Ask       | Operate   | Intent (Ctrl+I) | Annotation Intent | Preprocessing | Prompt Node |
| ------------------------------------- | --------- | --------- | --------------- | ----------------- | ------------- | ----------- |
| L0 节点骨架 (`NodeSummary` 全集)      | ✅        | ✅        | ✅              | 👁 + 节点 id 角标 | ✗(单节点)     | ✅(邻居)    |
| L1 摘要 (`aiDigest`)                  | ✅        | ✅        | ✅              | ✗                 | ✗             | ✅(邻居)    |
| 选中节点元数据 (`SelectedNodeDetail`) | ✅        | ✅        | ✅              | ✗                 | ✗             | ✅(自身)    |
| 选中节点正文                          | 🛠        | 🛠        | 🛠              | ✗                 | 自身全文      | ✅(自身)    |
| 边(source/target)                     | ✅        | ✅        | ✅              | ✗                 | ✗             | 邻接边      |
| 边语义(T2-B)                          | ✅        | ✅        | ✅              | ✗                 | ✗             | ✅          |
| Frame 树(T2-A)                        | ✅        | ✅        | ✅              | ✗                 | ✗             | ✅(本枝)    |
| 空间聚类（outline / cluster）         | 🛠        | 🛠        | 🛠              | ✗                 | ✗             | ✗           |
| 视口 `viewport`(T3-A)                 | ✅        | ✅        | ✅              | 隐含于截图        | ✗             | ✗           |
| 截图                                  | 🛠 opt-in | 🛠 opt-in | ✅(标注增强)    | ✅(主输入)        | ✗             | ✗           |
| Annotation 语义(T3-C)                 | ✅        | ✅        | ✅              | ✅                | ✗             | ✗           |
| `recentActions` + 时间戳              | ✅        | ✅        | ✅              | ✗                 | ✗             | ✗           |
| 聊天历史                              | ✅        | ✅        | ✗               | ✗                 | ✗             | ✗           |
| 节点正文全文                          | 🛠        | 🛠        | ✗               | ✗                 | ✗             | 🛠          |
| 节点 provenance                       | 🛠        | 🛠        | ✗               | ✗                 | ✗             | ✗           |
| 跨 canvas 索引(T4-B)                  | 🛠        | 🛠        | ✗               | ✗                 | ✗             | ✗           |
| 用户偏好                              | ✅(精简)  | ✅(精简)  | ✗               | ✗                 | ✗             | ✗           |

### 6.4 每个功能的"上下文配方"

#### A. Ask(对话答疑)

- **默认**：L0 全部 + L1 全部 + 选中节点元数据 + 边
  - `recentActions`（带时间戳）+ 聊天历史 + viewport。
- **可选**：截图（用户开关 / 当问句含“看一下”“这片区域”等关键词时自动附带）。
- **空间信息**：不默认下发，需要时 Agent 先调 `get_canvas_outline()` 拿一份“画布地图”，再用 `inspect_nodes` / `inspect_edges` 做精查。
- **工具**：`read("nodes/<id>.md")` / `inspect_nodes` / `web_search` / `get_provenance`。
- **要点**：Ask 重在“读”和“答”，**不发任何节点正文**，把 token 留给上下文广度
  和后续工具调用。

#### B. Operate(画布改写)

- **默认**:同 Ask + **结构索引**(`frameTree` + `edgesByNode`,T2-A)+
  **边语义**(T2-B)+ **节点认知状态**(T2-C,让 AI 知道哪些是 confirmed
  不能轻易改)+ 技能目录摘要。
- **可选**:截图(同上)。
- **工具**:Ask 全部 + `canvas_commands` + `use_skill`
  - `get_provenance`(改前必查)。
- **要点**:Operate 多了 **"改写前的安全检查"** 需求,所以结构与状态字段优先于
  Ask;但仍坚持 **正文走工具**,避免一次 prompt 就把整张画布塞满。

#### C. Intent(Ctrl+I)

- **默认**：L0 + L1 + 选中节点元数据 + 截图（带最近动作高亮）
  - `recentActions`（短窗口，3–5 条）+ viewport。空间层面主要靠截图。
- **不发**:聊天历史(意图是"此刻的画布",和聊天分支无关)、节点正文。
- **工具**:基本不走工具(单 LLM 调用,流式返回 JSON)。
- **要点**:Intent 是**最贵**的"看一眼就要给五个建议"的功能,**视觉信号(截图)
  是它的核心**,文字 context 应当**精简到 L0 + L1**。

#### D. Annotation Intent(笔触意图)

- **默认**:截图(带红色笔触和被圈节点 id 角标)+ 被圈节点的 L0(id/type/label
  即可,不带 L1)+ Annotation 语义字段(T3-C 提供的圈选/箭头/划掉粗判)。
- **不发**:任何文本上下文。
- **要点**:这是**视觉优先**的功能,文字越少越好,**Annotation 语义字段**
  让模型不必完全依赖图像识别也能稳定理解"用户圈住了 A、B、C"。

#### E. Preprocessing(后台 enrich)

- **默认**:**只**节点自身的 ResolvedInput / 提取后的内容。无任何画布上下文。
- **要点**:enrich 的目标是"为这个节点生产 L1 摘要",必须保持**单节点纯函数**
  特性,以便:
  - 缓存友好(指纹一致就跳过)
  - 可批量并行
  - 不会因为"画布上下文变了"导致同一节点 enrich 结果漂移
- **可改进**:Frame label 合成可以带"兄弟 frame 的现有名字"来避免重名,但
  仍属于**结构信号**,不引入 L1/L2。

#### F. Prompt Node(画布上的提问节点)

- **默认**:节点自身正文(L2)+ 邻接节点(通过边或包围 frame)的 L0+L1
  - 邻接节点正文(L2,但限定半径,如距离 < 2 跳)。
- **不发**:全画布、聊天历史(prompt 节点天然是"局部对话")。
- **工具**:同 Ask。
- **要点**:这是 **"局部画布即上下文"** 的特殊功能,空间近邻代替全画布广度。

### 6.5 该新增的 Tool 一览

按"减少 round-trip / 把 L2 放到工具层"的原则,推荐以下工具(在现有
[tools/definitions.ts](../apps/server/src/modules/agent/tools/definitions.ts)
基础上补齐):

| 工具                                  | 输入                | 返回                                                   | 解决的问题                                        |
| ------------------------------------- | ------------------- | ------------------------------------------------------ | ------------------------------------------------- |
| `get_node_details_batch`              | `nodeIds: string[]` | `Array<{ nodeId, content, contentJson?, sourceId? }>`  | 一次取多节点正文，避免 N 次 `read`                |
| `get_node_provenance(nodeId)`         | `nodeId`            | BlockProvenance(作者/时间/AI 修改/pending diff)        | Operate 前的安全检查,避免误覆盖用户内容           |
| `get_block_tree(nodeId)`              | `nodeId`            | BlockNote 结构化树(标题/段落/列表/code 块)             | 让模型理解文档结构而不必再 parse markdown         |
| `get_annotation_strokes(nodeId)`      | `nodeId`            | 简化几何(包围盒 / 圈中节点 / 形状粗判)                 | Annotation 节点的语义解读,不必依赖整张截图        |
| `get_recent_history(canvasId, since)` | `since: ts`         | 超出 ring buffer 的更长动作历史                        | 复盘"昨天我做了什么"                              |
| `list_canvases(workspace)`            | —                   | `Array<{ canvasId, title, lastUpdated, topKeywords }>` | 让 Agent 知道工作区还有哪些 canvas                |
| `get_canvas_digest(canvasId)`         | `canvasId`          | 该 canvas 的 L0+L1 + 顶层 frame 树                     | 跨 canvas 跳转的"轻量观察"                        |
| `get_viewport_snapshot()`             | —                   | 当前视口 PNG                                           | 让 Ask/Operate 也能在被询问"这片区域"时主动取截图 |

### 6.6 永远不进默认上下文(无论功能)

无论是哪个功能,以下数据**始终**走工具而非默认上下文,因为它们要么过大、
要么使用频率低、要么会引入噪声:

- 节点正文(L2 markdown)
- BlockNote 完整 contentJson
- BlockProvenance 全量(per-block 修改记录)
- Annotation 节点的原始 `points` 几何数组
- 跨 canvas 的全画布状态
- 历史 checkpoint 的完整序列(只暴露必要切片)

### 6.7 一句话总结

> **L0/L1 让 Agent "看清结构",L2 留给工具按需取;
> 视觉信号优先服务"意图与笔触";
> Preprocessing 必须是单节点纯函数,不引入画布上下文。**

---

## 7. 推荐切入顺序

1. **T1-A**(全节点 aiDigest) — 单 PR、最高 ROI、不改 schema、立刻能感知效果。
2. **T2-C**(epistemicStatus) — 把"思考状态"显化,直接对齐
   Externalize Thinking。
3. **T2-A / T2-B**(结构索引 + 边语义) — 让结构变成一等公民。
4. **T3-A / T3-C**(viewport + annotation 语义) — 让 Agent 真正"在场"。
5. **新增 Tool**(`get_node_details_batch` / `get_provenance` / `get_canvas_digest`)
   — 把"L2 走工具"的契约真正闭环。
6. **T4**(vault 镜像、跨 canvas) — 长期愿景。

---

## 附录:关键文件索引

| 关注点                      | 文件                                                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 上下文类型定义              | [packages/shared/src/types/context.ts](../packages/shared/src/types/context.ts)                                     |
| 浏览器拼装上下文            | [apps/web/src/store/canvasStore.ts](../apps/web/src/store/canvasStore.ts) (`getAgentContext`)                       |
| Snippet 抽取 / RecentAction | [apps/web/src/handler/canvasCommand/utils/index.ts](../apps/web/src/handler/canvasCommand/utils/index.ts)           |
| 截图                        | [apps/web/src/handler/canvasCommand/utils/screenshot.ts](../apps/web/src/handler/canvasCommand/utils/screenshot.ts) |
| 空间聚类                    | [packages/shared/src/utils/spatial.ts](../packages/shared/src/utils/spatial.ts)                                     |
| Agent 请求类型              | [packages/shared/src/types/agent.ts](../packages/shared/src/types/agent.ts)                                         |
| 浏览器请求入口              | [apps/web/src/api/agent.ts](../apps/web/src/api/agent.ts)                                                           |
| 服务端路由                  | [apps/server/src/modules/agent/agent.route.ts](../apps/server/src/modules/agent/agent.route.ts)                     |
| 聊天历史持久化              | [apps/server/src/modules/agent/store/chat-store.ts](../apps/server/src/modules/agent/store/chat-store.ts)           |
| 工具定义                    | [apps/server/src/modules/agent/tools/definitions.ts](../apps/server/src/modules/agent/tools/definitions.ts)         |
| 工具执行                    | [apps/server/src/modules/agent/tools/executor.ts](../apps/server/src/modules/agent/tools/executor.ts)               |
| 系统 prompt(ask)            | [apps/server/src/prompt/system.ts](../apps/server/src/prompt/system.ts)                                             |
| 系统 prompt(operate)        | [apps/server/src/prompt/agent.ts](../apps/server/src/prompt/agent.ts)                                               |
| Intent prompt               | [apps/server/src/prompt/intent.ts](../apps/server/src/prompt/intent.ts)                                             |
| 预处理流水线                | [apps/server/src/modules/preprocessing/pipeline.ts](../apps/server/src/modules/preprocessing/pipeline.ts)           |
| Enrich 阶段                 | [apps/server/src/modules/preprocessing/stages/enrich.ts](../apps/server/src/modules/preprocessing/stages/enrich.ts) |
