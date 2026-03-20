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

| 文件                                   | 变更                                                                                                                                               |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/store/canvasStore.ts`    | 将 `io/ingest` + `io/resolveLabel` 的导入替换为 `io/preprocess`。`triggerIngestion` 和 `triggerLabelResolve` 现在都调用 `preprocessNodeIfNeeded`。 |
| `apps/web/src/store/canvasHandlers.ts` | 用 `shouldPreprocessOnUpdate` 替换了 `shouldIngestOnUpdate`。 `needsLabelResolve` 的导入来源从 `io/resolveLabel` 改为 `io/preprocess`。            |
| `apps/web/src/utils/io/index.ts`       | 更新 re-exports：用 `preprocess` 模块导出替换了 `ingest` 模块导出。                                                                                |

### 删除/弃用的文件

| 文件                                                  | 状态                                                        |
| ----------------------------------------------------- | ----------------------------------------------------------- |
| `apps/web/src/utils/io/ingest.ts`                     | **已弃用** — 被 `preprocess.ts` 替代。无任何剩余导入。      |
| `apps/web/src/utils/io/resolveLabel.ts`               | **已弃用** — 被 `preprocess.ts` 替代。无任何剩余导入。      |
| `apps/server/src/modules/knowledge/ingest.service.ts` | **已弃用** — 被 `preprocessing/` 模块替代。无任何剩余导入。 |

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
