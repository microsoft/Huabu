# Deep Research - 结构化实现方案

> 基于现有 Sediment 架构的模块化实现计划

---

## 📋 目录

1. [架构概览](#架构概览)
2. [模块划分](#模块划分)
3. [数据流设计](#数据流设计)
4. [接口定义](#接口定义)
5. [实现步骤](#实现步骤)
6. [目录结构](#目录结构)

---

## 🏗️ 架构概览

```
┌─────────────────────────────────────────────────────────────┐
│                     Frontend (React)                         │
├─────────────────────────────────────────────────────────────┤
│  ChatPanel                                                   │
│  ├─ ChatInput (+ Deep Research 按钮)                        │
│  ├─ ResearchProgressCard (新)                               │
│  └─ MessageList                                              │
│                                                              │
│  Canvas                                                      │
│  ├─ ResearchNodeWrapper (带紫色边框，新)                   │
│  └─ CanvasStore (扩展布局方法)                              │
├─────────────────────────────────────────────────────────────┤
│                    API Layer (SSE)                           │
├─────────────────────────────────────────────────────────────┤
│  /chat/research (新路由)                                     │
│  ├─ 接收研究请求                                             │
│  ├─ 调用 ResearchGraph                                       │
│  └─ 流式返回 ResearchEvent                                   │
├─────────────────────────────────────────────────────────────┤
│              Server Backend (Node.js)                        │
├─────────────────────────────────────────────────────────────┤
│  ResearchGraph (LangGraph)                                   │
│  ├─ QueryAnalysisNode                                        │
│  ├─ MultiSearchNode                                          │
│  ├─ IngestionNode                                            │
│  ├─ SynthesisNode                                            │
│  └─ CanvasOrganizationNode                                   │
│                                                              │
│  CanvasOperationService (新)                                │
│  ├─ createNode()                                             │
│  ├─ createFrame()                                            │
│  ├─ calculateLayout()                                        │
│  └─ updateCanvasState()                                      │
│                                                              │
│  ResearchState (新状态管理)                                  │
│  └─ 追踪研究进度、节点映射                                  │
├─────────────────────────────────────────────────────────────┤
│              Database (SQLite)                               │
├─────────────────────────────────────────────────────────────┤
│  canvas.sqlite                                               │
│  ├─ canvases (现有)                                          │
│  ├─ canvas_nodes (现有)                                      │
│  └─ research_sessions (新，可选)                            │
│                                                              │
│  knowledge.sqlite (现有)                                     │
│  └─ sources, source_revisions                               │
└─────────────────────────────────────────────────────────────┘
```

---

## 📦 模块划分

### 后端模块 (apps/server/src/modules/)

#### 1. research/ (新模块)

```
research/
├── research.route.ts          # 路由：POST /chat/research
├── research.service.ts        # 业务逻辑：协调 graph 和 canvas 操作
├── research.types.ts          # 类型定义：ResearchEvent, ResearchConfig
└── graphs/
    ├── research.graph.ts      # LangGraph 定义
    ├── research.state.ts      # ResearchState 定义
    └── nodes/
        ├── query-analysis.node.ts
        ├── multi-search.node.ts
        ├── ingestion.node.ts
        ├── synthesis.node.ts
        └── canvas-organization.node.ts
```

**职责**：

- 接收研究请求
- 编排 LangGraph 工作流
- 发送 SSE 事件到前端

---

#### 2. canvas/ (扩展现有模块)

```
canvas/
├── canvas.route.ts            # 现有：CRUD 路由
├── canvas.db.ts               # 现有：数据库操作
├── canvas.operation.ts        # 新：Canvas 操作服务
└── layout/
    ├── layout.service.ts      # 新：布局算法
    ├── bounds.calculator.ts   # 新：边界计算
    └── strategies/
        ├── right-placement.ts
        ├── bottom-placement.ts
        └── auto-placement.ts
```

**职责**：

- Canvas 状态管理
- **新增**：节点布局算法
- **新增**：Frame 创建和管理
- **新增**：边界检测和空间分配

---

#### 3. agent/ (扩展现有模块)

```
agent/
├── graph.ts                   # 现有：普通对话 graph
├── llm.ts                     # 现有：LLM 配置
├── state.ts                   # 现有：AgentState
└── tools/
    ├── index.ts               # 现有：工具注册
    ├── web_search.ts          # 现有：网络搜索
    └── canvas_operations.ts   # 新：Canvas 操作工具
```

**职责**：

- **新增**：canvas_operations 工具（供 LangGraph 使用）
- 复用现有的 web_search 工具

---

### 前端模块 (apps/web/src/)

#### 1. components/Messages/ (扩展)

```
Messages/
├── types.ts                   # 扩展：ResearchMessage 类型
├── MessageList.tsx            # 现有
├── AIMessage.tsx              # 现有
├── ToolMessage.tsx            # 现有
├── ResearchProgressCard.tsx   # 新：研究进度卡片
├── ResearchStepItem.tsx       # 新：单个步骤项
└── ResearchSummaryCard.tsx    # 新：完成后的摘要
```

**职责**：

- 显示研究进度
- 步骤列表和状态
- 链接到 Canvas 节点

---

#### 2. components/Panels/ChatPanel/ (扩展)

```
ChatPanel/
├── index.tsx                  # 现有：主面板
├── ChatInput.tsx              # 扩展：添加 Deep Research 按钮
└── hooks/
    ├── useChat.ts             # 现有：普通聊天
    └── useResearch.ts         # 新：研究模式
```

**职责**：

- **新增**：Deep Research 按钮
- **新增**：useResearch hook 处理研究流程

---

#### 3. store/ (扩展)

```
store/
├── canvasStore.ts             # 扩展：布局方法
└── researchStore.ts           # 新：研究状态管理
```

**职责**：

- **新增**：研究状态（进度、步骤、节点映射）
- **扩展**：Canvas 布局方法（智能放置）

---

#### 4. api/ (扩展)

```
api/
├── chat.ts                    # 现有：普通聊天 API
└── research.ts                # 新：研究模式 API
```

**职责**：

- **新增**：`streamResearch()` 方法
- SSE 事件解析

---

#### 5. utils/ (新增)

```
utils/
└── research/
    ├── layoutHelper.ts        # 前端布局辅助
    ├── researchEventParser.ts # SSE 事件解析
    └── canvasHelper.ts        # Canvas 操作辅助
```

---

### 共享类型 (packages/shared/)

```
shared/src/types/
├── chat.ts                    # 现有
├── research.ts                # 新：研究相关类型
└── canvas.ts                  # 新：Canvas 操作类型
```

---

## 🔄 数据流设计

### Flow 1: 触发研究

```
用户点击 "Deep Research"
  ↓
ChatInput.handleDeepResearch()
  ↓
useResearch.startResearch(query, canvasId, canvasVersion)
  ↓
api.research.streamResearch({
  query,
  canvasId,
  canvasVersion,
  selectedSourceIds,
  config
})
  ↓
POST /chat/research (SSE)
  ↓
research.service.executeResearch()
  ↓
ResearchGraph.stream(initialState)
```

---

### Flow 2: 执行研究（后端）

```
[QueryAnalysisNode]
  分析问题 → 生成子查询
  ↓ emit: { type: 'thinking', data: { step, content } }

[MultiSearchNode]
  for each 子查询:
    调用 web_search tool
    ↓ emit: { type: 'searching', data: { query, results } }

    调用 canvas_operations.createNode()
    ↓ emit: { type: 'node_created', data: { nodeId, type, position } }

[IngestionNode]
  for each 搜索结果:
    调用 ingest_service.ingestNode()
    ↓ emit: { type: 'ingesting', data: { nodeId, sourceId, status } }

[SynthesisNode]
  LLM 综合分析
  创建 Note 节点（洞察）
  ↓ emit: { type: 'synthesis', data: { content, nodeId } }

[CanvasOrganizationNode]
  创建 Frame 包裹所有节点
  计算布局
  创建 Edges
  ↓ emit: { type: 'complete', data: { frameId, canvasVersion, nodeCount } }
```

---

### Flow 3: 前端更新

```
SSE Event: { type: 'thinking', ... }
  ↓
researchStore.addStep(step)
  ↓
ResearchProgressCard 重新渲染

SSE Event: { type: 'node_created', ... }
  ↓
canvasStore.addNode(node)
  ↓
Canvas 动画显示新节点

SSE Event: { type: 'complete', ... }
  ↓
researchStore.markComplete()
  ↓
显示 ResearchSummaryCard
```

---

## 🔌 接口定义

### 1. API 接口

#### POST /chat/research

```typescript
// Request
interface ResearchRequest {
  query: string;
  canvasId: string;
  canvasVersion: number;
  selectedSourceIds?: string[];
  config?: ResearchConfig;
}

interface ResearchConfig {
  maxSources?: number; // 默认 5
  searchDepth?: 'basic' | 'advanced'; // 默认 'advanced'
  placement?: PlacementStrategy; // 默认 'auto'
  groupWithFrame?: boolean; // 默认 true
  autoConnect?: boolean; // 默认 false
}

// Response (SSE)
type ResearchEvent =
  | ThinkingEvent
  | SearchingEvent
  | NodeCreatedEvent
  | IngestingEvent
  | SynthesisEvent
  | CompleteEvent
  | ErrorEvent;

interface ThinkingEvent {
  type: 'thinking';
  data: {
    step: string;
    content: string;
    nodeId?: string;
    timestamp: number;
  };
}

interface SearchingEvent {
  type: 'searching';
  data: {
    query: string;
    resultCount: number;
    timestamp: number;
  };
}

interface NodeCreatedEvent {
  type: 'node_created';
  data: {
    nodeId: string;
    nodeType: 'text' | 'web' | 'note' | 'frame';
    position: { x: number; y: number };
    data: Record<string, unknown>;
    timestamp: number;
  };
}

interface IngestingEvent {
  type: 'ingesting';
  data: {
    nodeId: string;
    sourceId: string;
    status: 'pending' | 'done' | 'error';
    timestamp: number;
  };
}

interface SynthesisEvent {
  type: 'synthesis';
  data: {
    content: string;
    nodeId: string;
    relatedNodeIds: string[];
    timestamp: number;
  };
}

interface CompleteEvent {
  type: 'complete';
  data: {
    frameId: string;
    canvasVersion: number;
    nodeCount: number;
    duration: number;
    timestamp: number;
  };
}

interface ErrorEvent {
  type: 'error';
  data: {
    message: string;
    step?: string;
    recoverable: boolean;
    timestamp: number;
  };
}
```

---

### 2. LangGraph State

```typescript
// apps/server/src/modules/research/graphs/research.state.ts

import { Annotation } from '@langchain/langgraph';
import type { BaseMessage } from '@langchain/core/messages';

export const ResearchState = Annotation.Root({
  // 输入
  query: Annotation<string>({
    reducer: (x, y) => y ?? x,
  }),

  canvasId: Annotation<string>({
    reducer: (x, y) => y ?? x,
  }),

  canvasVersion: Annotation<number>({
    reducer: (x, y) => y ?? x,
  }),

  config: Annotation<ResearchConfig>({
    reducer: (x, y) => ({ ...x, ...y }),
  }),

  // 工作状态
  subQueries: Annotation<string[]>({
    reducer: (x, y) => y ?? x,
  }),

  searchResults: Annotation<SearchResult[]>({
    reducer: (x, y) => x.concat(y),
  }),

  createdNodeIds: Annotation<string[]>({
    reducer: (x, y) => x.concat(y),
  }),

  synthesisNodeIds: Annotation<string[]>({
    reducer: (x, y) => x.concat(y),
  }),

  // 输出
  frameId: Annotation<string | null>({
    reducer: (x, y) => y ?? x,
  }),

  finalCanvasVersion: Annotation<number | null>({
    reducer: (x, y) => y ?? x,
  }),

  errors: Annotation<string[]>({
    reducer: (x, y) => x.concat(y),
  }),
});

interface SearchResult {
  query: string;
  nodeId: string;
  sourceId: string;
  url: string;
  title: string;
}
```

---

### 3. Canvas 操作接口

```typescript
// apps/server/src/modules/canvas/canvas.operation.ts

export interface CanvasOperationService {
  /**
   * 创建节点（添加到 Canvas）
   */
  createNode(params: {
    canvasId: string;
    type: 'text' | 'web' | 'note' | 'frame';
    position: { x: number; y: number };
    data: Record<string, unknown>;
    metadata?: NodeMetadata;
  }): Promise<{ nodeId: string }>;

  /**
   * 创建 Frame
   */
  createFrame(params: {
    canvasId: string;
    label: string;
    position: { x: number; y: number };
    childNodeIds: string[];
    metadata?: FrameMetadata;
  }): Promise<{ frameId: string }>;

  /**
   * 创建 Edge
   */
  createEdge(params: {
    canvasId: string;
    sourceNodeId: string;
    targetNodeId: string;
    label?: string;
    style?: EdgeStyle;
  }): Promise<{ edgeId: string }>;

  /**
   * 计算布局（给定节点列表，返回位置）
   */
  calculateLayout(params: {
    canvasId: string;
    strategy: PlacementStrategy;
    newNodeCount: number;
  }): Promise<{ startPosition: Point; positions: Point[] }>;

  /**
   * 批量更新 Canvas 状态
   */
  updateCanvasState(params: {
    canvasId: string;
    version: number;
    nodes: Node[];
    edges: Edge[];
  }): Promise<{ newVersion: number }>;
}

interface NodeMetadata {
  researchGenerated?: boolean;
  researchSessionId?: string;
  createdAt?: string;
  relatedNodeIds?: string[];
}
```

---

### 4. 前端 Hook

```typescript
// apps/web/src/components/Panels/ChatPanel/hooks/useResearch.ts

export interface UseResearchReturn {
  // 状态
  isResearching: boolean;
  progress: number;
  steps: ResearchStep[];
  error: string | null;

  // 方法
  startResearch: (query: string, config?: ResearchConfig) => Promise<void>;
  cancelResearch: () => void;

  // 控制
  pauseResearch: () => void;
  resumeResearch: () => void;
}

export interface ResearchStep {
  id: string;
  type: 'thinking' | 'searching' | 'ingesting' | 'synthesizing';
  title: string;
  status: 'pending' | 'running' | 'done' | 'error';
  detail?: string;
  nodeIds?: string[];
  timestamp: number;
}

export const useResearch = (): UseResearchReturn => {
  // 实现...
};
```

---

## 🛠️ 实现步骤

### Phase 1: 基础架构（3-4 天）

#### Day 1: 类型定义和工具

- [ ] **共享类型**：创建 `packages/shared/src/types/research.ts`
  - ResearchRequest, ResearchEvent, ResearchConfig
- [ ] **Canvas 类型**：创建 `packages/shared/src/types/canvas.ts`

  - NodeMetadata, PlacementStrategy

- [ ] **后端工具**：创建 `apps/server/src/modules/agent/tools/canvas_operations.ts`
  - createNodeTool
  - createFrameTool

#### Day 2: Canvas 布局服务

- [ ] **布局算法**：创建 `apps/server/src/modules/canvas/layout/`

  - `bounds.calculator.ts` - calculateCanvasBounds()
  - `strategies/right-placement.ts` - placeResearchRight()
  - `strategies/bottom-placement.ts` - placeResearchBottom()
  - `strategies/auto-placement.ts` - autoSelectPlacementStrategy()

- [ ] **Canvas 操作服务**：创建 `apps/server/src/modules/canvas/canvas.operation.ts`
  - CanvasOperationService 实现

#### Day 3-4: ResearchGraph

- [ ] **State 定义**：创建 `apps/server/src/modules/research/graphs/research.state.ts`
- [ ] **节点实现**：创建 `apps/server/src/modules/research/graphs/nodes/`

  - `query-analysis.node.ts`
  - `multi-search.node.ts`
  - `ingestion.node.ts`
  - `synthesis.node.ts`
  - `canvas-organization.node.ts`

- [ ] **Graph 构建**：创建 `apps/server/src/modules/research/graphs/research.graph.ts`
  - 连接所有节点
  - 定义条件边

---

### Phase 2: 后端服务和路由（2-3 天）

#### Day 5: 研究服务

- [ ] **服务层**：创建 `apps/server/src/modules/research/research.service.ts`

  - executeResearch()
  - 协调 graph 和 canvas 操作
  - SSE 事件发送

- [ ] **类型定义**：创建 `apps/server/src/modules/research/research.types.ts`

#### Day 6: API 路由

- [ ] **路由**：创建 `apps/server/src/modules/research/research.route.ts`

  - POST /chat/research
  - SSE 响应处理
  - 错误处理

- [ ] **注册路由**：在 `apps/server/src/app.ts` 中注册

---

### Phase 3: 前端基础（2-3 天）

#### Day 7: API 客户端

- [ ] **API 封装**：创建 `apps/web/src/api/research.ts`
  - streamResearch()
  - 取消请求

#### Day 8: 状态管理

- [ ] **Store**：创建 `apps/web/src/store/researchStore.ts`

  - 研究状态管理
  - 步骤追踪

- [ ] **扩展 canvasStore**：添加布局方法
  - handleResearchNodeCreated()
  - calculateSmartPlacement()

#### Day 9: Hook

- [ ] **useResearch Hook**：创建 `apps/web/src/components/Panels/ChatPanel/hooks/useResearch.ts`
  - startResearch()
  - 事件监听和状态更新

---

### Phase 4: 前端 UI（3-4 天）

#### Day 10: 进度卡片

- [ ] **ResearchProgressCard**：创建 `apps/web/src/components/Messages/ResearchProgressCard.tsx`

  - 进度条
  - 步骤列表
  - 控制按钮

- [ ] **ResearchStepItem**：创建 `apps/web/src/components/Messages/ResearchStepItem.tsx`
  - 状态图标
  - 跳转到节点按钮

#### Day 11: ChatInput 扩展

- [ ] **添加按钮**：修改 `apps/web/src/components/Panels/ChatPanel/ChatInput.tsx`
  - 取消注释 Deep Research 按钮
  - 绑定 useResearch.startResearch

#### Day 12: Canvas 节点样式

- [ ] **节点包装器**：修改 `apps/web/src/components/Nodes/NodeWrapper.tsx`
  - 检测 researchGenerated 标记
  - 添加紫色边框样式
  - 添加 "AI 研究" 标签

#### Day 13: 摘要卡片

- [ ] **ResearchSummaryCard**：创建 `apps/web/src/components/Messages/ResearchSummaryCard.tsx`
  - 研究完成摘要
  - 跳转到 Canvas 按钮

---

### Phase 5: 测试和优化（2-3 天）

#### Day 14: 集成测试

- [ ] 端到端流程测试
- [ ] 边界情况测试（空 Canvas、密集 Canvas）
- [ ] 错误处理测试

#### Day 15: 性能优化

- [ ] 布局算法优化
- [ ] SSE 事件去重
- [ ] Canvas 渲染优化

#### Day 16: 用户测试和修复

- [ ] 内部测试
- [ ] Bug 修复
- [ ] 文档更新

---

## 📂 目录结构总览

```
Sediment/
├── apps/
│   ├── server/
│   │   └── src/
│   │       └── modules/
│   │           ├── research/              # 新模块
│   │           │   ├── research.route.ts
│   │           │   ├── research.service.ts
│   │           │   ├── research.types.ts
│   │           │   └── graphs/
│   │           │       ├── research.graph.ts
│   │           │       ├── research.state.ts
│   │           │       └── nodes/
│   │           │           ├── query-analysis.node.ts
│   │           │           ├── multi-search.node.ts
│   │           │           ├── ingestion.node.ts
│   │           │           ├── synthesis.node.ts
│   │           │           └── canvas-organization.node.ts
│   │           │
│   │           ├── canvas/                # 扩展
│   │           │   ├── canvas.operation.ts      # 新
│   │           │   └── layout/                  # 新
│   │           │       ├── layout.service.ts
│   │           │       ├── bounds.calculator.ts
│   │           │       └── strategies/
│   │           │           ├── right-placement.ts
│   │           │           ├── bottom-placement.ts
│   │           │           └── auto-placement.ts
│   │           │
│   │           └── agent/                 # 扩展
│   │               └── tools/
│   │                   └── canvas_operations.ts  # 新
│   │
│   └── web/
│       └── src/
│           ├── api/
│           │   └── research.ts            # 新
│           │
│           ├── store/
│           │   ├── canvasStore.ts         # 扩展
│           │   └── researchStore.ts       # 新
│           │
│           ├── components/
│           │   ├── Messages/
│           │   │   ├── types.ts           # 扩展
│           │   │   ├── ResearchProgressCard.tsx    # 新
│           │   │   ├── ResearchStepItem.tsx        # 新
│           │   │   └── ResearchSummaryCard.tsx     # 新
│           │   │
│           │   ├── Panels/
│           │   │   └── ChatPanel/
│           │   │       ├── ChatInput.tsx  # 扩展
│           │   │       └── hooks/
│           │   │           └── useResearch.ts      # 新
│           │   │
│           │   └── Nodes/
│           │       └── NodeWrapper.tsx    # 扩展
│           │
│           └── utils/
│               └── research/              # 新
│                   ├── layoutHelper.ts
│                   ├── researchEventParser.ts
│                   └── canvasHelper.ts
│
└── packages/
    └── shared/
        └── src/
            └── types/
                ├── research.ts            # 新
                └── canvas.ts              # 新
```

---

## 🎯 关键设计决策

### 1. 为什么独立的 research 模块？

**优点**：

- ✅ 关注点分离：研究逻辑与普通对话隔离
- ✅ 易于测试：独立的 graph 可以单独测试
- ✅ 易于扩展：未来可以添加不同类型的研究模式

**替代方案**：

- ❌ 在现有 chat 模块中扩展（会变得臃肿）
- ❌ 直接在 agent graph 中添加节点（混合逻辑）

---

### 2. 为什么需要 CanvasOperationService？

**优点**：

- ✅ 统一接口：LangGraph 节点通过统一接口操作 Canvas
- ✅ 事务性：批量操作可以在一个事务中完成
- ✅ 布局逻辑封装：复杂的布局算法与业务逻辑分离

**职责边界**：

```
ResearchGraph  →  CanvasOperationService  →  Canvas DB
   (what?)           (how?)                   (store)
```

---

### 3. 为什么前端需要 researchStore？

**优点**：

- ✅ 状态持久化：刷新页面不丢失进度
- ✅ 跨组件共享：ChatPanel 和 Canvas 都能访问
- ✅ 历史记录：可以查看过去的研究

**替代方案**：

- ❌ 仅在 ChatPanel 内部管理（无法持久化）
- ❌ 直接存在 canvasStore（混合关注点）

---

### 4. SSE vs WebSocket？

**选择 SSE 的原因**：

- ✅ 单向流：研究是单向的流程（后端 → 前端）
- ✅ 简单：HTTP 协议，易于调试
- ✅ 自动重连：浏览器原生支持
- ✅ 一致性：与现有 chat SSE 保持一致

---

## 🔧 开发工具和命令

### 启动开发服务器

```bash
# 后端
cd apps/server
pnpm dev

# 前端
cd apps/web
pnpm dev
```

### 测试

```bash
# 运行所有测试
pnpm test

# 测试特定模块
pnpm test research

# 监听模式
pnpm test:watch
```

### 类型检查

```bash
# 全局类型检查
pnpm typecheck

# 特定包
pnpm typecheck --filter @sediment/server
```

### Lint 和格式化

```bash
# Lint
pnpm lint

# 修复
pnpm lint:fix

# 格式化
pnpm format
```

---

## 📝 开发检查清单

### 新增文件时

- [ ] 添加适当的 TypeScript 类型
- [ ] 添加 JSDoc 注释
- [ ] 导出公共接口
- [ ] 在 index.ts 中重新导出（如果是模块入口）

### 修改现有文件时

- [ ] 保持向后兼容（或提供迁移路径）
- [ ] 更新相关测试
- [ ] 更新 TypeScript 类型
- [ ] 检查是否影响其他模块

### 提交前

- [ ] pnpm typecheck 通过
- [ ] pnpm lint 通过
- [ ] pnpm test 通过
- [ ] 手动测试关键流程
- [ ] 更新相关文档

---

## 🚀 MVP 最小可行版本

**如果时间紧张，首先实现：**

### 必须（Week 1）

1. ✅ POST /chat/research 路由（简化版）
2. ✅ 简单的 QueryAnalysis + MultiSearch 节点
3. ✅ Canvas 右侧布局策略
4. ✅ 基础 ResearchProgressCard
5. ✅ Deep Research 按钮

### 可选（Week 2+）

- ⏸️ 完整的 Synthesis 节点
- ⏸️ Frame 创建
- ⏸️ 智能布局选择
- ⏸️ 自动关联
- ⏸️ 暂停/继续控制

---

## 📚 参考资料

- [LangGraph 文档](https://langchain-ai.github.io/langgraph/)
- [ReactFlow 文档](https://reactflow.dev/)
- [SSE 规范](https://html.spec.whatwg.org/multipage/server-sent-events.html)
- [Zustand 文档](https://zustand.docs.pmnd.rs/)

---

**最后更新**: 2026-02-24  
**预计工期**: 12-16 天（约 2-3 周）  
**预计代码量**: ~3000-4000 行（不含测试）
