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
preprocess.ts ──→ upsertNode()    ──→ PUT /nodes/:id    ──→ PreprocessDispatcher
              ──→ resolveLabel()  ──→ POST /resolve-label ──→ PreprocessDispatcher
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

- 前端统一为一个触发函数 `preprocessNodeIfNeeded`
- 服务端两个路由均委托同一个 `PreprocessDispatcher`
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

| 文件                                  | 内容                                                                                                                               |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/utils/io/preprocess.ts` | 统一的 `preprocessNodeIfNeeded()`、`shouldPreprocessOnUpdate()`、`needsPreprocessing()`、`needsIngestion()`、`needsLabelResolve()` |

### 修改的文件

#### 服务端

| 文件                                              | 变更                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/modules/canvas/canvas.route.ts`  | **PUT /:canvasId/nodes/:nodeId** — 用 `PreprocessDispatcher.preprocess()` 替换了 `IngestService` 调用。**POST /resolve-label** — 用 `PreprocessDispatcher.preprocess()` 替换了内联 `llmComplete` 调用。移除了 `llmComplete`、`IMAGE_LABEL_PROMPT`、`buildFrameLabelPrompt`、`resolveArtifactImageUrl`、`getIngestService` 的导入。新增了 `getPreprocessDispatcher` 和预处理类型的导入。 |
| `apps/server/src/modules/agent/tools/executor.ts` | `executeIngestContent()` — 用 `PreprocessDispatcher` 替换了 `IngestService`。现在支持所有节点类型（包括之前不支持的 PDF）。移除了 `getIngestService` 导入，新增了 `getPreprocessDispatcher`、`CanvasNodeKind` 导入。                                                                                                                                                                    |
| `apps/server/src/modules/workspace.route.ts`      | 用 `resetPreprocessDispatcher()` 替换了 `resetIngestService()`。导入来源从 `knowledge/index.js` 改为 `preprocessing/index.js`。                                                                                                                                                                                                                                                         |
| `apps/server/src/modules/knowledge/index.ts`      | 移除了导出：`IngestService`、`getIngestService`、`resetIngestService`、`IngestTextSourceInput`、`IngestWebSourceInput`、`IngestPdfSourceInput`、`IngestSourceResult`。                                                                                                                                                                                                                  |

#### 前端

| 文件                                            | 变更                                                                                                                                               |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/store/canvasStore.ts`             | 将 `io/ingest` + `io/resolveLabel` 的导入替换为 `io/preprocess`。`triggerIngestion` 和 `triggerLabelResolve` 现在都调用 `preprocessNodeIfNeeded`。 |
| `apps/web/src/canvas/commands/mergeNodeData.ts` | 用 `shouldPreprocessOnUpdate`（from `io/preprocess`）替换了 `shouldIngestOnUpdate`（from `io/ingest`）。                                           |
| `apps/web/src/canvas/commands/createNodes.ts`   | `needsLabelResolve` 的导入来源从 `io/resolveLabel` 改为 `io/preprocess`。                                                                          |
| `apps/web/src/utils/io/index.ts`                | 更新 re-exports：用 `preprocess` 模块导出替换了 `ingest` 模块导出。                                                                                |

> **注意**：main 分支上发生了一次并行的 canvas command 重构（PR #96），删除了原本的
> `apps/web/src/store/canvasHandlers.ts`，将其中的处理逻辑拆分到 `apps/web/src/canvas/commands/` 目录下的
> 独立命令文件中。预处理分支 rebase 后，`shouldPreprocessOnUpdate` 和 `needsLabelResolve`
> 的调用位置已适配到新的命令系统中。

### 删除/弃用的文件

| 文件                                                  | 状态                                                                                         |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `apps/web/src/utils/io/ingest.ts`                     | **已删除** — 被 `preprocess.ts` 替代。无任何剩余导入。                                       |
| `apps/web/src/utils/io/resolveLabel.ts`               | **已删除** — 被 `preprocess.ts` 替代。无任何剩余导入。                                       |
| `apps/server/src/modules/knowledge/ingest.service.ts` | **已删除** — 被 `preprocessing/` 模块替代。无任何剩余导入。                                  |
| `apps/web/src/store/canvasHandlers.ts`                | **已被 main 分支删除**（canvas command 重构 PR #96）。原有的预处理相关逻辑已迁入命令系统中。 |

### 未修改的文件（及原因）

| 文件                                                       | 原因                                                                                              |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `apps/web/src/api/canvas.ts`                               | `upsertNode()` 和 `resolveLabel()` API 函数被新前端触发器原样复用，HTTP 契约未变。                |
| `apps/server/src/modules/knowledge/loaders/*`              | `TextLoader`、`PdfLoader`、`WebLoader`、`YoutubeLoader` 被 Extract 阶段复用，无需修改。           |
| `apps/server/src/modules/knowledge/knowledge.interface.ts` | `IKnowledgeRepository` 接口被 Persist 阶段复用。                                                  |
| `apps/server/src/modules/knowledge/obsidian.repository.ts` | 仓库实现原样复用。                                                                                |
| `apps/server/src/modules/knowledge/utils.ts`               | `normalizeUrl`、`computeContentHash`、`generateSourceId` 被 Input Resolve 和 Normalize 阶段复用。 |
| `apps/server/src/modules/agent/llm.ts`                     | `llmComplete` 被 `ProviderManager` 包装，而非替换。                                               |
| `apps/server/src/prompt/resolve-label.ts`                  | `IMAGE_LABEL_PROMPT` 和 `buildFrameLabelPrompt` 被 `ProviderManager` 使用。                       |
| `apps/web/src/canvas/postEffects.ts`                       | main 分支新增。通过 `CanvasEffectCallbacks` 调用 `triggerIngestion` / `triggerLabelResolve`。     |
| `apps/web/src/canvas/runtime.ts`                           | main 分支新增。定义 `CanvasEffectCallbacks` 接口，声明 ingestion 和 label resolve 两个回调。      |

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

截至 rebase 到 main（含 canvas command 重构 PR #96）后的最终状态。

### 服务端

**完全实现了 6 阶段流水线。** 两个现有 HTTP 路由均通过 `PreprocessDispatcher` 执行：

| 路由                           | trigger        | `allowLLM` | `allowPersistence` | 典型节点类型      |
| ------------------------------ | -------------- | ---------- | ------------------ | ----------------- |
| `PUT /:canvasId/nodes/:nodeId` | `node_updated` | `false`    | `true`（默认）     | note/text/web/pdf |
| `POST /resolve-label`          | `manual`       | `true`     | `false`            | image/frame       |

两个路由**仍然存在且各自独立**。它们共享同一个 `PreprocessDispatcher` 实例，但请求构造和响应映射各有不同。

### 前端

前端经过 main 的 canvas command 重构后，架构已变为：

```
apps/web/src/canvas/
├── commands/               # 每个命令一个文件
│   ├── createNodes.ts      # 使用 needsLabelResolve()
│   ├── mergeNodeData.ts    # 使用 shouldPreprocessOnUpdate()
│   └── ...
├── executor.ts             # 批量命令执行器
├── postEffects.ts          # 提交后副作用，调用 triggerIngestion / triggerLabelResolve
├── runtime.ts              # CanvasEffectCallbacks 接口定义
└── uiIntent.ts             # 用户意图解析 → CanvasCommand 转换
```

预处理相关的触发路径：

1. **Ingestion 路径**：`mergeNodeData` 命令检测脏字段 → 将节点加入 `PendingEffects.ingestNodes` → `postEffects.ts` 调用 `triggerIngestion(node)` → `canvasStore.ts` 中的 `triggerIngestion` debounce → `preprocessNodeIfNeeded()` → `PUT /nodes/:id`
2. **Label resolution 路径**：`createNodes` 命令检测需要标签解析的节点 → 将 nodeId 加入 `PendingEffects.labelResolveNodeIds` → `postEffects.ts` 调用 `triggerLabelResolve(nodeId)` → `canvasStore.ts` 中的 `triggerLabelResolve` debounce → `preprocessNodeIfNeeded()` → `POST /resolve-label`

两条路径最终都会调用 `preprocessNodeIfNeeded()`，但前端仍然保持着"两个回调 → 两个 debounce 定时器 → 两个 HTTP 路由"的分离结构。

### 已删除的旧代码

- `apps/web/src/utils/io/ingest.ts` — 已删除
- `apps/web/src/utils/io/resolveLabel.ts` — 已删除
- `apps/server/src/modules/knowledge/ingest.service.ts` — 已删除
- `apps/web/src/store/canvasHandlers.ts` — 被 main 的 canvas command 重构删除

---

## 架构讨论：当前遗留问题与后续方向

### 1. `resolve-label` 路由是否应该继续存在？

**现状**：`POST /resolve-label` 仍然是一个独立的 HTTP 路由。它与 `PUT /nodes/:id` 在服务端共享同一个 `PreprocessDispatcher`，但在前端它们通过不同的 API 函数（`resolveLabel()` vs `upsertNode()`）发起请求，且携带不同的请求格式。

**分析**：

- 两个路由在服务端的实际执行路径已经统一（均构造 `PreprocessNodeRequest` → 调用 `dispatcher.preprocess()`）
- 区别仅在于：
  - `PUT /nodes/:id`：`allowLLM: false`，侧重提取和持久化
  - `POST /resolve-label`：`allowLLM: true, allowPersistence: false`，侧重 LLM 增强
- 这个区别完全可以用 `PreprocessNodeRequest.options` 中的标志来表达，不需要两个独立路由

**建议**：在后续阶段引入统一的 `POST /api/canvas/:canvasId/nodes/:nodeId/preprocess` 路由，通过 `options.allowLLM` 和 `options.allowPersistence` 控制行为。旧路由保留为兼容别名，逐步迁移后删除。

### 2. 前端触发器统一：`triggerIngestion` vs `triggerLabelResolve`

**现状**：`CanvasEffectCallbacks` 接口定义了两个独立回调：

```ts
interface CanvasEffectCallbacks {
  triggerIngestion: (node: Node) => void;
  triggerLabelResolve: (nodeId: string) => void;
}
```

它们使用不同的 debounce 间隔（1000ms vs 2000ms）、不同的参数签名（`Node` vs `nodeId`），并分别调用 `preprocessNodeIfNeeded()` 构造不同的请求。

**分析**：

- 两者的最终目的都是"触发预处理"，只是场景不同
- 不同的 debounce 间隔有合理性：note 编辑需要较短的 debounce，frame 标签需要等子节点稳定
- 但如果统一为单个 `triggerPreprocessing(node)` 回调，debounce 策略可以内化到 `preprocessNodeIfNeeded()` 中按节点类型或能力组区分

**建议**：

1. 短期：保持现状，因为 canvas command 系统刚稳定，改动回调接口牵涉面广
2. 中期：将 `CanvasEffectCallbacks` 合并为单个 `triggerPreprocessing: (node: Node) => void`，在 `preprocessNodeIfNeeded()` 内部根据节点类型选择 debounce 策略
3. 同时需要调整 `PendingEffects` 结构，将 `ingestNodes` 和 `labelResolveNodeIds` 合并为 `preprocessNodes: Node[]`
4. 各命令处理器（`createNodes`、`mergeNodeData` 等）统一输出到同一个副作用列表

### 3. 节点更新时的 Enrich 操作

**现状**：

- `PUT /nodes/:id` 路由设置 `allowLLM: false`，这意味着当用户编辑 note/text/web/pdf 内容时不会触发 Enrich 阶段
- 只有 `POST /resolve-label` 路由（显式标签解析请求）设置 `allowLLM: true`
- 因此，当前 note/text/web/pdf 的更新永远不会运行 `generate_summary` 或 `generate_keywords`

**问题**：

- 即使 profile 中声明了 `generate_summary`（如 web/pdf），更新路径中也不会执行它
- image/frame 的标签只在显式 `resolveLabel` 请求时才生成，不会在 `PUT /nodes/:id` 路径中触发
- 节点内容大幅变更后，之前生成的摘要或关键词可能已过时，但没有机制重新触发

**建议**：

1. **交互式模式快速返回**：保持 `PUT /nodes/:id` 的 `allowLLM: false` 策略不变，确保编辑操作的低延迟
2. **引入后台 Enrich 通道**：当 Normalize 阶段检测到内容指纹变化时，排入一个"后台增强队列"，以 `mode: 'background'` 异步运行 Enrich 阶段
3. **前端轮询或 SSE**：后台增强完成后通过 SSE/WebSocket 或轮询推送 patch 给前端
4. **手动触发**：在节点上下文菜单中提供"重新分析"选项，以 `trigger: 'manual', allowLLM: true` 强制运行完整流水线

### 4. Canvas Command 系统与预处理的职责边界

**现状**：canvas command 系统在业务层面已经分离了"状态变更"和"副作用触发"。命令处理器只负责计算新的 nodes/edges 状态和记录哪些节点需要预处理（通过 `ingestNodes` / `labelResolveNodeIds`）。实际的预处理由 `postEffects.ts` 在提交后异步触发。

**值得注意的设计点**：

- 命令处理器中的 `shouldPreprocessOnUpdate()` 判断逻辑本质上重复了服务端 `dispatcher.buildPlan()` 中的脏字段分析
- 理想状态下，前端只需知道"这个节点发生了变化，可能需要预处理"，而不需要精确判断"是 content 变了还是 src 变了"
- 但完全去掉前端的判断会导致大量无效的预处理请求（如仅位置变化也触发请求）

**建议**：保持当前的两层过滤设计：

1. 前端用 `shouldPreprocessOnUpdate()` 做粗粒度过滤，减少不必要的 HTTP 请求
2. 服务端用 `dispatcher.buildPlan()` 做细粒度规划，确保只运行必要的阶段

---

## 后续工作清单

按优先级排列：

### P0 — 功能完整性

- [ ] 实现 `generate_summary` 和 `generate_keywords` 的 Enrich 能力（当前 profile 中声明但未实现）
- [ ] 为 video 节点集成 `YoutubeLoader`（当前 video 走到 Extract 阶段时无操作）

### P1 — 架构统一

- [ ] 引入统一的 `POST /api/canvas/:canvasId/nodes/:nodeId/preprocess` 路由
- [ ] 将前端 `triggerIngestion` + `triggerLabelResolve` 合并为 `triggerPreprocessing`
- [ ] 将 `PendingEffects.ingestNodes` + `labelResolveNodeIds` 合并为 `preprocessNodes`
- [ ] 更新 `CanvasEffectCallbacks` 接口为单回调
- [ ] 按节点类型或能力组实现差异化 debounce

### P2 — 增量 Enrich

- [ ] 实现后台 Enrich 通道（内容变更后异步运行 LLM 增强）
- [ ] 实现 `inputFingerprint` 为key的 Enrich 结果缓存
- [ ] 引入 request ID / revision token 防止过期结果覆盖

### P3 — 成本优化

- [ ] `ProviderManager` 中添加 per-canvas 或 per-session 的 token 预算
- [ ] 批量节点导入时的 Enrich 批处理支持
- [ ] Tavily Extract 调用纳入 `ProviderManager` 统一管理
