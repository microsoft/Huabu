# Sketch Node 设计

> Sketch node 的二次设计：把它从「画一笔 → 等 3s → AI 自动消费的临时手势」重塑成「可持久化、可分组、可显式触发 AI 解读的草图节点」。

---

## 1. 设计目标

| 目标                         | 说明                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------ |
| 草图作为普通节点持久化       | 草图不会因 AI 解读「自动蒸发」；节点生命周期由用户掌控（删 / 改色 / 移动 / 嵌入 frame）。              |
| 自动 group（空间 + 时间窗）  | 多笔草图按空间邻近 + 时间相近自动归到一个 frame group；用户可手动拆出，拆出后不再被自动吸回。          |
| Group 可保存为文件 (Phase 2) | sketch-group 一键 Flatten 成 SVG artifact，group frame 转成 image 节点指向 `artifacts/sketch-*.svg`。  |
| 显式触发 AI 解读             | 用户圈选 sketch（或 group） → toolbar `✨ Apply Sketch` → 走原有 vision LLM 管线得到 canvas commands。 |
| 不破坏现有数据               | 现有 canvas 文件零迁移可直接打开。                                                                     |

---

## 2. 现状盘点

### 2.1 数据落盘

| 节点类型                                                      | canvas.json 内 inline | 同名 `nodes/<safe(label)>.md` | 备注                                                                                                                               |
| ------------------------------------------------------------- | --------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `note` / `text` / `web` / `pdf` / `image` / `video` / `frame` | 元数据                | ✅ 有                         | 文本类有 markdown body；媒体类只有 frontmatter                                                                                     |
| `sketch`                                                      | **笔迹几何**          | ✅ 有（frontmatter-only）     | `points: number[][]` / `initialSize` / `executed` 等幾何数据 inline 在 `state.nodes[i].data`；sidecar 只持久化 label / labelSource |
| `question`                                                    | 元数据 + input/status | ✅ 有（frontmatter-only）     | 同上，label / labelSource 走 sidecar                                                                                               |

`MD_BACKED_NODE_TYPES` 白名单见 [canvas.route.ts](../apps/server/src/modules/canvas/canvas.route.ts) `MD_BACKED_NODE_TYPES`。Sketch 以 frontmatter-only sidecar 参与：笔迹几何仍然 inline 在 `canvas.json`，sidecar 仅用于持久化 canvas-engine 自动生成（或用户手动改名）的 `label` / `labelSource`——同 structure PUT 会剧脱这些字段，不走 sidecar 则刷新后会丢。模式与 `question` / `image` / `video` / `frame` 一致。落盘体积：单笔草图 ~ 0.5–3 KB，对 canvas.json 影响可忽略。

### 2.2 已有基础设施（Phase 1 直接复用）

- **节点结构**：`SketchNodeData`（[node.ts](../packages/shared/src/types/canvas/node.ts)），含 `points` / `initialSize` / `strokeColor` / `executed`。
- **绘制工具**：`SketchOverlay`（[SketchOverlay.tsx](../apps/web/src/components/Nodes/sketch/SketchOverlay.tsx)）—— pointer 事件捕获 + 实时 SVG 预览 + 创建 sketch node。
- **空间聚类**：`clusterSketches()`（[sketchClustering.ts](../apps/web/src/handler/sketch/sketchClustering.ts)）—— Union-Find，bbox 边距 ≤ 200px。
- **上下文抽取**：`extractSketchContext()`（[sketchContext.ts](../apps/web/src/handler/sketch/sketchContext.ts)）—— 收集 cluster bbox 周围节点 / 边的 wire ref。
- **截图**：`captureCanvasScreenshot()`（[screenshot.ts](../apps/web/src/handler/canvasCommand/utils/screenshot.ts)）。
- **服务端 LLM 管线**：`recognizeSketchCommands()`（[sketch.service.ts](../apps/server/src/modules/agent/sketch.service.ts)）—— 截图 + 上下文 → vision LLM → canvas commands。
- **状态机 / 浮窗**：`SketchProcessingOverlay`（[SketchProcessingOverlay.tsx](../apps/web/src/components/Nodes/sketch/SketchProcessingOverlay.tsx)）—— preparing / pending / running / done 四态 + Accept / Revert 按钮。
- **多选 toolbar 容器**：`MultiSelectToolbar`（[MultiSelectToolbar.tsx](../apps/web/src/components/Panels/Canvas/MultiSelectToolbar.tsx)）。
- **单选 toolbar 容器**：`NodeWrapper` 的 `<NodeToolbar>` 槽位（[NodeWrapper.tsx](../apps/web/src/components/Nodes/NodeWrapper.tsx)）。

### 2.3 当前行为的不合理之处

1. **3 秒 idle timer 自动触发 AI 识别**：用户必须等待，且对触摸笔/平板用户不可控。
2. **识别成功后笔迹被打半透明灰**（`executed: true` 触发 `opacity: 0.25`，[SketchNode.tsx](../apps/web/src/components/Nodes/sketch/SketchNode.tsx)），暗示「这个节点已死」，与「sketch 是普通节点」的诉求冲突。
3. **Accept 默认会 `DELETE_NODES` 删笔迹**（[intentStore.ts:405-428](../apps/web/src/store/intentStore.ts#L405-L428)），把 sketch 当一次性手势看。
4. **没有显式触发入口**：用户无法主动告诉系统「现在帮我解读这一组 sketch」；只能等 timer。

---

## 3. 设计方案（两阶段）

### Phase 1 — 把 sketch 变成「按需触发」的普通节点

**目标**：去掉 idle timer，加显式按钮触发；sketch 视觉上保持普通节点；其他基础设施保持不动。

| 改动                  | 文件 / 模块                                                                               | 说明                                                                                                              |
| --------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 删除 3s idle timer    | [intentStore.ts](../apps/web/src/store/intentStore.ts) `onSketchCreated`                  | 不再 `setTimeout(triggerSketchRecognition, 3000)`；只更新 `pendingSketchIds` 用于下次显式触发的入参。             |
| 显式触发 API          | [intentStore.ts](../apps/web/src/store/intentStore.ts)                                    | 新增 `requestSketchRecognition(sketchIds: string[])`：把传入 IDs 直接当一个或多个 cluster，复用现有 Stage 1+2+3。 |
| 移除自动 timer 副作用 | [intentStore.ts](../apps/web/src/store/intentStore.ts)                                    | `cancelSketchRecognition` 仍然能 abort 进行中的批次，并清空 overlay。                                             |
| Sketch 不再 dim       | [SketchNode.tsx](../apps/web/src/components/Nodes/sketch/SketchNode.tsx)                  | 移除 `executed` → `opacity: 0.25`。`executed` 字段保留（Accept/Revert 状态机仍在用）。                            |
| 多选 toolbar 加按钮   | [MultiSelectToolbar.tsx](../apps/web/src/components/Panels/Canvas/MultiSelectToolbar.tsx) | 选中 ≥2 节点且**全部** `type === 'sketch'` 时显示 `✨ Apply Sketch` 按钮，onClick 调 `requestSketchRecognition`。 |
| 单选 toolbar 加按钮   | [SketchNode.tsx](../apps/web/src/components/Nodes/sketch/SketchNode.tsx)                  | 把 `toolbar={<ApplySketchButton />}` 传进 `NodeWrapper`，onClick 同上但只传 `[id]`。                              |

**未改动**：

- 服务端 `sketch.service.ts`、`intent.route.ts`、prompt 全部不动。
- 共享类型 `SketchNodeData`、`SketchCluster`、`SketchStroke` 不动。
- Accept / Revert 行为沿用现状（用户在 overlay 上点 Accept = 删笔迹保留命令；点 Revert = 撤销命令保留笔迹）。

**Phase 1 不会处理**的东西：

- 自动 group。
- Flatten 为文件。
- Sketch 与已有 frame 的交互细节（手动拖入/拖出 frame 走 RF 原生流程）。
- 重命名 `annotation` → `sketch`（已在 `sketch` 分支一次性完成；历史文档中仍可能出现旧名称）。

### Phase 2 — 自动 group + Flatten-to-SVG

**目标**：根据空间 + 时间相近性自动把 sketch 归到 `sketch-group` frame；group 可一键 Flatten 成 SVG artifact 并被 image 节点引用。

| 改动                           | 文件 / 模块                                                                | 说明                                                                                                                                                                     |
| ------------------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SketchStroke.createdAt`       | [intent.ts](../packages/shared/src/types/agent/intent.ts) `SketchStroke`   | 时间窗聚类需要。                                                                                                                                                         |
| `FrameNodeData.kind`           | [node.ts](../packages/shared/src/types/canvas/node.ts) `FrameNodeData`     | 加可选 `kind?: 'sketch-group'` 区分专用 group。**不**新增节点类型，避免污染白名单。                                                                                      |
| `SketchNodeData.userExtracted` | [node.ts](../packages/shared/src/types/canvas/node.ts) `SketchNodeData`    | sticky 标记：用户手动从 group 拖出后置位，再也不会被自动吸回。                                                                                                           |
| 自动 group 调度器              | 新文件 `apps/web/src/handler/sketch/autoGroupSketches.ts`                  | sketch settle 800ms 后跑 `clusterSketches`（带时间窗 ≤ 10s + 跳过 `userExtracted`），命中 ≥ 2 笔 → 创建 `sketch-group` frame 父节点，把 sketches 设为它的子节点。        |
| Sketch group toolbar 按钮      | `MultiSelectToolbar` / `FrameNode` toolbar                                 | `Flatten` 按钮：选中一个 `kind === 'sketch-group'` frame 时显示。                                                                                                        |
| Flatten 实现                   | 新函数 `flattenSketchGroup(frameId)`                                       | 把子 sketches 的 `points` 渲染成 SVG 字符串 → POST `/api/artifact` 拿到 `artifacts/sketch-<uuid>.svg` URL → `REPLACE_NODE` 把 frame 换成 `image` 节点（保留位置/尺寸）。 |
| Artifact 接受 SVG MIME         | [artifact.route.ts](../apps/server/src/modules/artifact/artifact.route.ts) | 验证 `image/svg+xml` 已支持；如未支持则放行。                                                                                                                            |

**落盘路径汇总**（Phase 1 + Phase 2 完成后）：

```
canvas/<canvasId>/
├── canvas.json                         ← sketch 笔迹 inline 在 state.nodes[]，sketch-group frame 元数据也在这里
├── nodes/
│   └── <safe(group-label)>.md          ← sketch-group frame 的 frontmatter 文件（沿用 frame 现有规则）
└── artifacts/
    └── sketch-<uuid>.svg               ← Flatten 后的可视产物（被 image 节点引用）
```

---

## 4. 触发流程（Phase 1）

```
用户画 N 笔                           用户圈选 sketch
   │                                      │
   ▼                                      ▼
SketchOverlay.handlePointerUp         React Flow 多选/单选
   │                                      │
   ▼                                      ▼
addNode({type: 'sketch', ...})        selected: true
   │                                      │
   ▼                                      ▼
intentStore.onSketchCreated(id)       MultiSelectToolbar / NodeToolbar
   │                                      │
   │ (只更新 pendingSketchIds              │ ✨ Apply Sketch onClick
   │  用于聚类预览，不再启 timer)        │
   │                                      ▼
   ▼                                  intentStore.requestSketchRecognition(ids)
（什么都不会自动发生）                     │
                                          ├── Stage 1: clusterSketches(strokes)
                                          ├── Stage 2: extractSketchContext(cluster, ...)
                                          └── Stage 3: captureCanvasScreenshot()
                                                     + recognizeSketchCommands()
                                                     → SketchProcessingOverlay
                                                       (preparing → pending → running → done)
                                                     → 用户在 overlay 上 Accept / Revert
```

---

## 5. 风险与缓解

| 风险                          | 说明                                                             | 缓解                                                                                |
| ----------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 失去「画完即识别」的环境式 AI | 多了 1–2 步操作。                                                | Phase 2 后可加 toggle 让重度用户重新启用 idle timer（默认仍关）。                   |
| 触摸/平板用户体验下降         | Lasso-select 在触摸屏上不友好。                                  | 单笔 sketch 的单选 toolbar 也提供按钮，长按手写笔即可触发。                         |
| 用户主动触发 → AI 调用频率↑   | 不再被 idle timer 误触，但用户主动用 = 真有意图，整体 ROI 更高。 | 不缓解，符合产品方向。                                                              |
| 历史 canvas 有 dim 灰笔迹     | 老 canvas 中的 `executed: true` sketch 之前是半透明的。          | Phase 1 移除 dim 渲染后，老笔迹会自动恢复正常显色，无需 migration（数据字段不动）。 |
| Phase 2 自动 group 反复抖动   | 用户拆开后又被自动合回去会很烦。                                 | `userExtracted` sticky 标记 + 已在某 group 内的 sketch 不再参与新一轮聚类。         |

---

## 6. 后续可能的演进（不在 Phase 1/2 内）

- ~~**重命名 `annotation` → `sketch`**：已在 `sketch` 分支完成（代码 + 文件名 + 目录 + 文档 + API 路径全量重命名）。~~
- **Sketch 模板库**：把高频 group flatten 出的 SVG 收进 sources/，下次 paste 直接复用。
- **多色 / 笔触粗细 toolbar**：sketch 节点单选时加 stroke color picker + width slider。

---

## 7. 相关文件与索引

| 主题                | 文件                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 节点类型定义        | [packages/shared/src/types/canvas/node.ts](../packages/shared/src/types/canvas/node.ts)                                         |
| 笔迹 / cluster 类型 | [packages/shared/src/types/agent/intent.ts](../packages/shared/src/types/agent/intent.ts)                                       |
| 绘制工具            | [apps/web/src/components/Nodes/sketch/SketchOverlay.tsx](../apps/web/src/components/Nodes/sketch/SketchOverlay.tsx)             |
| Sketch 节点渲染     | [apps/web/src/components/Nodes/sketch/SketchNode.tsx](../apps/web/src/components/Nodes/sketch/SketchNode.tsx)                   |
| 客户端管线          | [apps/web/src/store/intentStore.ts](../apps/web/src/store/intentStore.ts)                                                       |
| 聚类                | [apps/web/src/handler/sketch/sketchClustering.ts](../apps/web/src/handler/sketch/sketchClustering.ts)                           |
| 上下文              | [apps/web/src/handler/sketch/sketchContext.ts](../apps/web/src/handler/sketch/sketchContext.ts)                                 |
| 服务端识别          | [apps/server/src/modules/agent/sketch.service.ts](../apps/server/src/modules/agent/sketch.service.ts)                           |
| 多选 toolbar        | [apps/web/src/components/Panels/Canvas/MultiSelectToolbar.tsx](../apps/web/src/components/Panels/Canvas/MultiSelectToolbar.tsx) |
| 单选 toolbar 槽     | [apps/web/src/components/Nodes/NodeWrapper.tsx](../apps/web/src/components/Nodes/NodeWrapper.tsx)                               |
| Canvas 持久化       | [apps/server/src/modules/canvas/canvas.route.ts](../apps/server/src/modules/canvas/canvas.route.ts) `MD_BACKED_NODE_TYPES`      |
