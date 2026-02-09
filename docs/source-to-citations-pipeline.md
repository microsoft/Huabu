# 画布选中数据源 → 检索 → Record-level 引用（实现链路）

> 目标：实现从“画布选中数据源”到“模型回答中 record-level 引用”的完整链路。
> **Canvas 选择 → 后端摄取/存储 → 检索 → record-level 引用 → SSE → 前端解析与点击定位**。

---

## 1) 术语与标识符

- **nodeId**：画布节点 ID（UI 标识）。
- **sourceId**：后端 Source Record 的稳定 ID（引用 token 使用它）。
- **Source Record**：后端持久化的一条“数据源记录”（web/PDF/note/image/text）。
- **Revision**：可编辑数据源（Note/Text）内容的一次版本快照。
- **引用 token**：嵌入在模型回答文本中的 `[source:<sourceId>]`。

### 本方案会存储/传输哪些 ID？

为了避免“前端 nodeId、后端 sourceId、可编辑 revision 版本”在链路里混用，本方案约定以下 ID 会出现（有些会落库，有些只在请求/响应里传输）：

- `workspaceId`

  - 含义：空间/租户隔离边界。
  - 存储：建议在 `canvases.workspace_id`、`sources.workspace_id`（若你们的鉴权上下文能可靠推断 workspaceId，也可以不在每条请求里显式传，但落库仍建议带上便于隔离与查询）。

- `canvasId`

  - 含义：某个 workspace 下的一张画布文档。
  - 存储：`canvases.canvas_id`（PK），以及 `canvas_nodes.canvas_id`。
  - 传输：chat 请求携带，用于后端加载画布权威状态。

- `canvasVersion`

  - 含义：画布的乐观锁版本号（确保“本次 chat 使用的画布内容”与前端一致）。
  - 存储：`canvases.version`。
  - 传输：
    - 前端 `PUT /api/canvas/:canvasId` 时传入旧 `version`；后端成功后返回新 `version`。
    - chat 请求携带 `canvasVersion`；不一致建议后端返回 `409 Conflict`。

- `nodeId`

  - 含义：画布节点 ID（UI/ReactFlow 层面的标识）。
  - 前提：你已确认 `nodeId` **全局唯一**（跨画布不复用）。
  - 存储：`canvas_nodes.node_id`，以及（建议）`sources.node_id`（用于从引用反查定位 UI）。
  - 传输：chat 请求携带 `selectedNodeIds: string[]`。

- `sourceId`

  - 含义：后端 Source Record 的稳定 ID（引用 token 使用）。
  - 生成/映射：推荐 `sourceId = hash(workspaceId + nodeId)`。
  - 存储：`sources.source_id`（PK）。
  - 传输：
    - LLM 回答正文中以 token 形式出现：`[source:<sourceId>]`
    - SSE `citations` 事件里作为 `references[].sourceId` 返回（用于前端把 token 映射到 nodeId/标题/uri）。

- `revisionId`

  - 含义：可编辑数据源（Note/Text）内容的版本 ID，用于避免历史引用随着内容编辑而漂移。
  - 存储：`source_revisions.revision_id`（PK）。
  - 传输：SSE `citations` 事件里作为 `references[].revisionId` 返回；前端可用它提示“引用的是当时的哪个版本”。

- `artifactUri`（严格来说不是 ID，但链路里会作为引用/定位符存储）
  - 含义：大内容落盘（artifact store）的定位符（例如 `artifact://...`）。
  - 存储：`sources.content_artifact_uri`、`source_revisions.content_artifact_uri`。

### sourceId ↔ nodeId 映射

- `sourceId` 需要在重载、索引重建、数据库迁移后依然稳定。
- 推荐规则：`sourceId = hash(workspaceId + nodeId)`，并在 Source Record 中保存 `nodeId`。
- 这样可以实现：点击引用 → 解析 `sourceId` → 找到 `nodeId` → 定位/高亮画布节点。

---

## 2) 链路分解：每一环现在需要做什么

### Link A — Canvas 选择（Web 客户端）

**现状**

- 画布节点与 selection 已存在（ReactFlow + Zustand），客户端本身知道当前选中的节点。
- Chat 请求不包含“选中数据源”的信息。

**现在需要做什么**

- 扩展 chat 请求 payload，携带 selection：
  - `selectedNodeIds: string[]`
  - `canvasId: string`
  - `canvasVersion: number`

说明：在不使用 snapshot 的前提下，后端必须把“画布服务端持久化”作为权威源。`canvasVersion` 用于确保后端读取到的画布内容与前端一致；若版本不一致，建议后端返回 `409 Conflict`，提示前端先保存或拉取最新画布再重试。

#### 画布服务端持久化（推荐路线）

> 目标：让后端能可靠地通过 `nodeId` 解析到节点内容（尤其是 Note/Text 的最新内容，以及 Web/PDF 等的元信息与文件引用），从而 chat 只需要发送 `canvasId/canvasVersion + selectedNodeIds`。

**MVP 原则（v1）**

- 不做实时协作（不引入 CRDT/Yjs/WebSocket 同步）。
- 先做“单用户/单会话”的**保存/加载 + 自动保存**，并用乐观锁解决并发覆盖。
- 数据结构先用 JSON 持久化为主，再做少量索引表满足后端按 `nodeId` 查 Source 的需求。

**建议的数据模型（SQLite-first，可迁移）**

1. `canvases`（画布文档表：权威源）

- `canvas_id` (TEXT, PK)
- `workspace_id` (TEXT)
- `title` (TEXT)
- `version` (INTEGER) — 乐观锁版本号，每次保存 +1
- `state_json` (TEXT) — 画布完整状态（nodes/edges/viewport/metadata）
- `created_at` / `updated_at` (INTEGER)

2. `canvas_nodes`（节点索引表：为查询服务）

- `canvas_id` (TEXT)
- `node_id` (TEXT)
- `type` (TEXT)
- `data_json` (TEXT) — 节点的 `data` 载荷（建议直接存 Web 前端 ReactFlow Node 的 `node.data` JSON；后端用它来解析该节点的数据源信息，例如 `uri/title/text/fileArtifactUri` 等）
- `updated_at` (INTEGER)

`data_json` 的最小示例（概念性，字段名以你们前端节点 data 为准）：

```json
{
  "title": "Example",
  "sourceType": "web",
  "uri": "https://example.com",
  "text": "(optional: small text)",
  "artifactUri": "artifact://..."
}
```

说明：

- `canvases.state_json` 存的是“整张画布的权威状态”（包含 nodes/edges/viewport 等完整结构）。
- `canvas_nodes.data_json` 只需要覆盖“后端摄取/检索所需的节点数据”。如果节点内容很大，优先走 artifact store，把 `artifactUri` 写在 `data_json` 里即可。

主键建议：`(canvas_id, node_id)`。

#### `canvas_nodes` 和 `sources` 的区别

- `canvas_nodes`（Link A）

  - 是“画布持久化/编辑态”的一部分：用于让后端按 `canvasId + nodeId` 快速拿到节点的 `data_json`（接近前端原始数据）。
  - 权威性：权威源是 `canvases.state_json`；`canvas_nodes` 是为了查询方便做的索引/派生表。
  - 典型场景：恢复画布、定位节点、摄取前读取节点的 `uri/text/artifactUri` 等原始输入。

- `sources`（Link B）
  - 是“知识库/检索态”的一部分：把节点对应的数据源抽象成稳定的 Source Record（`sourceId`）并存放规范化内容与 hash。
  - 权威性：对“用于 RAG/引用的内容快照”而言，`sources/source_revisions` 是权威记录（尤其 Note/Text 要 revision 化）。
  - 典型场景：context builder 读取 `sources`（及最新 `source_revisions`）构建 LLM 上下文；SSE `citations` 返回 `sourceId → nodeId` 映射。

一句话：`canvas_nodes` 解决“后端能读到画布节点原始输入”，`sources` 解决“后端有可检索、可引用、可追溯的知识库记录”。

**API 形状（最小集）**

- `GET /api/canvas/:canvasId`

  - 返回：`{ canvasId, version, state }`

- `PUT /api/canvas/:canvasId`

  - 入参：`{ version, state }`
  - 行为：如果 `version` 与服务器当前版本不一致，返回 `409 Conflict`（提示前端拉取最新再合并/覆盖）。
  - 成功：版本号递增并返回新 `version`。

- （可选）`PATCH /api/canvas/:canvasId/nodes`
  - 入参：`{ version, upserts: Node[], deletes: string[] }`
  - 目的：减少每次全量上传 JSON 的开销；但不强制 v1 就做。

**写入流程（推荐）**

1. 前端在以下场景触发保存：

- 节点/边变更（节流：例如 500–1500ms）
- Note/Text 编辑完成（可更频繁，但同样要节流）

2. 后端收到保存请求后：

- 校验 `version`（乐观锁）
- 写入 `canvases.state_json`
- 解析 nodes 列表，刷新 `canvas_nodes`（upsert）

3. （可选）触发摄取/索引（与本方案的 Link B 对齐）：

> 一致性原则：画布持久化（`canvases/canvas_nodes`）是权威写入，要求强一致；知识库与向量索引（`sources/source_revisions/chunks` + SurrealDB）是派生数据，允许最终一致。
>
> 换句话说：**画布保存成功 ≠ 必须同步完成摄取/embedding**。摄取可以异步跑，或在 chat 前对 `selectedNodeIds` 按需补齐。

- v1 不单独维护额外的 source 索引表，而是直接基于 `canvas_nodes.data_json` 做增量判断：
  - 对每个“数据源节点”（`type` 或 `data_json` 中可识别为 `web|pdf|note|image|text`）计算 `content_hash`
  - 与 knowledge DB 的 `sources.content_hash` 对比：变化则 upsert `sources`，并对 Note/Text 新增 `source_revisions`
  - 异步重建 chunks/embeddings

**验收标准（画布服务端持久化 MVP）**

- 画布刷新后可从后端恢复 nodes/edges。
- `nodeId → node data` 在后端可解析（无需 snapshot）。
- 并发编辑不会静默覆盖（版本不一致返回 409）。

**验收标准**

- 每次 chat 调用都能看到 `canvasId`、`canvasVersion`、`selectedNodeIds`（允许为空数组）。
- 对于选中的 Note/Text，后端能通过画布持久化数据解析到最新内容（版本一致时）。

---

### Link B — 后端摄取与存储（Server）

**现状**

- 后端已有：SSE chat 流式输出、LangGraph checkpoint SQLite、artifact store（大内容落盘）模式。
- 后端缺少：可查询的“画布数据源知识库”与摄取管道。

**现在需要做什么**

1. 新增一份 **knowledge SQLite 数据库**（单独文件，不要和 LangGraph checkpoint 混在一起）。

2. 先落地最小表结构：

- `sources`

  - `workspace_id` (TEXT)
  - `source_id` (TEXT, PK)
  - `node_id` (TEXT, UNIQUE)
  - `type` (TEXT) — `web|pdf|note|image|text`
  - `title` (TEXT)
  - `uri` (TEXT)
  - `created_at` / `updated_at` (INTEGER)
  - `content_artifact_uri` (TEXT, nullable)
  - `content_text` (TEXT, nullable)
  - `content_hash` (TEXT)
  - `meta_json` (TEXT)

- `source_revisions`（强烈推荐；Note/Text 必需）
  - `revision_id` (TEXT, PK)
  - `workspace_id` (TEXT)
  - `source_id` (TEXT, FK)
  - `created_at` (INTEGER)
  - `content_artifact_uri` (TEXT, nullable)
  - `content_text` (TEXT, nullable)
  - `content_hash` (TEXT)
  - `meta_json` (TEXT)

说明：既然你已确认 `nodeId` 全局唯一，`sources.node_id` 设为 `UNIQUE` 是合理的；但依然建议把 `workspace_id` 落在 knowledge DB 里，用于鉴权/隔离与按 workspace 查询（不要仅靠 `nodeId` 的全局唯一性来做安全边界）。

3. 按类型摄取（v1 优先顺序）：

- **Text / Note（可编辑）**

  - 确保 `sources` 里有该节点的记录。
  - 每次保存/更新都新增一条 `source_revisions`（不覆盖历史）。
  - 小文本可直接存 `content_text`；大文本落 artifact（`artifact://...`）。

- **Web**

  - v1 可先支持两条路：
    - 后端从画布节点数据里拿到 `uri` 后 fetch → 正文抽取（readability/cheerio 风格）
    - 或者（若节点本身已有正文内容字段）直接使用节点内容
  - 持久化 normalized text 与元信息（`uri`/`title`/`content_hash`）。

- **PDF / Image / Video**
  - v1：先把 Source Record 存起来（文件 URI/元信息），文本抽取/OCR 可以延后。
  - v2：补抽取/OCR，并写入 locator（页码、bbox 等）。

#### 摄取触发时机（避免“每次改 node 必须同步写很多表”）

为了避免前端编辑节点时产生写放大，本方案推荐把数据写入分成两层：

- **强一致层（必须同步成功）**：`canvases` + `canvas_nodes`（画布权威状态与节点索引）。
- **派生层（允许最终一致）**：`sources/source_revisions/chunks` + SurrealDB 向量（可重建索引）。

落地时你有两种常见策略，可以混用：

1. **异步摄取（推荐默认）**

- 在画布 `PUT /api/canvas/:canvasId` 成功后，把“可能变化的 data source 节点”放进后台任务队列。
- 后台按 `content_hash` 增量更新 `sources/source_revisions`，并重建 chunks/embeddings。

2. **Chat 前按需补齐（保证新鲜度）**

- 当用户发起 chat（携带 `canvasId/canvasVersion + selectedNodeIds`）时：
  - 后端先读取该版本的 `canvas_nodes.data_json`，对 `selectedNodeIds` 计算 `content_hash`
  - 若发现 knowledge DB 中 `sources.content_hash` 不一致，则先同步 upsert（仅限 selected 范围），再进入检索/生成
- 这样能保证“刚编辑完就提问”的体验，同时不会让每一次编辑都同步写知识库与向量索引。

**验收标准**

- 一次 chat 调用后，选中的 source 节点在 `sources` 表里都能查到。
- Note/Text 被编辑后会新增 revision（无覆盖）。

---

### Link C — 检索（构建 LLM 上下文）

**现状**

- 没有针对“画布选中数据源”的检索。
- 现有 `web_search` tool 是独立路径：能显示 tool message，但没有融入 record-level 引用。

**现在需要做什么（v1）**

- 实现一个 **context builder**：
  - 根据 `selectedNodeIds` 加载 `sources`
  - 对 Note/Text 取最新 `source_revisions`
  - 生成一个“有界”的上下文块：
    - 每条记录必须显式写出 `sourceId`（让模型可引用）
    - 每条内容需要截断（避免 prompt 失控）

示例（概念性格式）：

```text
## SELECTED SOURCES

- sourceId: src_123
  type: note
  title: ...
  uri: ...
  content: ... (truncated)
```

**验收标准**

- 选择几个 source 再提问，模型能收到包含这些 source 的上下文。
- prompt 长度可控。

**可选 v2（后续）**

- 增加 `chunks` + `embeddings` 表，做按 `sourceId` 过滤的 top-k 向量检索。
- v2 依然可以先维持 record-level token，不必立即做到 chunk/page token。

#### v2：`chunks` / `embeddings` 最小表结构（SQLite-first）

> 目标：当单条 Source 太长或 Source 数量太多时，不再把整条 record（截断后）直接塞进上下文；而是先按 chunk 召回 top-k 片段，再拼成“有界上下文”。
>
> 关键约束：**不改变引用 token 合同**。即：即便检索粒度变成 chunk，模型仍然只输出 `[source:<sourceId>]`；前端点击定位仍以 `sourceId → nodeId` 为主。

1. `chunks`

- `chunk_id` (TEXT, PK)
- `workspace_id` (TEXT)
- `source_id` (TEXT, FK → `sources.source_id`)
- `revision_id` (TEXT, nullable) — Note/Text 建议填（指向当时版本）；Web/PDF 等可为空或填一个“摄取版本号”
- `chunk_index` (INTEGER) — 在同一 `(source_id, revision_id)` 下的序号
- `text` (TEXT) — chunk 正文
- `content_hash` (TEXT) — chunk 级 hash（用于增量重建）
- `locator_json` (TEXT) — 可选：定位信息（例如 `{ "page": 3 }`、`{ "start": 1200, "end": 1800 }`、`{ "url": "...#section" }`）
- `created_at` (INTEGER)

建议的 `chunk_id` 规则（稳定、可增量）：

- `chunk_id = hash(workspaceId + sourceId + (revisionId||"") + chunkIndex + chunkContentHash)`

#### v2：SurrealDB 作为向量库

**SurrealDB 中建议存的最小字段**（概念性字段名）：

- `chunkId`（唯一键，建议直接用 `chunks.chunk_id`）
- `workspaceId`
- `sourceId`
- `revisionId`（Note/Text 必填；其它类型可为空或填一个摄取批次号）
- `model` / `dims`
- `vector`（embedding 向量）
- `contentHash`（用于判断是否需要重算）
- 可选：`chunkIndex` / `createdAt`

**写入/更新（幂等）建议**

- 用 `chunkId` 做幂等键：同一个 `chunkId` 的向量可重复 upsert。
- 当 `contentHash` 或 `model` 变化时重算 embedding：
  - 如果只维护“当前模型”：直接覆盖该 `chunkId` 的向量与元信息。
  - 如果希望支持多模型共存：把 `model` 纳入唯一性（例如 `(chunkId, model)`），查询时固定一个 `model`。

**检索（强烈建议先过滤再向量）**

- filters：
  - `workspaceId == ?`
  - `sourceId IN selectedSourceIds`
  - 对 Note/Text：限制 `revisionId == latestRevisionId`（或限制在本次上下文确定的 revision 集合）
- top-k：在过滤后的候选集合里做向量相似度 top-k

这样能显著减少跨源误召回，也让引用链路更稳定：最终模型仍只输出 `[source:<sourceId>]`。

索引建议（按查询路径最小集）：

- `chunks(workspace_id, source_id)`
- `chunks(workspace_id, source_id, revision_id)`
- （若你们在 SQLite 侧保留了 embedding 元信息表）`embeddings(workspace_id, model)`

检索方式（概念）：

- Context builder 先确定候选集合（例如限定在 `selectedNodeIds → sourceIds` 之内），再做 top-k：
  - 方式 A：按 `sourceId` 过滤后对其 chunks 做向量相似度 top-k
  - 方式 B：如果未来要支持“未选中也能检索”，再放开过滤范围

把 chunk 结果拼进上下文时，仍然要显式标注 `sourceId`（以便模型引用）：

```text
## RETRIEVED CHUNKS

- sourceId: src_123
  excerpt: ...
```

后端在 `citations` 元数据里仍然返回 record-level 的 `sourceId/nodeId/...` 即可；如果你们未来想做到更高精度（页码/段落级），可以在 `references[]` 里额外加一个可选字段（比如 `locators`），但 v2 不强制。

---

### Link D — record-level 引用（回答格式）

**现状**

- 尚无机器可解析的引用 token 合同。

**现在需要做什么**

- 统一引用 token 语法：

  - `[source:<sourceId>]`

- 更新系统提示词规则：

  - 非平凡事实必须引用
  - 禁止编造 ID
  - 只能引用 references/context 中提供过的 `sourceId`

- 对可编辑数据源记录“使用了哪个版本”：
  - 即使 token 只到 record-level，后端也要记录构建上下文时用到的 `revisionId`

**验收标准**

- 回答中能看到 `[source:...]`。
- token 引用的 `sourceId` 都能在 references map 中找到。

---

### Link E — SSE 流式协议（Server → Client）

**现状**

- SSE 流式输出文本已存在。

**现在需要做什么**

- 继续沿用现有的文本流式输出。
- 在 stream 结束后追加一次性元数据事件：

```text
event: citations
data: {
  "references": [
    {"sourceId":"src_123","nodeId":"n-1","type":"note","title":"...","uri":"...","revisionId":"rev_9"}
  ],
  "contextIndicators": {"sources": ["src_123"]}
}
```

说明：一次性在末尾发送是更常见的最佳实践，避免在 streaming 过程中引用编号/映射抖动。

**验收标准**

- 客户端在 assistant 结束后收到 `citations` 事件。
- `references` 包含所有选中的 source，并且 Note/Text 带上 `revisionId`。

---

### Link F — 前端解析与点击定位（UI）

**现状**

- UI 能渲染 tool 输出，但不能解析 record-level 引用 token。

**现在需要做什么**

- 在 assistant 文本里解析 `[source:<sourceId>]`。
- 渲染时把 token 转换为编号引用（例如 `[1]`），并追加一个 “References” 列表。
- 点击引用时：
  - 使用 `citations.references` 做 `sourceId → nodeId` 解析
  - 聚焦/高亮画布节点
  - 可选：打开 DataSource panel（复用现有 panel 行为）

**验收标准**

- 点击引用可以稳定定位到正确的画布节点。
- Note/Text 在后续被编辑后，历史引用仍可定位；必要时 UI 可展示“当时使用的 revisionId”。

---

## 3) 里程碑（建议顺序）

顺序对应 Links A–F：

- Milestone 1：新增请求字段 + 客户端发送 selection（Link A）
- Milestone 2：knowledge DB + `sources/source_revisions` + 基础 upsert（Link B）
- Milestone 3：v1 context builder（Link C）
- Milestone 4：提示词规则 + `[source:<sourceId>]`（Link D）
- Milestone 5：`citations` SSE 事件 + UI 解析/点击定位（Links E–F）
- Milestone 6（可选）：chunks/embeddings/vector retrieval（v2）

---

## 4) 风险与应对

- **后端无法通过 nodeId 拿到内容**：必须先落地“画布服务端持久化（推荐路线）”，并让 chat 请求携带 `canvasId/canvasVersion` 以保证读取版本一致。
- **Token budget**：限制每条 source 的注入长度；v2 引入向量检索。
- **引用幻觉（编造 sourceId）**：提示词强约束；可选在后端校验并剥离无效 token。
- **可编辑内容漂移**：Note/Text 做 revision 化，并在引用元数据里携带 `revisionId`。

---

## 5) 相关文档

- Agent 架构总览：[agent.md](agent.md)
- 当前存储说明：[data-storage.md](data-storage.md)
- 环境与启动：[setup.md](setup.md)
