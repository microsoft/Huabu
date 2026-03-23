# 重构：节点预处理流水线

## 概述

本次重构将原来分离的**知识入库流程**（note/text/web/pdf）和 **LLM 标签生成流程**（image/frame）合并为一条所有 canvas 节点类型共享的 **6 阶段预处理流水线**。

### 重构前

```
前端                                    服务端
─────────────────────────────────────────────────────────────
ingest.ts ──→ upsertNode() ──→ PUT /nodes/:id ──→ IngestService
                                                   ├─ ingestCanvasNode()
                                                   └─ ingestPdfCanvasNodeFromArtifact()

resolveLabel.ts ──→ resolveLabel() ──→ POST /resolve-label ──→ 内联 llmComplete()
```

- 前端有两套独立的触发系统，各自做 debounce
- 服务端有两个独立路由，逻辑完全分离
- LLM 调用直接内联在路由处理函数中
- `IngestService` 将输入解析、内容提取、标准化、持久化混在一起
- Agent 工具 `ingest_content` 仅支持 note/text/web，不支持 PDF

### 重构后

```
前端                                    服务端
─────────────────────────────────────────────────────────────
preprocess.ts ──→ preprocessNode()
              ──→ POST /:canvasId/nodes/:nodeId/preprocess ──→ PreprocessDispatcher
                                                                │
                                                                ▼
                                                           6 阶段流水线
                                                           ┌─ Input Resolve（输入解析）
                                                           ├─ Extract（内容提取）
                                                           ├─ Normalize（标准化）
                                                           ├─ Enrich（LLM 增强，所有 LLM 调用集中于此）
                                                           ├─ Persist（持久化）
                                                           └─ Project（结果投影）
```

- 前端统一为一个触发函数 `triggerPreprocessing` → `preprocessNodeIfNeeded`
- 所有节点类型共用一个统一的 HTTP 端点 `POST /:canvasId/nodes/:nodeId/preprocess`
- 服务端由 `PreprocessDispatcher` 根据节点 profile 决定执行哪些阶段
- 所有 LLM 调用集中在 Enrich 阶段，由 `ProviderManager` 统一管理
- Agent 工具现支持所有节点类型（包括 PDF）

---

## 高层设计

### 流水线阶段

| #   | 阶段              | 职责                                              | 是否涉及外部调用         |
| --- | ----------------- | ------------------------------------------------- | ------------------------ |
| 1   | **Input Resolve** | 将原始节点数据转换为标准化输入                    | 否                       |
| 2   | **Extract**       | 使用文档加载器解析/抓取内容                       | Tavily (web)、本地 (pdf) |
| 3   | **Normalize**     | 计算内容哈希、生成 sourceId、提取标题、合并元数据 | 否                       |
| 4   | **Enrich**        | 所有 LLM 工作 —— 标签、摘要、关键词               | Azure OpenAI             |
| 5   | **Persist**       | 写入知识库（受策略控制）                          | 否（本地 I/O）           |
| 6   | **Project**       | 组装权威性的 patch 对象和诊断信息                 | 否                       |

### 核心架构决策

1. **基于能力的调度** — 每种节点类型声明一个能力档案（profile）。调度器根据脏字段构建执行计划，而非用 node-type 的 switch/case 分支。

2. **LLM 调用集中化** — 所有 LLM 调用通过 Enrich 阶段中的 `ProviderManager` 发起。这为后续的批处理、缓存和成本控制预留了统一入口。

3. **同一条流水线，不同的执行计划** — note 和 image 节点走同一条流水线；调度器只是跳过不适用的阶段。

4. **持久化作为可选阶段** — image、frame、video 节点跳过 Persist 阶段，将预处理与知识库写入解耦。

### 核心类型（`packages/shared/src/types/preprocessing.ts`）

- `CanvasNodeKind` — `CanvasNodeType` 的别名
- `SourceKind` — `SourceType` 的别名
- `Capability` — 按阶段对齐的联合类型：`resolve_input | extract_text | fetch_remote_content | compute_fingerprint | resolve_title | merge_metadata | generate_label | generate_summary | generate_keywords | persist_source | build_patch`
- `TriggerReason` — `node_inserted | node_updated | flush | manual | repair`
- `NodePreprocessProfile` — 声明每种节点类型的能力集和监视字段
- `PreprocessNodeRequest` / `PreprocessNodeResult` — 流水线输入/输出契约
- `PreprocessDiagnostic` — 结构化的错误/警告条目

---

## 底层实现

### 新增文件

#### 共享类型

| 文件                                         | 内容                                            |
| -------------------------------------------- | ----------------------------------------------- |
| `packages/shared/src/types/preprocessing.ts` | 所有共享预处理类型定义                          |
| `packages/shared/src/index.ts`               | 新增 `export * from './types/preprocessing.js'` |

#### 服务端预处理模块

| 文件                                                            | 内容                                                                                                                        |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/modules/preprocessing/types.ts`                | 内部阶段上下文类型：`ResolvedInput`、`ExtractResult`、`NormalizeResult`、`EnrichResult`、`PersistResult`、`PipelineContext` |
| `apps/server/src/modules/preprocessing/profiles.ts`             | 7 种节点类型的能力档案注册表                                                                                                |
| `apps/server/src/modules/preprocessing/stages/input-resolve.ts` | 阶段 1 — 将原始 snapshot 转为 `ResolvedInput`；处理 URL 规范化、artifact URI 解析、子标签收集                               |
| `apps/server/src/modules/preprocessing/stages/extract.ts`       | 阶段 2 — 通过 `DocumentLoaderFactory` 委托给 `TextLoader`、`WebLoader`、`PdfLoader`                                         |
| `apps/server/src/modules/preprocessing/stages/normalize.ts`     | 阶段 3 — 计算内容哈希、生成 sourceId、提取标题、合并元数据                                                                  |
| `apps/server/src/modules/preprocessing/stages/enrich.ts`        | 阶段 4 — 根据能力调用 `ProviderManager.generateImageLabel()` 或 `generateFrameLabel()`                                      |
| `apps/server/src/modules/preprocessing/stages/persist.ts`       | 阶段 5 — 调用 `IKnowledgeRepository.createSource`/`updateSource`，含哈希去重                                                |
| `apps/server/src/modules/preprocessing/stages/project.ts`       | 阶段 6 — 构建 `PreprocessNodeResult`，含 patch、diagnostics、fingerprints                                                   |
| `apps/server/src/modules/preprocessing/pipeline.ts`             | 按序运行阶段 1–6；跳过不在执行计划中的阶段                                                                                  |
| `apps/server/src/modules/preprocessing/dispatcher.ts`           | `PreprocessDispatcher` 类：查找 profile、计算脏字段、构建执行计划、运行流水线                                               |
| `apps/server/src/modules/preprocessing/provider-manager.ts`     | `ProviderManager` 类：封装 `llmComplete`，提供图像描述和框架摘要两种 LLM 能力                                               |
| `apps/server/src/modules/preprocessing/index.ts`                | 公开导出 + `getPreprocessDispatcher()` / `resetPreprocessDispatcher()` 单例管理                                             |

#### 前端统一触发器

| 文件                                  | 内容                                                                                                                              |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/utils/io/preprocess.ts` | 统一的 `preprocessNodeIfNeeded()`、`shouldPreprocessOnUpdate()`、`needsPreprocessing()`；通过 `preprocessNode()` API 调用统一端点 |

### 修改的文件

#### 服务端

| 文件                                              | 变更                                                                                                                                                                                                                 |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/modules/canvas/canvas.route.ts`  | 新增 `POST /:canvasId/nodes/:nodeId/preprocess` 统一端点（`nodeType`/`trigger` 使用 `z.enum` 校验）。移除了旧的 **PUT /nodes/:nodeId** 和 **POST /resolve-label** 路由。新增 `PreprocessNodeResponse` 类型导入。     |
| `apps/server/src/modules/agent/tools/executor.ts` | `executeIngestContent()` — 用 `PreprocessDispatcher` 替换了 `IngestService`。现在支持所有节点类型（包括之前不支持的 PDF）。移除了 `getIngestService` 导入，新增了 `getPreprocessDispatcher`、`CanvasNodeKind` 导入。 |
| `apps/server/src/modules/workspace.route.ts`      | 用 `resetPreprocessDispatcher()` 替换了 `resetIngestService()`。导入来源从 `knowledge/index.js` 改为 `preprocessing/index.js`。                                                                                      |
| `apps/server/src/modules/knowledge/index.ts`      | 移除了导出：`IngestService`、`getIngestService`、`resetIngestService`、`IngestTextSourceInput`、`IngestWebSourceInput`、`IngestPdfSourceInput`、`IngestSourceResult`。                                               |

#### 前端

| 文件                                            | 变更                                                                                                                                                   |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/web/src/store/canvasStore.ts`             | `triggerIngestion` + `triggerLabelResolve` 合并为 `triggerPreprocessing`（统一 1s debounce）。`flushOnUnload` 改为调用 `preprocessNode()` API。        |
| `apps/web/src/canvas/commands/createNodes.ts`   | `ingestNodes` + `labelResolveNodeIds` 合并为 `preprocessNodes`。使用 `needsPreprocessing()` 过滤需要预处理的新节点，同时将父 frame Node 对象加入列表。 |
| `apps/web/src/canvas/commands/mergeNodeData.ts` | 同上合并。当子节点 label 变化时，将父 frame Node 对象加入 `preprocessNodes`。                                                                          |
| `apps/web/src/canvas/commands/setNodeParent.ts` | `labelResolveNodeIds` 改为 `preprocessNodes`（输出 frame Node 对象而非 ID）。                                                                          |
| `apps/web/src/canvas/commands/types.ts`         | `CommandHandlerResult` 中 `ingestNodes` + `labelResolveNodeIds` 合并为 `preprocessNodes: Node[]`。                                                     |
| `apps/web/src/canvas/executor.ts`               | 累积器从两个数组改为 `preprocessNodes` 单一数组。                                                                                                      |
| `apps/web/src/canvas/postEffects.ts`            | `PendingEffects` 从两个数组改为 `preprocessNodes`。遍历改为单循环调用 `triggerPreprocessing`。                                                         |
| `apps/web/src/canvas/runtime.ts`                | `CanvasEffectCallbacks` 从 `triggerIngestion` + `triggerLabelResolve` 改为单个 `triggerPreprocessing: (node: Node) => void`。                          |
| `apps/web/src/store/canvasHistoryManager.ts`    | `TriggerIngestionFn` 改名为 `TriggerPreprocessingFn`。                                                                                                 |
| `apps/web/src/api/canvas.ts`                    | 新增 `preprocessNode()` API 函数，调用统一端点 `POST /:canvasId/nodes/:nodeId/preprocess`。                                                            |
| `apps/web/src/utils/io/index.ts`                | 移除 `needsIngestion`、`needsLabelResolve` 的 re-export。                                                                                              |

### 删除/弃用的文件

| 文件                                                  | 状态                                                                                         |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `apps/web/src/utils/io/ingest.ts`                     | **已删除** — 被 `preprocess.ts` 替代。无任何剩余导入。                                       |
| `apps/web/src/utils/io/resolveLabel.ts`               | **已删除** — 被 `preprocess.ts` 替代。无任何剩余导入。                                       |
| `apps/server/src/modules/knowledge/ingest.service.ts` | **已删除** — 被 `preprocessing/` 模块替代。无任何剩余导入。                                  |
| `apps/web/src/store/canvasHandlers.ts`                | **已被 main 分支删除**（canvas command 重构 PR #96）。原有的预处理相关逻辑已迁入命令系统中。 |

### 未修改的文件（及原因）

| 文件                                                       | 原因                                                                                               |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `apps/web/src/api/canvas.ts`                               | 移除了 `upsertNode()` 和 `resolveLabel()` API 函数。新增 `preprocessNode()` 作为唯一的预处理 API。 |
| `apps/server/src/modules/knowledge/loaders/*`              | `TextLoader`、`PdfLoader`、`WebLoader`、`YoutubeLoader` 被 Extract 阶段复用，无需修改。            |
| `apps/server/src/modules/knowledge/knowledge.interface.ts` | `IKnowledgeRepository` 接口被 Persist 阶段复用。                                                   |
| `apps/server/src/modules/knowledge/obsidian.repository.ts` | 仓库实现原样复用。                                                                                 |
| `apps/server/src/modules/knowledge/utils.ts`               | `normalizeUrl`、`computeContentHash`、`generateSourceId` 被 Input Resolve 和 Normalize 阶段复用。  |
| `apps/server/src/modules/agent/llm.ts`                     | `llmComplete` 被 `ProviderManager` 包装，而非替换。                                                |
| `apps/server/src/prompt/resolve-label.ts`                  | `IMAGE_LABEL_PROMPT` 和 `buildFrameLabelPrompt` 被 `ProviderManager` 使用。                        |

---

## 节点处理矩阵

重构后各节点类型在流水线中的处理方式：

| 节点类型 |    Input Resolve    |      Extract       |         Normalize          |     Enrich      |       Persist       |     Project      |
| -------- | :-----------------: | :----------------: | :------------------------: | :-------------: | :-----------------: | :--------------: |
| note     |      内容透传       |     TextLoader     |    哈希 + UUID sourceId    |        —        | ✅ 创建/更新 source | sourceId + title |
| text     |      内容透传       |     TextLoader     |    哈希 + UUID sourceId    |        —        | ✅ 创建/更新 source | sourceId + title |
| web      |     URL 规范化      | WebLoader (Tavily) | 哈希 + URL 确定性 sourceId |        —        | ✅ 创建/更新 source | sourceId + title |
| pdf      | artifact URI → 路径 | PdfLoader (pdf2md) | 哈希 + 内容确定性 sourceId |        —        | ✅ 创建/更新 source | sourceId + title |
| image    |    解析图片 src     |         —          |          计算指纹          | ✅ LLM 视觉标签 |          —          |  suggestedLabel  |
| frame    |     收集子标签      |         —          |          计算指纹          | ✅ LLM 分组名称 |          —          |  suggestedLabel  |
| video    |      解析 src       |         —          |          计算指纹          |        —        |          —          |   （暂无操作）   |

---

## 行为变化

### Agent 工具 `ingest_content`

- **重构前**：仅支持 `note`、`text`、`web`。PDF 会返回错误。
- **重构后**：通过 `PreprocessDispatcher` 支持所有节点类型。

### 标签生成

- **重构前**：在 `canvas.route.ts` 中内联调用 `llmComplete`，image 和 frame 各有一段重复的 prompt 构造逻辑。
- **重构后**：委托给 `ProviderManager.generateImageLabel()` / `generateFrameLabel()`，由 Enrich 阶段统一调用。

### 错误处理

- **重构前**：`IngestService` 返回 `NodeIngestOutcome`，包含临时定义的错误码。标签生成静默吞噬错误。
- **重构后**：所有路径均返回 `PreprocessNodeResult`，包含结构化的 `diagnostics[]` 数组。

### 工作空间切换

- **重构前**：`resetIngestService()` 清除缓存的 `IngestService` 单例。
- **重构后**：`resetPreprocessDispatcher()` 清除缓存的 `PreprocessDispatcher` 单例。

### 代码审查修复（Node ID 与结果补全）

1. **引入 `nodeId` 回退机制**：为 `ResolvedInput` 添加了 `nodeId`。当 PDF 提取为空内容，或 Web 节点缺少可用 URI 时，Normalize 会结合 `nodeId` 或 `artifactUri` 生成稳定的备用 `sourceId`，避免不同节点因为空内容而发生 `sourceId` 冲突与互相覆盖。
2. **将缺失必需输入视为结构化提取失败**：当 `web` 缺失 `normalizedUri`，或 `pdf` 缺失 `filePath` 时，Extract 阶段不再返回 `skipped: true`，而是抛出结构化错误并进入 `EXTRACT_FAILED` 诊断路径，从而允许 Persist 阶段为该节点写入 placeholder 记录。
3. **补全 `persistence.sourceKind`**：Project 阶段现在会透传 dispatcher 已知的 `sourceKind`，并写入 `PreprocessNodeResult.persistence.sourceKind`，避免对外结果中长期返回 `undefined`。

---

## 当前状态总结

截至触发器统一重构完成后的最终状态。

### 服务端

**完全实现了 6 阶段流水线。** 统一的 HTTP 端点通过 `PreprocessDispatcher` 执行：

| 路由                                       | trigger        | `allowLLM` | `allowPersistence` | 典型节点类型 |
| ------------------------------------------ | -------------- | ---------- | ------------------ | ------------ |
| `POST /:canvasId/nodes/:nodeId/preprocess` | `node_updated` | `true`     | `true`             | 所有节点类型 |

旧的 `PUT /:canvasId/nodes/:nodeId` 和 `POST /resolve-label` 路由已移除。

### 前端

```
apps/web/src/canvas/
├── commands/               # 每个命令一个文件
│   ├── createNodes.ts      # 使用 needsPreprocessing() 过滤 + 收集父 frame
│   ├── mergeNodeData.ts    # 使用 shouldPreprocessOnUpdate() + 收集父 frame
│   ├── setNodeParent.ts    # 收集受影响的 frame 到 preprocessNodes
│   └── ...
├── executor.ts             # 批量命令执行器，累积 preprocessNodes
├── postEffects.ts          # 提交后副作用，调用 triggerPreprocessing
├── runtime.ts              # CanvasEffectCallbacks: { triggerPreprocessing }
└── uiIntent.ts             # 用户意图解析 → CanvasCommand 转换
```

统一的预处理触发路径：

```
命令处理器检测脏字段或新节点
  → 将 Node 对象加入 preprocessNodes
  → postEffects.ts 遍历 preprocessNodes
  → triggerPreprocessing(node)           （1s debounce，per-node）
  → preprocessNodeIfNeeded()
  → preprocessNode() API
  → POST /:canvasId/nodes/:nodeId/preprocess
  → PreprocessDispatcher → 6 阶段流水线
```

**重复调用问题已修复**：之前 image/frame 在 createNodes 中同时进入 `ingestNodes` 和 `labelResolveNodeIds` 两个数组，导致两次 HTTP 请求。现在只有一个 `preprocessNodes` 数组，`createNodes` 通过 `needsPreprocessing()` 过滤，每个节点只触发一次预处理。

**Frame 子节点变化处理**：当 `mergeNodeData` 检测到子节点的 `label` 字段变化时，会将父 frame 的 Node 对象加入 `preprocessNodes`。`setNodeParent` 同理。`preprocessNodeIfNeeded` 中会为 frame 节点收集子标签并构造 `childLabels` snapshot 发送给服务端。

### 已删除的旧代码

- `apps/web/src/utils/io/ingest.ts` — 已删除
- `apps/web/src/utils/io/resolveLabel.ts` — 已删除
- `apps/server/src/modules/knowledge/ingest.service.ts` — 已删除
- `apps/web/src/store/canvasHandlers.ts` — 被 main 的 canvas command 重构删除

---

## 需要注意的问题

### 1. note/text 节点频繁编辑与 LLM 调用风险

**现状**：note/text 节点的 `content` 字段每次编辑都会触发 `shouldPreprocessOnUpdate()` → 1 秒 debounce 后发送预处理请求。当前统一端点默认 `allowLLM: true`，但由于 note/text 的 profile 中没有 `generate_label`、`generate_summary` 等 Enrich 能力，所以 Enrich 阶段实际上不会执行。

**潜在风险**：一旦为 note/text 的 profile 添加 `generate_summary` 或 `generate_keywords`，每次键入暂停 1 秒后都会触发 LLM 调用，这在用户活跃编辑时非常昂贵。

**建议的缓解措施**：

1. **Debounce 不够，需要指纹去重**：即使 debounce 合并了快速连续的编辑，用户持续编辑（每隔 2-3 秒暂停思考）仍会产生大量 LLM 调用。应在 Enrich 阶段用 `inputFingerprint` 做缓存去重——如果内容指纹未变，跳过 LLM 调用。
2. **分层 debounce**：对 Enrich 阶段的 LLM 调用使用更长的 debounce（如 10-30 秒），与提取/持久化的 1 秒 debounce 分离。可在服务端通过"延迟 Enrich 队列"实现。
3. **显著变化阈值**：只在内容变化超过一定比例（如 diff 超过 20%）时才触发 LLM 增强。
4. **手动触发优先**：对于成本较高的 summary/keywords 生成，默认不自动触发，提供手动"分析"按钮。

### 2. 统一 debounce 的权衡

之前 frame 使用 2 秒 debounce（等待子节点稳定），现在统一为 1 秒。如果用户快速拖拽多个节点进出 frame，可能导致 frame 标签生成发出多次无效请求（子节点还在移动中）。短期可接受，因为服务端的指纹去重和 LLM 幂等性可以减轻影响。长期可考虑对 frame 节点实现更智能的"稳定检测"（如检测最近 N 秒内没有新的子节点变化才触发）。

---

## 后续工作清单

按优先级排列：

### P0 — 功能完整性

- [ ] 实现 `generate_summary` 和 `generate_keywords` 的 Enrich 能力（当前 profile 中声明但未实现）
- [ ] 为 video 节点集成 `YoutubeLoader`（当前 video 走到 Extract 阶段时无操作）

### P1 — 增量 Enrich 与成本控制

- [ ] 实现 `inputFingerprint` 为 key 的 Enrich 结果缓存（避免同内容重复 LLM 调用）
- [ ] 对 Enrich 阶段实现分层 debounce 或延迟队列（与 Extract/Persist 的 1s debounce 分离）
- [ ] 引入 request ID / revision token 防止过期结果覆盖
- [ ] `ProviderManager` 中添加 per-canvas 或 per-session 的 token 预算

### P2 — 清理与优化

- [ ] 清理 shared 包中不再被前端直接使用的旧类型（`UpsertNodeRequest`、`UpsertNodeResponse`、`ResolveLabelRequest`、`ResolveLabelResponse`）
- [ ] 批量节点导入时的 Enrich 批处理支持
- [ ] Tavily Extract 调用纳入 `ProviderManager` 统一管理
- [ ] 按节点类型或能力组实现差异化 debounce（如 frame 使用更长的稳定窗口）
