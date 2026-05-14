# Sketch Intent Pipeline 设计

> 当用户在画布上手绘 sketch（圈、线、叉…）后，系统如何把这些笔迹理解为「用户想做的操作」并自动执行。

---

## 1. 设计目标

| 目标             | 说明                                                             |
| ---------------- | ---------------------------------------------------------------- |
| 高准确率         | 让常见的连接/分组/删除/扩展手势能被正确识别                      |
| 低延迟           | 大多数手势应在毫秒级出结果，而不是等数秒 LLM 推理                |
| 可中断           | 用户切换工具或继续画线时，旧请求要能被取消                       |
| 可降级           | 规则识别不出来时，再调 LLM；LLM 拿到的也是结构化输入，而非纯图   |
| 与 canvas 强绑定 | 输出直接是可执行 intent（包含真实 node ID + 坐标），无字符串猜测 |

---

## 2. 总体架构（三阶段管线）

```
[SketchOverlay] 用户画完一笔
        │
        ▼
useIntentStore.onSketchCreated(id)            ← 收集 pending IDs
        │ debounce 3s
        ▼
triggerSketchRecognition()
        │
        ├── Stage 1: 笔迹聚类
        │       clusterSketches(strokes)                // handler/sketch/sketchClustering.ts
        │
        ├── Stage 2: 上下文抽取
        │       extractSketchContext(cluster, ...)      // handler/sketch/sketchContext.ts
        │
        └── Stage 3: 意图解析（vision LLM）
                resolveByLLM(ctx, screenshot)              // 调用 server
                                                           // server: sketch.service.ts
        │
        ▼
_onIntentChosen(combinedLabel, candidates)    ← 交给 operate agent 执行
        │
        ▼
deleteNodes(sketchIds)                        ← 执行完后清理 sketch node
```

---

## 3. 各阶段实现

### Stage 1 · 笔迹聚类

文件：[apps/web/src/handler/sketch/sketchClustering.ts](../apps/web/src/handler/sketch/sketchClustering.ts)

- 算法：Union-Find 单连接聚类（single-linkage）
- 距离度量：sketch node bounding box 之间的最小欧氏距离 (`rectEdgeDistance`)
- 阈值：`CLUSTER_DISTANCE_THRESHOLD = 200`（flow 像素）
- 输入：`SketchStroke[]`（包含 `id / rect / points / initialSize`）
- 输出：`SketchCluster[]`（包含 `strokeIds / strokes / bbox`）

为什么这么做：用户在画布左上画了个圈、又跑去右下画个叉时，这两组手势必须独立解析；空间相距越远越不应当合并。

### Stage 2a · 形状分类

文件：[apps/web/src/utils/sketch/classification.ts](../apps/web/src/utils/sketch/classification.ts)

支持类型：

| Shape    | 检测方法                                                   | 典型意图        |
| -------- | ---------------------------------------------------------- | --------------- |
| line     | 线性回归 R² ≥ 0.85 且路径长度接近端点直线距离              | 连接 / 高亮     |
| arrow    | line + 末段方向反转（dot < 0.3，存在箭头钩）               | 有向连接        |
| circle   | 起末点距离 < 路径 35%，多边形面积达到圆面积估计的 15% 以上 | 框选 / 编组     |
| cross    | 方向反转次数 ∈ [2,6]，且路径远长于端点直线距离             | 删除            |
| scribble | 路径长度 / bbox 对角线 ≥ 3 且方向反转 ≥ 3                  | 涂抹删除        |
| other    | 其他                                                       | 走 LLM fallback |

每个分类返回 `confidence`，影响是否能进入 Stage 3 规则路径。

### Stage 2b · 上下文抽取

文件：[apps/web/src/handler/sketch/sketchContext.ts](../apps/web/src/handler/sketch/sketchContext.ts)

输出 `SketchContext`：

- `nearbyNodes`：cluster bbox 周围 `NEARBY_RADIUS=300px` 内的非 sketch 节点（最多 8 个，按距离排序）
- `enclosedNodes`：与 padded bbox 相交且 ≥40% 面积被覆盖的节点
- `startNode / endNode`：当形状是 line/arrow 时，分别为线段两端最近的节点（自动避免同一节点同时充当起止点）

这一步把「视觉上 LLM 要 OCR 才能拿到的 node ID」变成结构化数据。

### Stage 3a · 规则引擎（高速路径）

文件：[apps/web/src/utils/sketch/rules.ts](../apps/web/src/utils/sketch/rules.ts)

| 形状           | 规则                                    | 输出 label                           |
| -------------- | --------------------------------------- | ------------------------------------ |
| line / arrow   | 起末两端各有一个不同的近邻节点 (<200px) | `Connect <a> to <b>`                 |
| circle         | 圈内 ≥ 2 个节点                         | `Group nodes [...] into a new frame` |
| circle         | 圈内 = 1 个节点                         | `Expand or elaborate on <node>`      |
| cross/scribble | 覆盖了节点                              | `Delete node(s) [...]`               |
| cross/scribble | 没覆盖节点但 50px 内有节点              | `Delete node <node>`                 |

不满足的全部 return null → 进入 LLM fallback。

### Stage 3b · LLM Fallback

调用链：

- 客户端：[apps/web/src/api/intent.ts](../apps/web/src/api/intent.ts) → `recognizeSketchCommands(screenshot, clusterContext, canvasId, signal)`
- 服务端 route：[apps/server/src/modules/agent/intent.route.ts](../apps/server/src/modules/agent/intent.route.ts)
- 服务端 service：[apps/server/src/modules/agent/intent.service.ts](../apps/server/src/modules/agent/intent.service.ts)
- 系统提示词：[apps/server/src/prompt/intent.ts](../apps/server/src/prompt/intent.ts)

请求体：

```ts
interface SketchIntentRequest {
  screenshot: string; // base64
  clusterContext: SketchClusterContext; // bbox + strokeCount + nearby/enclosed nodes + nearby edge ids
  canvasId?: string;
}
```

服务端把 `clusterContext` 序列化为高密度文本附在 user message 里，让 LLM 不需要 OCR 也能定位 node ID 与方向；要求只返回 1 个最可能 intent。

---

## 4. 与 PDF 论文方案的对应

| 论文 (PDF)                             | 本方案 (Canvas)                                  |
| -------------------------------------- | ------------------------------------------------ |
| 时空 single-linkage 聚类               | 空间 single-linkage 聚类（pending 队列即时间序） |
| 笔划分类（高亮/删除线/下划线/圈/其他） | 形状分类（line/arrow/circle/cross/scribble）     |
| 抽取覆盖文字 + 邻近段落                | 抽取 enclosedNodes + nearbyNodes                 |
| 4 个候选 purpose（specific/broad）     | 1 个最可能意图，直接执行                         |
| RAG 注入用户批注风格                   | 暂未实现，可走 episode log                       |

---

## 5. 关键代码入口

| 模块               | 路径                                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------------------- |
| 触发入口（store）  | [apps/web/src/store/intentStore.ts](../apps/web/src/store/intentStore.ts)                             |
| Stage 1 聚类       | [apps/web/src/handler/sketch/sketchClustering.ts](../apps/web/src/handler/sketch/sketchClustering.ts) |
| Stage 2 上下文抽取 | [apps/web/src/handler/sketch/sketchContext.ts](../apps/web/src/handler/sketch/sketchContext.ts)       |
| API 客户端         | [apps/web/src/api/intent.ts](../apps/web/src/api/intent.ts)                                           |
| 服务端 route       | [apps/server/src/modules/agent/intent.route.ts](../apps/server/src/modules/agent/intent.route.ts)     |
| 服务端 service     | [apps/server/src/modules/agent/sketch.service.ts](../apps/server/src/modules/agent/sketch.service.ts) |
| 共享类型           | [packages/shared/src/types/agent/intent.ts](../packages/shared/src/types/agent/intent.ts)             |
