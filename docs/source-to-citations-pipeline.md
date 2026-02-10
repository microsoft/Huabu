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
  - 含义：画布节点 ID（UI/ReactFlow 层面的标识），存储位置、大小等样式。
  - 前提：`nodeId` 在同一画布内唯一即可；不同画布可以有不同的 node 渲染同一个 sourceId。
  - 存储：`canvas_nodes.node_id`（主键）+ `canvas_nodes.source_id`（外键，用于关联到数据源）。
  - 传输：chat 请求携带 `selectedNodeIds: string[]`。

- `sourceId`
  - 含义：后端 Source Record 的稳定 ID（引用 token 使用）。基于数据源内容本身生成（如 `hash(workspaceId + uri)` 或 `hash(workspaceId + contentIdentifier)`），与 nodeId 无关。同一个数据源可以在多个画布上被不同的 node 渲染。
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

### sourceId ↔ nodeId 映射（一对多关系）

- `sourceId` 需要在重载、索引重建、数据库迁移后依然稳定。
- 生成规则（基于数据源内容，与 nodeId 无关）：
  - Web: `sourceId = hash(workspaceId + uri)`
  - Note/Text: `sourceId = hash(workspaceId + initialUniqueId)` 或使用 UUID
  - PDF: `sourceId = hash(workspaceId + fileHash)` 或 `hash(workspaceId + artifactUri)`
- **一个 source 可以对应多个 nodes**（同一数据源在多个画布/位置渲染）：通过 `canvas_nodes.source_id` 外键直接关联。
- 点击引用定位流程：
  - 点击 `[source:src_123]` → 从 `canvas_nodes` 查询：`WHERE source_id = 'src_123' AND canvas_id = 当前画布`
  - → 定位/高亮画布节点（如有多个，可高亮所有或让用户选择）
  - 若当前画布无此 source，可查询其他画布并提示用户跳转

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
- `source_id` (TEXT, nullable, FK → `sources.source_id`) — 节点对应的数据源 ID
- `type` (TEXT)
- `data_json` (TEXT) — 节点的 `data` 载荷（建议直接存 Web 前端 ReactFlow Node 的 `node.data` JSON；后端用它来解析该节点的数据源信息，例如 `uri/title/text/fileArtifactUri` 等）
- `updated_at` (INTEGER)
- INDEX: `(source_id)` — 用于从 sourceId 反查所有关联的 nodes

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

- `canvas_nodes`（轻量级索引表）
  - **职责**：维护 node ↔ source 的映射关系（仅 ID 映射，不存数据）。
  - **权威性**：派生自 `canvases.state_json`；每次保存画布时同步更新。
  - **典型场景**：
    - Chat 前：根据 `selectedNodeIds` 快速找到 `sourceIds`
    - 引用定位：根据 `sourceId` 在当前画布找到 `nodeId` 并高亮
    - 反向查找：查询某个数据源在哪些画布上被引用

- `sources`（知识库/数据源表）
  - **职责**：存储数据源的实际内容（uri、title、content、hash 等）。
  - **权威性**：对"用于 RAG/引用的内容快照"而言是权威记录（尤其 Note/Text 要 revision 化）。
  - **典型场景**：
    - 摄取管道：从外部抓取/解析内容并持久化
    - Context builder：读取 `sources`（及最新 `source_revisions`）构建 LLM 上下文
    - SSE citations：返回 source 元信息（title/uri/type）给前端

**关键分离点**：

- **Node 关心样式**：位置、大小、颜色等 UI 呈现（存在 `canvases.state_json` + node 内的 `sourceId` 引用）
- **Source 关心内容**：uri、正文、元数据等知识内容（存在 `sources` 表）
- **`canvas_nodes` 是桥梁**：仅维护 ID 映射，不存储任何实际数据，用于快速查询

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

**写入流程（v1 实际实现）**

1. 前端在以下场景触发保存：

- 节点/边变更（节流：例如 500–1500ms）
- Note/Text 编辑完成（可更频繁，但同样要节流）

2. 后端收到保存请求后：

- 校验 `version`（乐观锁）
- 解析 `state.nodes` 提取节点数据（type, data.content, data.src, data.label）
- **同步调用 ingestService 摄取数据源**（Text/Note/Web 类型）
  - Text/Note: 调用 `ingestTextSource()`，创建/更新 `sources` + 新增 `source_revisions`
  - Web: 调用 `ingestWebSource()`，创建/更新 `sources`
  - 返回 `sourceId`
- 写入 `canvases.state_json`
- 写入 `canvas_nodes` 表（存储 `node_id` → `source_id` 映射）
- 摄取失败不影响画布保存（仅记录日志）

> **实现说明**：
>
> - v1 实现采用画布保存时同步摄取（简单直接，无需任务队列）
> - Text/Note 每次保存都会调用 ingestService（内部通过 hash 判断是否需要新 revision）
> - Web 节点通过 hash 去重，相同 URL 不会重复摄取
> - 异步重建 chunks/embeddings（可选，v2）

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

说明：`sources` 表不存储 `node_id`（避免一对多时的冗余）；通过 `canvas_nodes.source_id` 外键实现一对多关系。这样同一个数据源可以在多个画布上被不同节点引用。`workspace_id` 依然落在 knowledge DB 里，用于鉴权/隔离与按 workspace 查询。

#### 确认的细节

**1. 知识库数据库命名**
`knowledge.sqlite`

---

**2. sourceId 生成策略**

根据数据源类型选择不同的生成规则：

- **Note/Text（可编辑类型）**
  - ⭐ **推荐**：使用 UUID
    - 实现：`sourceId = "src_" + uuid()`
    - 优点：简单、无碰撞风险、无需依赖内容哈希
    - 缺点：不可从内容反推（但可编辑类型本身内容会变，哈希也不稳定）

- **Web（基于 URI）**
  - ⭐ **推荐**：`hash(workspaceId + normalizedUri)`
    - 实现：`sourceId = "src_" + hash(workspaceId + normalizeUrl(uri))`
    - 优点：同一 URL 在同一 workspace 内稳定映射到同一 sourceId
    - 注意：需要 URL 规范化（去参数、统一协议等）

- **PDF/Image/File（基于文件内容）**
  - ⭐ **推荐**：`hash(workspaceId + fileContentHash)`
    - 实现：`sourceId = "src_" + hash(workspaceId + sha256(fileContent))`
    - 优点：同一文件内容稳定映射，支持去重

**3. 摄取触发时机**

> 权衡：实现复杂度 vs 用户体验 vs 系统一致性

- **策略 A：全部异步摄取（实现复杂）**
  - 流程：
    1. 画布保存成功后，后台任务队列异步处理摄取（所有类型）
    2. 按 `content_hash` 增量更新 `sources/source_revisions`
    3. 异步重建 chunks/embeddings
  - 优点：
    - 画布保存快速响应
    - 用户编辑体验流畅
  - 缺点：
    - 需要引入任务队列（内存队列/Redis/数据库队列）
    - 需要处理摄取失败/重试逻辑
    - Chat 时可能遇到"摄取尚未完成"的情况
  - 适用场景：生产环境、高频编辑场景

- **策略 B：全部 Chat 前按需补齐（实现最简单）**
  - 流程：
    1. 用户发起 chat 时，后端读取 `selectedNodeIds` 对应的 `canvas_nodes.data_json`
    2. 对每个 selected node 计算 `content_hash`
    3. 检查 `sources` 表中是否存在且 hash 一致
    4. 不存在或 hash 不一致 → 同步摄取（仅限 selected 范围）
    5. 摄取完成后进入检索/生成
  - 优点：
    - 实现简单，无需任务队列
    - 保证 chat 时数据一定是最新的
    - "刚编辑完就提问"体验良好
  - 缺点：
    - 首次提问或内容变更后提问会有延迟（通常 < 1s）
    - 如果选中大量新节点，摄取时间可能较长（尤其 Web 抓取）
  - 适用场景：MVP/v1、中小规模数据源

- ⭐ **策略 D：画布保存时同步摄取（v1 实际实现）**
  - **所有类型（Text/Note/Web）**：画布保存时同步摄取
    - 理由：实现简单，数据一致性强，无需任务队列
    - 流程：
      1. 前端保存画布（节流后）
      2. 后端解析 `state.nodes` 提取数据
      3. 同步调用 `ingestTextSource()` / `ingestWebSource()`
      4. 获得 `sourceId` 后写入 `canvas_nodes` 表
    - Chat 时：直接从 `canvas_nodes` 读取 `sourceIds`（无需摄取）
  - 优点：
    - 实现最简单，无需异步队列
    - 数据强一致性（保存成功 = 摄取成功）
    - Chat 响应快（只需查表，不做摄取）
  - 缺点：
    - 画布保存可能稍慢（需等待摄取完成，但实际 < 100ms）
    - Web 抓取失败会静默跳过（记录日志但不阻塞保存）
  - 适用场景：v1 MVP，优先简单可靠

- **策略 C：混合策略（按类型区分）** - 未采用，保留为 v2 优化方向
  - Text/Note：保存时同步摄取
  - Web/PDF：异步摄取 + Chat 前兜底
  - 需要实现任务队列，复杂度较高

**决策**：☑ 策略 D（保存时同步摄取，v1 实现）□ 策略 C（混合策略，v2 备选）□ 策略 A（全异步）□ 策略 B（全按需）

---

**4. Content 存储策略（大小阈值）**

决定何时使用 `content_text` vs `content_artifact_uri`：

- ⭐ **推荐阈值**：1MB (1048576 bytes)
  - `< 1MB`: 直接存 `content_text` 字段（SQLite TEXT 性能良好）
  - `>= 1MB`: 存到 artifact store，记录 `content_artifact_uri`
  - 理由：SQLite 单行大小限制远超 1MB，但过大会影响查询性能

---

**5. v1 支持的 Source 类型范围**

根据实现优先级选择 v1 范围：

- ✅ **Text/Note（可编辑，必须支持）**
  - 理由：核心场景，需要 revision 机制
  - 实现要点：
    - `sources` 表存基本信息
    - 每次内容变更新增 `source_revisions`
    - 从 `canvas_nodes.data_json` 提取 `text/content` 字段

- ✅ **Web（推荐支持）**
  - 两种实现路径（如果路径1没有内容，则用路径2backup）：
    - 路径 1：直接使用节点已有内容（前端已抓取/缓存）
      - 从 `canvas_nodes.data_json.content` 获取
      - 适用于前端已做内容抓取的场景
    - 路径 2：后端按需抓取
      - 从 `canvas_nodes.data_json.uri` 读取 URL
      - 使用 `node-fetch` + `@mozilla/readability` 或 `cheerio` 抽取正文
      - 需要处理抓取失败/超时

- ✅ **PDF（v1 支持）**
  - **推荐方案：pdf-parse (Node.js 原生)**
    - 库：`pdf-parse` (npm)
    - 实现：
      - 从 `canvas_nodes.data_json.artifactUri` 读取 PDF 文件
      - 使用 pdf-parse 提取文本（自动处理多页）
      - 存储到 `sources.content_text` 或 `content_artifact_uri`（根据大小）
    - 优点：
      - 纯 JavaScript，无需跨语言调用
      - 轻量简单，开箱即用
      - 适合 80% 的常见 PDF 场景
    - 缺点：复杂格式（扫描件、复杂表格）可能解析不完整

- ⚠️ **Image/Video（延后到 v2）**
  - v1 暂不支持
  - v2 实现计划：
    - Image: OCR（Tesseract）或视觉模型（GPT-4V/Claude Vision）
    - Video: 转录（Whisper）+ 关键帧提取
  - 理由：实现复杂度高，v1 优先核心文本类型

---

**6. 实现步骤拆分与顺序**

⭐ **推荐顺序**（基于依赖关系，适配混合策略）：

1. **Step 1: 数据库与表结构**
   - 创建 `knowledge.sqlite`
   - 实现 `sources` 和 `source_revisions` 表 schema
   - 编写数据库初始化/迁移代码

2. **Step 2: sourceId 生成工具**
   - 实现 `generateSourceId()` 函数（针对不同类型）
   - 实现 `computeContentHash()` 函数
   - 单元测试

3. **Step 3: Text/Note 摄取（画布保存时同步摄取）**
   - 实现 `ingestTextSource()` 函数
   - 支持 `source_revisions` 新增逻辑
   - 处理 content_text vs artifact 存储
   - 触发位置：`canvas.route.ts` 的 `PUT /canvas/:canvasId`
   - 调用时机：解析 `state.nodes` 后，对每个 note/text 节点调用
   - 返回 `sourceId` 用于写入 `canvas_nodes` 表

4. **Step 4: Web 摄取（画布保存时同步摄取）**
   - 实现 `ingestWebSource()` 函数
   - 实现：优先使用节点已有内容（`data.content`），无内容时后端抓取（`data.src`）
   - 触发位置：`canvas.route.ts` 的 `PUT /canvas/:canvasId`
   - 错误处理：抓取失败记录日志但不阻塞画布保存

4.5. **Step 4.5: PDF 摄取（异步 + 兜底）**

- 实现 `ingestPdfSource()` 函数
- **PDF 解析库选择**
  - ⭐ **pdf-parse (Node.js 原生，推荐 v1)**
    - 安装：`npm install pdf-parse`
    - 优点：纯 JS，无需额外服务，简单易用
    - 缺点：复杂 PDF 可能解析不完整
    - 示例：
      ```typescript
      import pdf from 'pdf-parse';
      const dataBuffer = fs.readFileSync(pdfPath);
      const data = await pdf(dataBuffer);
      const text = data.text; // 提取的文本
      ```
- 从 artifactUri 读取 PDF 文件 → 解析库提取文本 → 存储
- 错误处理（文件不存在、Canvas 路由集成（保存时触发摄取）\*\*
  - 修改 `canvas.route.ts` 的 `PUT /canvas/:canvasId`
  - 解析 `state.nodes` 提取节点数据（id, type, data.content, data.src, data.label）
  - 对支持的节点类型调用 ingestService：
    - Text/Note: `ingestTextSource()`
    - Web: `ingestWebSource()`
  - 收集 `sourceId` 并写入 `canvas_nodes` 表
  - 使用事务确保原子性

6. **Step 6: Chat 路由集成（读取 sourceIds）**
   - 修改 `chat.route.ts`，读取 `canvasId/canvasVersion/selectedNodeIds`
   - 实现版本校验（version mismatch → 409 Conflict）
   - 从 `canvas_nodes` 表查询 `sourceIds`：
     ```sql
     SELECT source_id FROM canvas_nodes
     WHERE canvas_id = ? AND node_id IN (?)
     ```
   - 调用 `buildContext(sourceIds)` 构建 LLM 上下文
   - 将 context 追加到 system promptsion，hash 不一致时兜底同步摄取
     - Web/PDF：检查是否存在，不存在时兜底同步摄取
   - 构建初步上下文（Link C 的前置工作）

7. **Step 7: 测试与验收**
   - 单元测试：sourceId 生成、hash 计算、摄取函数
   - 集成测试：
     - Text/Note 编辑 → 立即 chat（验证按需摄取）
     - Web 节点添加 → 等待片刻 → chat（验证异步摄取）
     - Web 节点添加 → 立即 chat（验证兜底机制）
     - PDF 节点上传 → chat（验证 PDF 文本抽取）
   - 验收标准（见文档 Link B 验收标准）

**决策**：☑ 同意推荐顺序（混合策略）

---

**实施检查清单**

在开始编码前，请确认以下所有决策已完成：
画布保存时同步摄取\*\*

- Text/Note/Web: 画布保存时同步调用 ingestService
- Chat 时: 只读取 sourceIds，不做摄取型）：
- Text/Note: UUID
- Web: hash(workspaceId + uri)
- PDF/File: hash(workspaceId + fileHash)
- [x] 摄取触发时机已选择：**混合策略**
  - Text/Note: Chat 前按需补齐
  - Web/PDF: 异步摄取 + Chat 前兜底
- [x] Content 存储阈值已确定：**1MB**
- [x] v1 支持的 Source 类型范围已明确：
  - Text/Note（必选）
  - Web（优先已有内容，回退到后端抓取）
  - PDF（使用 Node.js 原生库）
  - Image/Video（延后到 v2）
- [x] Web 类型的实现路径已选择：两者都支持（优先已有内容）
- [x] PDF 解析库已确定：**pdf-parse**（推荐），备选 unpdf/pdfjs-dist
- [x] 实现步骤顺序已确认（适配混合策略 + PDF）

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
