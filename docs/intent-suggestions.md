非常好的想法！你希望实现一个**基于上下文的智能助手系统**，能够根据用户的操作历史、Canvas 状态等信息，**推测用户意图并提供可选的辅助方向**。  
这在交互式系统（如智能白板、可视化编程环境、AI 助手 IDE）中非常有价值。下面我帮你规划一下整体架构和可行性。

---

## 🧩 一、总体目标

实现一个“**上下文感知的智能助手**”，当用户请求帮助时，系统能：

1. 分析当前 Canvas 状态（节点、连接、内容类型等）；
2. 结合用户的操作历史（最近的编辑、搜索、创建行为）；
3. 推测用户的潜在意图；
4. 给出若干“可能的下一步操作建议”；
5. 用户选择一个后，系统自动执行或引导完成。

---

## 🏗️ 二、系统架构概览

可以分为以下几个模块：

### 1. **数据采集层**

负责收集上下文信息：

- **Canvas 状态**：节点类型、数量、连接关系、选中节点、未完成的任务等；
- **用户操作历史**：最近的操作序列（创建节点、搜索、编辑、删除等）；
- **用户输入上下文**：当前输入的文字、命令、问题；
- **系统状态**：当前模式（编辑、研究、总结等）。

> ✅ 这些数据可以通过事件监听器（event listeners）或状态管理系统（如 Redux、Vuex、Recoil）实时维护。

---

### 2. **意图识别层（AI 模型）**

核心模块，负责从上下文中推测用户意图。

可以采用两种方式：

- **规则 + 模型混合方式（推荐）**
  - 规则层：快速识别显式意图（如用户刚创建搜索节点 → 可能想要分析结果）。
  - 模型层：使用小型 LLM（或调用外部 API）分析上下文文本，生成潜在意图列表。

输出示例：

```json
{
  "intent_candidates": [
    { "label": "总结当前研究结果", "confidence": 0.82 },
    { "label": "扩展相关主题", "confidence": 0.67 },
    { "label": "生成可视化图表", "confidence": 0.45 }
  ]
}
```

---

### 3. **建议生成层**

根据识别出的意图，生成可执行的“帮助选项”列表。

例如：

- 如果意图是“总结当前研究结果” → 提供选项：
  - “生成摘要节点”
  - “导出为报告”
- 如果意图是“扩展相关主题” → 提供选项：
  - “搜索相关主题”
  - “创建新研究分支”

---

### 4. **用户交互层**

当用户按下“请求帮助”键时：

- 弹出一个 **建议面板（Suggestion Panel）**；
- 展示意图候选列表；
- 用户选择一个后，系统调用相应的功能模块（如 `functions.create_canvas_node` 或 `functions.web_search`）。

---

### 5. **执行层**

根据用户选择的选项，调用系统已有的功能接口（如你当前系统中的 `functions.*` 工具）执行操作。

---

## 🔄 三、数据流示意

```
[用户操作] → [上下文采集] → [意图识别模型] → [建议生成] → [用户选择] → [执行功能]
```

---

## 🧩 六、下一步建议

1. **定义上下文数据结构**（Canvas 状态 + 用户操作历史）；
2. **设计意图识别 Prompt 模板**；
3. **实现一个最小可行版本（MVP）**：
   - 用户按下“帮助” → 系统生成 3 个建议；
   - 用户选择 → 调用对应函数；
4. **逐步优化意图识别模型**（可加入用户反馈学习）。

---

## 📐 七、上下文数据结构定义

### 设计原则

采用**分层设计**：基础快照随每次请求自动注入（小体积、高价值），细节内容由 Agent 通过 Tool 按需拉取，避免一次性塞入过多 token。

> 注意：纯数字统计（节点数量、type count）对 LLM 没有语义价值。**节点的 label + content snippet** 才是真正的语义信号。同理，`RecentAction` 必须携带节点 label，光有 `action: "node_edited"` LLM 无法推断意图。

---

### 核心类型定义

```typescript
// packages/shared/src/types/context.ts

export type RecentActionType =
  | 'node_created'
  | 'node_deleted'
  | 'node_edited' // debounce 后触发，非每次击键
  | 'node_connected'
  | 'node_disconnected'
  | 'node_selected' // 最强的即时意图信号
  | 'node_expanded' // 打开 expanded panel
  | 'node_framed' // 归入 frame（分组意图）
  | 'node_unframed';

export interface RecentAction {
  action: RecentActionType;
  nodeType?: CanvasNodeType;
  /** 操作涉及的节点 label —— LLM 最需要这个 */
  label?: string;
  /** node_connected 时的目标节点 label；node_framed 时的 frame label */
  targetLabel?: string;
  timestamp: number; // epoch ms
}

export interface NodeSummary {
  id: string;
  type: CanvasNodeType;
  label?: string;
  /** 前 120 字纯文本；note/text 取 content，web/pdf 取 src */
  snippet?: string;
  /** 是否当前被选中 */
  selected: boolean;
  /** 所属 frame 的 label（如有） */
  frameLabel?: string;
}

export interface AgentBaseContext {
  /** 全部节点的轻量摘要 */
  nodes: NodeSummary[];
  /** 语义化边：只传 label 对，不传坐标/id */
  edges: Array<{ sourceLabel?: string; targetLabel?: string }>;
  /** 最近 8~10 条操作，前端维护环形缓冲区 */
  recentActions: RecentAction[];
}
```

---

### 发送给 LLM 时序列化为自然语言

在服务端将 `AgentBaseContext` 转成自然语言段落注入 prompt，**不要直接发原始 JSON**：

```
Canvas 当前有 5 个节点：
- 笔记"气候变化影响"（已选中）：近十年全球气温上升幅度...
- 网页节点"IPCC 2024 报告"：https://ipcc.ch/report/2024
- Frame"研究汇总"包含：气候变化影响、IPCC 2024 报告

节点连接关系：
- "气候变化影响" → "IPCC 2024 报告"

最近操作：
- 刚刚 选中了"气候变化影响"
- 2分钟前 将"气候变化影响"和"IPCC 2024 报告"连接
- 5分钟前 编辑了"气候变化影响"
```

---

### 扩展 `SendMessageRequest`

```typescript
// packages/shared/src/types/chat.ts
export interface SendMessageRequest {
  content: string;
  threadId: string;
  selectedSourceIds: string[];
  canvasContext?: AgentBaseContext; // 新增，可选，向后兼容
}
```

---

## 🛠️ 八、实现路径

| 步骤       | 改动位置                                 | 内容                                                                                                                                                | 优先级  |
| ---------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| **Step 1** | `apps/web/src/store/canvasStore.ts`      | 增加 `recentActions: RecentAction[]` 环形缓冲区；在 `addNode`、`deleteNode`、`onConnect` 等操作中 push 事件；`node_edited` 复用 debounce timer 模式 | 🔴 最先 |
| **Step 2** | `apps/web/src/store/canvasStore.ts`      | 增加 `getAgentContext()` selector，从当前 nodes/edges/recentActions 构建 `AgentBaseContext` 快照                                                    | 🔴 最先 |
| **Step 3** | `packages/shared/src/types/chat.ts`      | `SendMessageRequest` 增加可选字段 `canvasContext?: AgentBaseContext`                                                                                | 🔴 最先 |
| **Step 4** | `apps/server/src/modules/agent/graph.ts` | 读取 `canvasContext`，序列化为自然语言段落，注入 system/human message                                                                               | 🟠 其次 |
| **Step 5** | `apps/server/src/modules/agent/tools/`   | 注册 `get_node_content(nodeId)` tool，复用 `canvas.db.ts` 接口，供节点数量多时按需读取完整内容                                                      | 🟡 后续 |

---

## ✅ TODO List

### 上下文数据结构定义

- [-] **Step 1** — 定义共享类型：新建 `packages/shared/src/types/context.ts`，扩展 `SendMessageRequest` 加入 `canvasContext`
- [ ] **Step 2** — 前端采集上下文：`canvasStore` 维护 `recentActions` 环形缓冲区，各操作处 push 对应事件，新增 `getAgentContext()` 快照 selector
- [ ] **Step 3** — 前端发送上下文：发送消息时附加 `canvasContext` 到请求
- [ ] **Step 4** — 服务端注入 prompt：`AgentState` 增加 `canvasContext` 字段，`callModel` 中将其序列化为自然语言段落注入 prompt
- [ ] **Step 5** _(后续)_ — 按需读取 Tool：新增 `get_node_content` tool，供 Agent 在节点多时按需拉取完整内容
