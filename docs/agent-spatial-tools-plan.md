# Agent 空间/拓扑工具重构 Plan

> 目标：在 agent 已有 `read` / `grep` / `find` / `ls`（按文本/文件名找节点 + 取正文）
> 之上，把"按空间关系或拓扑结构理解 canvas"这一面用最少的工具集补齐。

## 1. 背景

现状只有两块碎片：

- [`get_node_geometry`](../apps/server/src/modules/agent/tools/handlers/canvas-read.ts) — 单节点 position/size/parentId/style。
- [`get_canvas_state`](../apps/server/src/modules/agent/tools/handlers/canvas-read.ts) — 全量节点摘要 + edges，**无 position/size/style**，**无空间结构**。

而 [packages/shared/src/utils/spatial.ts](../packages/shared/src/utils/spatial.ts)
已经有一套零依赖、前后端共用的空间推理库：`rectEdgeDistance` /
`relativeDirection` / `findNearbyNodes` / `findClusters` / `nodesInRect` /
`sortByReadingOrder` / `detectArrangement` / `buildSpatialSummary` /
`buildQuestionNodeContext`。今天只在前端 [`canvasStore.getCachedSpatialData`](../apps/web/src/store/canvasStore.ts)
里被调用，作为静态 `spatialSummary` 塞进 `AgentBaseContext` —— agent 在 tool loop
里没法主动查。

服务端只是缺一层薄薄的"工具入口"，计算逻辑无需重写。

## 2. 设计原则

1. **磁盘可读的不重复造**：node 的 label/content/summary/keywords 已经在
   `nodes/<id>.md`，由 `read` 拿；空间工具只暴露 canvas.json 里的字段
   （position/size/parentId/style）+ 派生的几何关系。
2. **几何字段一次给齐**：outline 直接带 position/size，agent 拿到地图就能粗略
   空间推理，不用每节点 round-trip 一次。
3. **少量参数化谓词覆盖多种问题**，避免 14 个 `find_xxx_by_yyy`。
4. **结构化 JSON 优先，自然语言次之**：返回 ID + 数字（distance、direction），
   让 agent 自己组合下一步。

## 3. 工具集变更

| 变化 | 工具                                                                                                |
| ---- | --------------------------------------------------------------------------------------------------- |
| 删   | `get_canvas_state`、`get_node_geometry`                                                             |
| 加   | `get_canvas_outline`、`inspect_nodes`                                                               |
| 不动 | `read` / `grep` / `find` / `ls` / `canvas_commands` / `ingest_content` / `web_search` / `use_skill` |

工具总数 9 → 9。`get_node_geometry` 等价于 `inspect_nodes({ ids: [id] })`
的退化形式（包含 style），不再单独存在。

## 4. 工具签名

### 4.1 `get_canvas_outline`

> 整张画布的"地图"。Agent 第一次进场或换画布时调用一次，之后基本不再需要全量。

**参数**

```ts
{
  canvasId?: string,          // 复用 OptionalCanvasIdField
  includePreviews?: boolean,  // 默认 false；预览交给 read/grep
  includeStyle?: boolean,     // 默认 false；视觉任务才需要
}
```

**返回**

```ts
{
  canvasId: string,
  version: number,
  bbox: { x, y, width, height } | null,            // 全画布 bbox（无节点时 null）
  nodes: Array<{
    id, type, label, parentId,                    // type='frame' 的条目就是 frame
    position: { x, y },                            // 绝对坐标
    width, height,                                 // 来自 measured ?? style ?? 0
    style?: object,                                // includeStyle=true 才送
    preview?: string,                              // includePreviews=true 才送
  }>,
  edges: Array<{ id, source, target, style? }>,
  spatial: {
    clusters: Array<{
      frameId?, frameLabel?,
      nodeIds: string[],                           // 已 reading-order
      arrangement: string,                         // detectArrangement()
    }>,
  },
}
```

> **Frame 树为什么不显式给**：frame 也是 node（`type='frame'`），自带几何；
> "哪些 node 在哪个 frame 里" 完全可由 `nodes[*].parentId` 派生，agent
> 一次 `groupBy(parentId)` 就有。再加一个 `frames` 字段会和 `nodes` 信息
> 重叠，徒增 schema 表面积。`spatial.clusters` 已经把 `frameId` /
> `frameLabel` 标好，定位 frame 不用再扫一遍。
>
> **Isolated 同理不取**：孤立节点 = 全部 nodeIds 减 `clusters[*].nodeIds`
> 的并集，agent 一行 setDiff 就出来。`clusters` 本身是 O(n²) 单链聚类
> 的结果，不能派生、必须服务端给。

### 4.2 `inspect_nodes`

> 一个工具承包"按属性 / 按拓扑 / 按空间"找节点的所有变体，并返回节点的
> 完整属性（几何 + style + 派生拓扑信息）。谓词 mutually combinable，未填
> 字段忽略。名字选 `inspect`（而非 `filter`）是为了同时表达"找"和"看清楚"
> 两件事。

**参数**

```ts
{
  canvasId?: string,
  // ── 属性谓词 ──
  ids?: string[],
  byType?: string | string[],
  byParent?: string | null,                        // null = 仅顶层
  labelPattern?: string,                           // 正则；和 grep 互补
  // ── 空间谓词 ──
  inRect?: { x, y, width, height },                // nodesInRect（中心命中）
  nearNode?: { id: string, maxDistance?: number, maxCount?: number, sameParent?: boolean },
  nearPoint?: { x: number, y: number, maxDistance?: number, maxCount?: number },
  inSameClusterAs?: string,                        // 复用 buildSpatialSummary
  // ── 拓扑谓词 ──
  connectedTo?: { id: string, depth?: 1 | 2 },     // 边邻接（默认 1 跳）
  // ── 输出 ──
  sort?: 'distance' | 'reading-order' | 'area',
  limit?: number,                                  // 默认 50
}
```

**返回**

```ts
{
  count: number,                                   // 命中数量（≤ limit）
  truncated: boolean,                              // 实际匹配 > limit 时为 true
  arrangement?: string,                            // detectArrangement，count ≥ 2 时
  nodes: Array<{
    id, type, label, parentId,
    position: { x, y },
    width, height,
    style?: object,                                // 替代 get_node_geometry
    // 派生字段（按谓词附加）
    distance?: number,                             // 边到边，nearNode/nearPoint
    centerDistance?: number,
    direction?: 'left'|'right'|'above'|'below',
    edgeIds?: string[],                            // connectedTo
    hops?: 1 | 2,                                  // connectedTo 且 depth=2 时
    clusterId?: string,                            // inSameClusterAs
  }>,
}
```

错误约定：

```ts
{ error: "Canvas <id> not found" }
{ error: "Node <id> not found (used in nearNode/connectedTo)" }
{ count: 0, truncated: false, nodes: [] }   // 合法查询、零命中
```

## 5. 谓词到场景的覆盖矩阵

| #   | 场景                                          | 调用                                                                                                                                                                                             |
| --- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | 画布大概长什么样？几个 frame、几片簇？        | `get_canvas_outline()` → `nodes` 里 filter `type='frame'` + `spatial.clusters`                                                                                                                   |
| 2   | 节点 X 在哪？多大？属于哪个 frame？           | `inspect_nodes({ ids: ['…'] })`                                                                                                                                                                  |
| 3   | X 周围有什么？最近 5 个邻居 + 方向？          | `inspect_nodes({ nearNode: { id, maxCount: 5 } })`                                                                                                                                               |
| 4   | X 在 graph 上连了谁？                         | `inspect_nodes({ connectedTo: { id } })`                                                                                                                                                         |
| 5   | 和 X 同 frame 的兄弟？                        | `inspect_nodes({ byParent: 'frame-…' })`                                                                                                                                                         |
| 6   | frame 内按什么形式排列？                      | `inspect_nodes({ byParent: 'frame-…', sort: 'reading-order' })` → `arrangement`                                                                                                                  |
| 7   | 区域 (x,y,w,h) 里有什么？                     | `inspect_nodes({ inRect: {…} })`                                                                                                                                                                 |
| 8   | 所有 image 节点？                             | `inspect_nodes({ byType: 'image' })`                                                                                                                                                             |
| 9   | 孤立节点？                                    | 全部 `nodes[*].id` 减 `spatial.clusters[*].nodeIds` 的并集                                                                                                                                       |
| 10  | "X 在 frame A 内偏右；frame A 在画布中央偏下" | 现阶段不加专门工具；agent 用 outline + nearNode 自己拼。如果后续 trace 显示高频需要，再 wrap [`buildQuestionNodeContext`](../packages/shared/src/utils/spatial.ts) 为 `describe_node_position`。 |

## 6. 落地步骤

### Step 1 — 服务端空间助手（新文件）

`apps/server/src/modules/agent/canvas-spatial.ts`

- `buildSpatialNodes(canvasFile)`：把 canvas.json 的 nodes 转 `SpatialNode[]`。
  - 大小取 `measured ?? style ?? top-level ?? 0`，对齐前端 [`getNodeSize`](../apps/web/src/utils/node/size.ts)。
  - 位置解析为绝对坐标（顺着 parentId 累加）。
  - 透传 `type` / `parentId` / `label`。
- `buildCanvasOutline(canvasId, opts)`：返回 §4.1 形状。
- `inspectNodes(canvasId, args)`：返回 §4.2 形状。

### Step 2 — schema + tool definition

`apps/server/src/modules/agent/tools/definitions.ts`：

- 删 `getCanvasStateParamsSchema/getCanvasStateTool`、
  `getNodeGeometryParamsSchema/getNodeGeometryTool`。
- 加 `getCanvasOutlineParamsSchema/getCanvasOutlineTool`、
  `inspectNodesParamsSchema/inspectNodesTool`。
- description 写清三件事：
  1. 数据来源是 canvas.json，不读 nodes/<id>.md；
  2. 内容（label/content/summary/keywords）→ 用 `read`；
  3. 子谓词的边界（什么时候用 outline、什么时候用 inspect_nodes）。
- `chatTools` / `operateTools` 列表替换。

### Step 3 — handler

`apps/server/src/modules/agent/tools/handlers/canvas-read.ts`：

- 删 `handleGetCanvasState`、`handleGetNodeGeometry`。
- 加 `handleGetCanvasOutline`、`handleInspectNodes`，body 极薄，调 Step 1 的助手。

### Step 4 — dispatcher

`apps/server/src/modules/agent/tools/executor.ts`：替换 case 分支。

### Step 5 — annotation intent agent 切换

[`apps/server/src/modules/agent/intent.service.ts`](../apps/server/src/modules/agent/intent.service.ts)
把 `getNodeGeometryTool` 换成 `inspectNodesTool`，prompt 文案同步更新。

### Step 6 — 提示文案与注释扫尾

- `agent.route.ts` 中提及 `get_node_geometry` 的 SYSTEM Context 文案。
- `read.ts` / `canvas-fs.ts` 头注释中"对照 `get_node_geometry`"的部分。
- `canvas-read.ts` 头注释整体改写。
- `definitions.ts` 中 `read` / `grep` 工具描述里提到 `get_node_geometry` 的地方。

### Step 7 — 验证

- `get_errors` 跑全仓库。
- `pnpm -w typecheck`（如果可用）。
- 不写新单测；现有 spatial 库已经在 shared 包里，逻辑未改。

## 7. 不在本 PR 范围

- 前端 `getCachedSpatialData` 与 `AgentBaseContext.spatialSummary`：保留作为
  outline 的"预热缓存"，不再是 agent 唯一的空间信息来源；本次不动。
- `describe_node_position`（场景 10）：观察 trace 后再决定是否要 wrap
  `buildQuestionNodeContext`。
- 视觉信号（screenshot）：与本设计正交。
