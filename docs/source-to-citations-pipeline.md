# 画布选中数据源 → 摄取/存储 → 上下文注入（v1 已实现）与 Record-level 引用（规划）

> 本文档以“当前代码实现”为准（截至 2026-02-10）。
>
> 已实现：Canvas 选择 → 节点级摄取与存储 → Chat 注入 SELECTED SOURCES 上下文 → SSE(update/end/error) → 前端渲染。
>
> 未实现（规划中）：record-level 引用 token、`citations` SSE 事件、前端解析 token 与点击定位。

---

## 1) 术语与标识符（当前实现）

- nodeId：画布节点 ID（ReactFlow Node 的 `id`）。
- sourceId：knowledge DB 的 `sources.source_id`，用于标识一条数据源记录。
- Revision：仅用于可编辑数据源（note/text），存于 `source_revisions`。
- revisionId：knowledge DB 的 `source_revisions.revision_id`，表示某次内容快照。

### ID 在哪里出现？

- canvasId / canvasVersion / selectedNodeIds
  - 传输：Chat 请求体（`SendMessageRequest`）。
  - 用途：后端从 `canvas_nodes` 反查选中节点对应的 `sourceIds`，并做版本一致性校验。

- sourceId
  - 存储：`knowledge.sqlite` 的 `sources.source_id`。
  - 传输：当前实现中不会作为引用 token 出现在模型回答里；只用于后端构建上下文。

### sourceId 生成规则（与 nodeId 解耦）

实现位于 `apps/server/src/modules/knowledge/utils.ts`：

- Note/Text：`src_${uuid}`（可编辑内容用 UUID）
- Web：`src_${sha256(workspaceId + normalizedUrl)}`（截断为 16 hex）
- PDF：`src_${sha256(workspaceId + fileHash)}`（当前 `fileHash` 使用“抽取文本的 contentHash”，不是原始文件 bytes hash）

---

## 2) 已实现链路（v1）

### Link A — Canvas 保存/加载 + Selection（Web 客户端）

#### Chat 请求携带 selection

前端发送 chat 时携带：

- `canvasId`
- `canvasVersion`
- `selectedNodeIds`（从当前画布中 `node.selected` 收集）

#### Canvas 服务端持久化（权威 state + 乐观锁）

后端接口：

- `GET /canvas/:canvasId` → `{ canvasId, version, state }`
- `PUT /canvas/:canvasId`（body: `{ version, state, workspaceId?, title? }`）
  - `version` 不一致返回 `409`（响应里包含 `serverVersion`）
  - 成功则 `version = version + 1`

说明：当前实现中，`PUT /canvas/:canvasId` 只负责保存 `state_json`；节点与数据源的映射不在这里维护。

### Link B — 节点级摄取与存储（Server）

#### 节点摄取 API（维护 nodeId → sourceId 映射）

后端接口：

- `PUT /canvas/:canvasId/nodes/:nodeId`
  - body: `{ workspaceId?, type: 'note'|'text'|'web'|'pdf', title?, content?, src? }`
  - 行为：对该节点执行摄取（ingest），并 upsert `canvas_nodes(canvas_id,node_id,source_id)`
  - 返回：`{ nodeId, sourceId, success, suggestedLabel?, error? }`

- `DELETE /canvas/:canvasId/nodes/:nodeId`
  - 行为：删除 `canvas_nodes` 映射（不删除 knowledge 里的 source）

前端触发时机（核心逻辑见 `apps/web/src/utils/ingestHelper.ts`）：

- 新增节点：`addNode()` 后触发一次 `upsertNode()`
- 节点更新：当 note/text 的 `data.content` 或 web/pdf 的 `data.src` 变化时触发 `upsertNode()`
- 删除节点：触发 `DELETE /canvas/:canvasId/nodes/:nodeId`

#### canvas_nodes 表（当前 schema）

当前 schema 仅维护映射：

- `canvas_nodes(canvas_id, node_id, source_id)`，主键 `(canvas_id,node_id)`

说明：当前实现不在 `canvas_nodes` 中保存 `type`/`data_json`；节点内容直接在摄取时写入 knowledge DB。

#### Knowledge DB（knowledge.sqlite）

位置：`apps/server/data/knowledge.sqlite`

表结构（v1）：

- `sources`
  - `type`: `web|pdf|note|text`
  - `content_text`：内容全文（NOT NULL）

- `source_revisions`（仅 note/text 需要）
  - 每次内容 hash 变化会新增一条 revision

#### Web / PDF 摄取实现细节

- Web：
  - 优先使用前端传来的 `content`（若提供）
  - 否则后端使用 Tavily Extract API 抓取
  - 依赖环境变量：`TAVILY_API_KEY`
  - 可选配置：`SEDIMENT_TAVILY_EXTRACT_DEPTH`、`SEDIMENT_TAVILY_EXTRACT_FORMAT`

- PDF：
  - 前端在节点 `data.src` 里传 `artifactUri`
  - 后端从 artifact store 读取文件并用 `pdf-parse` 抽取文本
  - 解析失败时会写入 placeholder source（`sources.meta_json.placeholder=true`，并带 `ingestError`）

### Link C — 检索（v1：Selected Sources 直接注入）

当前实现没有向量检索/chunking；Chat 仅把“选中的 source records（截断后）”注入 system prompt。

Context builder 行为（`apps/server/src/modules/knowledge/context-builder.ts`）：

- 输入：`sourceIds: string[]`
- note/text：取最新 `source_revisions` 作为内容，并附带 `revisionId`
- web/pdf：取 `sources` 的当前 content
- 每条记录最多注入 10k 字符（超出会追加 `[Content truncated]`）

注入格式（实际输出，概念示例）：

```text
## SELECTED SOURCES

- sourceId: src_xxx
  type: note
  title: ...
  revisionId: rev_xxx
  content: |
    ...
```

---

## 3) Chat SSE 协议（当前实现）

后端 `/chat` 使用 SSE 手动流式输出：

- `event: update`：增量 UI 更新（assistant token 流、tool 输出、meta(threadId) 等）
- `event: end`：流结束
- `event: error`：错误

说明：当前实现没有 `event: citations`。

---

## 4) 未实现（规划中，非当前行为）

以下内容在当前代码里尚未落地：

### Link C2 — Chunking / 向量检索（TODO）

- 目标：将 `sources` 内容分块（chunk）并建立向量索引，用检索结果替代/补充“整条 source 直接注入”。
- 预期变化：Chat 从 “selected sources → 直接注入” 变为 “selected sources → chunking/index → retrieval → 注入 top-k chunks”。
- 需要澄清的设计点：
  - 分块策略（按 token/段落/标题层级）、chunk metadata（sourceId、revisionId、offset 等）
  - 索引的生命周期（随 revision 增量更新 vs 全量重建）
  - 过滤条件（仅在 selectedNodeIds 对应 sourceId 范围内检索）
  - 结果格式（是否需要把 chunkId 暴露给引用系统）

### Link D — record-level 引用 token

- 规划 token：`[source:<sourceId>]`
- 需要更新系统提示词，约束模型只引用上下文里出现过的 `sourceId`

### Link E — `citations` SSE 事件

- 规划在 stream 结束后追加 `event: citations`，返回 `references[]`（sourceId/nodeId/type/title/uri/revisionId 等）

### Link F — 前端解析 token 与点击定位

- 规划：解析 `[source:<sourceId>]` → 渲染为编号引用 + References 列表
- 规划：点击引用通过 `sourceId → canvas_nodes → nodeId` 定位/高亮

---

## 5) TODO（规划）

- Chunking / 向量检索：对 `sources`（及 note/text 的 revisions）做分块与索引，Chat 注入改为 top-k chunks。
- `event: citations`：在 SSE 流结束后输出结构化 `references[]`。
- 引用 token：在模型输出中生成稳定 token（例如 `[source:<sourceId>]` 或更细粒度的 chunk token）。
- 前端引用渲染：把 token 转换为编号引用 + 可点击的 References 列表，并实现定位/高亮节点。
