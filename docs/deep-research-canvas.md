# Deep Research Canvas - 实现方案

## 概述

允许用户发起深度研究请求，AI 自动搜索、分析文献，并将思考过程和结果组织成 Canvas 节点，提升透明度和可操作性。

---

## 1. 架构设计

### 1.1 工作流（LangGraph）

```
深度研究 Graph (research.ts)
├─ 1. Query Analysis Node
│   └─ 分析研究问题，拆解为子查询
│   └─ 输出：Canvas Text Node（思考过程）
│
├─ 2. Multi-Search Node
│   └─ 对每个子查询调用 web_search tool
│   └─ 输出：每个搜索结果 → Canvas Web Node
│
├─ 3. Content Ingestion Node
│   └─ 触发 knowledge ingestion（自动调用现有 ingest API）
│   └─ 关联 nodeId ↔ sourceId
│
├─ 4. Synthesis Node
│   └─ LLM 综合分析所有搜索结果
│   └─ 输出：Canvas Note Node（洞察总结）
│
└─ 5. Canvas Organization Node
    └─ 创建 Frame 节点分组相关内容
    └─ 创建 Edges 表示节点关系
    └─ 自动布局节点位置
```

### 1.2 State 定义

```typescript
// apps/server/src/modules/agent/state.ts 扩展
export interface ResearchState extends AgentState {
  researchQuery: string;
  subQueries: string[];
  searchResults: Array<{
    query: string;
    nodeId: string;
    sourceId: string;
    results: WebSearchResult[];
  }>;
  synthesisNodes: Array<{
    nodeId: string;
    content: string;
    relatedSources: string[];
  }>;
  canvasUpdate: {
    canvasId: string;
    version: number;
    newNodes: CanvasNode[];
    newEdges: Edge[];
  };
}
```

---

## 2. 新增工具（Tools）

### 2.1 Canvas 操作工具

```typescript
// apps/server/src/modules/agent/tools/canvas_operations.ts

export const createCanvasNodeTool = tool(
  async ({ canvasId, type, data, position }) => {
    // 1. 生成 nodeId
    const nodeId = generateNodeId();

    // 2. 根据类型创建节点
    const node = {
      id: nodeId,
      type,
      position,
      data,
    };

    // 3. 调用内部服务添加节点到 canvas
    await canvasService.addNode(canvasId, node);

    // 4. 如果是 web/pdf 类型，触发 ingestion
    if (type === 'web' || type === 'pdf') {
      await ingestService.ingestNode({
        canvasId,
        nodeId,
        type,
        ...data,
      });
    }

    return { nodeId, success: true };
  },
  {
    name: 'create_canvas_node',
    description: 'Create a new node on the canvas to show research findings',
    schema: z.object({
      canvasId: z.string(),
      type: z.enum(['note', 'text', 'web', 'frame']),
      data: z.object({
        content: z.string().optional(),
        src: z.string().optional(),
        label: z.string().optional(),
      }),
      position: z.object({ x: z.number(), y: z.number() }),
    }),
  },
);

export const createCanvasFrameTool = tool(
  async ({ canvasId, label, nodeIds, position }) => {
    // 创建 frame 节点包裹一组相关节点
    const frameId = generateNodeId();

    // 计算 frame 的尺寸和位置
    const bounds = calculateBounds(nodeIds);

    const frame = {
      id: frameId,
      type: 'frame',
      position,
      data: { label },
      style: { width: bounds.width, height: bounds.height },
    };

    await canvasService.addNode(canvasId, frame);

    return { frameId, success: true };
  },
  {
    name: 'create_canvas_frame',
    description: 'Create a frame to group related nodes',
    schema: z.object({
      canvasId: z.string(),
      label: z.string(),
      nodeIds: z.array(z.string()),
      position: z.object({ x: z.number(), y: z.number() }),
    }),
  },
);
```

---

## 3. API 接口

### 3.1 研究模式端点

```typescript
// apps/server/src/modules/chat/chat.route.ts 扩展

/**
 * POST /chat/research
 *
 * 启动深度研究模式（SSE 流式返回）
 */
fastify.post<{
  Body: {
    query: string;
    canvasId: string;
    canvasVersion: number;
    options?: {
      maxSources?: number; // 默认 5
      searchDepth?: 'basic' | 'advanced'; // 默认 'advanced'
      autoLayout?: boolean; // 默认 true
    };
  };
}>('/chat/research', async (request, reply) => {
  const { query, canvasId, canvasVersion, options } = request.body;

  // 1. 验证 canvas 版本
  const canvas = await canvasService.getCanvas(canvasId);
  if (canvas.version !== canvasVersion) {
    return reply.code(409).send({
      error: 'Version mismatch',
      serverVersion: canvas.version,
    });
  }

  // 2. 设置 SSE
  reply.raw.setHeader('Content-Type', 'text/event-stream');
  reply.raw.setHeader('Cache-Control', 'no-cache');
  reply.raw.setHeader('Connection', 'keep-alive');

  // 3. 调用研究 graph
  const researchGraph = createResearchGraph();

  const stream = await researchGraph.stream({
    researchQuery: query,
    canvasId,
    canvasVersion,
    options,
  });

  // 4. 流式输出进度
  for await (const chunk of stream) {
    const event = formatResearchEvent(chunk);
    reply.raw.write(`event: ${event.type}\n`);
    reply.raw.write(`data: ${JSON.stringify(event.data)}\n\n`);
  }

  reply.raw.end();
});
```

### 3.2 SSE 事件格式

```typescript
// 事件类型
type ResearchEvent =
  | {
      type: 'thinking';
      data: { step: string; content: string; nodeId?: string };
    }
  | { type: 'searching'; data: { query: string; results: number } }
  | {
      type: 'node_created';
      data: { nodeId: string; type: string; position: Point };
    }
  | { type: 'synthesis'; data: { content: string; nodeId: string } }
  | { type: 'complete'; data: { canvasVersion: number; totalNodes: number } }
  | { type: 'error'; data: { message: string } };
```

---

## 4. 前端集成

### 4.1 触发入口

```typescript
// apps/web/src/components/Layout/CenterArea.tsx

// 在聊天输入框旁边添加"深度研究"按钮
<Button
  onClick={() => startResearch(inputValue)}
  disabled={!inputValue.trim()}
  variant="outline"
>
  <Search className="mr-2 h-4 w-4" />
  深度研究
</Button>
```

### 4.2 研究进度展示

```typescript
// apps/web/src/components/Messages/ResearchMessage.tsx

export const ResearchMessage = ({ steps }: { steps: ResearchStep[] }) => {
  return (
    <div className="bg-card rounded-lg border p-4">
      <div className="mb-2 flex items-center gap-2">
        <Sparkles className="h-5 w-5" />
        <h3 className="font-semibold">深度研究中...</h3>
      </div>

      <div className="space-y-2">
        {steps.map((step, i) => (
          <div key={i} className="flex items-start gap-2">
            {step.status === 'done' && (
              <Check className="h-4 w-4 text-green-500" />
            )}
            {step.status === 'running' && (
              <Loader className="h-4 w-4 animate-spin" />
            )}
            {step.status === 'pending' && (
              <Circle className="text-muted h-4 w-4" />
            )}

            <div className="flex-1">
              <div className="text-sm font-medium">{step.title}</div>
              {step.content && (
                <div className="text-muted-foreground text-xs">
                  {step.content}
                </div>
              )}
              {step.nodeId && (
                <button
                  onClick={() => focusCanvasNode(step.nodeId)}
                  className="text-primary text-xs hover:underline"
                >
                  查看节点 →
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
```

### 4.3 Canvas 自动更新

```typescript
// apps/web/src/store/canvasStore.ts 扩展

export const useCanvasStore = create<CanvasStore>((set, get) => ({
  // ...现有代码

  // 处理研究模式的节点增量添加
  handleResearchNodeCreated: (nodeData: {
    nodeId: string;
    type: string;
    data: any;
    position: Point;
  }) => {
    const { nodes, edges } = get();

    // 添加节点（带动画效果）
    const newNode: CanvasNode = {
      id: nodeData.nodeId,
      type: nodeData.type,
      data: nodeData.data,
      position: nodeData.position,
      // 标记为研究生成，应用特殊样式
      className: 'research-generated animate-fade-in',
    };

    set({ nodes: [...nodes, newNode] });

    // 可选：自动聚焦到新节点
    if (get().autoFocusNewNodes) {
      setTimeout(() => {
        reactFlowInstance?.fitView({
          nodes: [newNode],
          duration: 300,
          padding: 0.5,
        });
      }, 100);
    }
  },
}));
```

---

## 5. 节点组织策略

### 5.1 自动布局算法

```typescript
// apps/server/src/modules/canvas/layout.service.ts

export interface LayoutStrategy {
  type: 'hierarchical' | 'radial' | 'force-directed';
  spacing: { x: number; y: number };
}

export const autoLayoutResearchNodes = (
  nodes: CanvasNode[],
  strategy: LayoutStrategy = {
    type: 'hierarchical',
    spacing: { x: 300, y: 200 },
  },
): CanvasNode[] => {
  switch (strategy.type) {
    case 'hierarchical':
      // 层级布局：思考节点在上，源节点在中，总结在下
      return layoutHierarchical(nodes, strategy.spacing);

    case 'radial':
      // 辐射状布局：主题在中心，相关源围绕
      return layoutRadial(nodes);

    case 'force-directed':
      // 力导向布局：根据节点关联自动分布
      return layoutForceDirected(nodes);
  }
};

const layoutHierarchical = (
  nodes: CanvasNode[],
  spacing: { x: number; y: number },
): CanvasNode[] => {
  const layers = {
    thinking: nodes.filter((n) => n.type === 'text'),
    sources: nodes.filter((n) => n.type === 'web'),
    synthesis: nodes.filter((n) => n.type === 'note'),
  };

  let positioned: CanvasNode[] = [];
  let currentY = 0;

  // 第一层：思考过程
  layers.thinking.forEach((node, i) => {
    positioned.push({
      ...node,
      position: { x: i * spacing.x, y: currentY },
    });
  });
  currentY += spacing.y;

  // 第二层：搜索来源（可能多行）
  const sourcesPerRow = 3;
  layers.sources.forEach((node, i) => {
    const row = Math.floor(i / sourcesPerRow);
    const col = i % sourcesPerRow;
    positioned.push({
      ...node,
      position: { x: col * spacing.x, y: currentY + row * spacing.y },
    });
  });
  currentY += Math.ceil(layers.sources.length / sourcesPerRow) * spacing.y;

  // 第三层：综合总结
  layers.synthesis.forEach((node, i) => {
    positioned.push({
      ...node,
      position: { x: i * spacing.x, y: currentY },
    });
  });

  return positioned;
};
```

### 5.2 节点关系建立

```typescript
// 自动创建 edges 表示节点关系
export const createResearchEdges = (
  nodes: CanvasNode[],
  relationships: Array<{ source: string; target: string; type: string }>,
): Edge[] => {
  return relationships.map((rel) => ({
    id: `e-${rel.source}-${rel.target}`,
    source: rel.source,
    target: rel.target,
    type: 'smoothstep',
    animated: rel.type === 'derives-from',
    style: {
      stroke: rel.type === 'derives-from' ? '#8b5cf6' : '#94a3b8',
    },
    label: rel.type === 'derives-from' ? '基于' : '参考',
  }));
};
```

---

## 6. 用户体验优化

### 6.1 进度可视化

- 在 Chat 区域显示研究步骤
- 每个步骤完成后可跳转到对应 Canvas 节点
- 支持中途取消研究

### 6.2 Canvas 交互

- 研究生成的节点带特殊标记（不同边框颜色）
- 支持一键重新布局
- 支持展开/折叠研究框架

### 6.3 错误处理

- 搜索失败 → 创建 text 节点说明原因
- 内容提取失败 → 仅保留标题和 URL
- LLM 调用失败 → 提供重试选项

---

## 7. 实现优先级

### Phase 1 - MVP（2周）

- [ ] 创建研究 graph 基础结构
- [ ] 实现 create_canvas_node 工具
- [ ] 简单的线性布局（上下排列）
- [ ] 前端 SSE 接收和节点增量添加
- [ ] 基础错误处理

### Phase 2 - 增强（1周）

- [ ] 智能节点布局算法
- [ ] Frame 分组功能
- [ ] 节点间关系（edges）
- [ ] 进度可视化优化
- [ ] 支持取消/暂停

### Phase 3 - 高级（1周）

- [ ] 向量检索集成（相似研究推荐）
- [ ] 导出研究报告
- [ ] 研究历史记录
- [ ] 自定义研究策略

---

## 8. 成本和限制考虑

### 8.1 API 调用成本

- 单次研究可能涉及：
  - 1次查询分析（LLM）
  - 3-5次网络搜索（Tavily）
  - 1-3次内容综合（LLM）
  - 总成本：约 $0.05 - 0.15 USD

### 8.2 Rate Limiting

```typescript
// 建议添加限流
const RESEARCH_RATE_LIMIT = {
  maxConcurrent: 2, // 同时最多2个研究任务
  maxPerUser: 10, // 用户每天最多10次
};
```

### 8.3 Canvas 节点数限制

- 建议单次研究生成不超过 20 个节点
- 超过阈值时使用分页或折叠

---

## 9. 参考实现

类似现有项目：

- **Perplexity Pro Research**: 多轮搜索 + 综合报告
- **Claude Artifacts**: 对话生成可编辑内容
- **Elicit**: 学术文献研究自动化
- **Open Notebook**: 多模态内容研究（但输出为笔记而非 Canvas）

本方案的独特之处：
✅ 将思考过程可视化为 Canvas  
✅ 保留完整操作性（用户可编辑/重组节点）  
✅ 与现有 Canvas 工作流无缝集成

---

## 10. 下一步行动

1. **原型验证**：手动创建一个"研究结果 Canvas"，验证节点组织逻辑
2. **Graph 开发**：先实现简化版 research graph（硬编码2个搜索）
3. **前端集成**：添加"深度研究"按钮和进度显示
4. **迭代优化**：根据使用反馈优化布局和交互

---

**最后更新**: 2026-02-24
