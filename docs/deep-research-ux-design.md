# Deep Research - 用户体验设计

> 基于现有 Sediment UI 组件和交互模式设计

---

## 🎯 设计原则

1. **渐进式披露**：不一次性展示所有信息，按执行进度逐步展示
2. **可控性**：用户可以随时暂停、取消、调整
3. **透明度**：清晰展示 AI 的思考和决策过程
4. **可操作性**：研究结果直接可编辑、可重组
5. **一致性**：复用现有交互模式（Chat SSE 流式、Canvas 节点操作）

---

## 📱 交互流程设计

### 流程 A：触发研究

#### 模式 1：快速研究（推荐 ⭐）

```
用户在 ChatInput 输入问题
  ↓
点击 "Deep Research" 按钮（而非 Send）
  ↓
系统识别：这是研究模式，不是普通对话
  ↓
Chat 面板显示研究进度卡片
Canvas 自动开始添加节点
```

**优点**：

- 单次交互即可触发
- 明确的模式切换
- 不打断正常对话流程

## 🎨 UI 组件设计

### 1. ChatInput 增强（已有注释代码）

```tsx
// apps/web/src/components/Panels/ChatPanel/ChatInput.tsx

<div className="mt-2 flex items-center justify-between gap-3">
  <div className="flex items-center gap-2">
    {/* 模式切换按钮 */}
    <PillButton
      disabled={disabled || !value.trim()}
      onClick={handleDeepResearch}
      title="AI 会搜索多个来源，将思考过程和结果添加到 Canvas"
    >
      <Search size={16} />
      Deep Research
    </PillButton>

    {/* 可选：普通思考模式 */}
    <PillButton
      disabled={disabled}
      onClick={handleThink}
      title="AI 详细思考但不搜索外部资源"
    >
      <Lightbulb size={16} />
      Think
    </PillButton>
  </div>

  {/* 普通发送按钮 */}
  <IconButton type="submit" ...>
    <ArrowUp size={16} />
  </IconButton>
</div>
```

**交互细节**：

- Deep Research 按钮仅在输入非空时激活
- Tooltip 清晰说明功能（悬停 300ms 后显示）
- 点击后按钮变为 Loading 状态

---

### 2. ResearchProgressCard（新组件）

```tsx
// apps/web/src/components/Messages/ResearchProgressCard.tsx

interface ResearchStep {
  id: string;
  type: 'thinking' | 'searching' | 'ingesting' | 'synthesizing';
  title: string;
  status: 'pending' | 'running' | 'done' | 'error';
  detail?: string;
  nodeIds?: string[]; // 关联的 Canvas 节点
  timestamp: number;
}

export const ResearchProgressCard = ({
  query,
  steps,
  onCancel,
  onViewCanvas,
}: {
  query: string;
  steps: ResearchStep[];
  onCancel: () => void;
  onViewCanvas: () => void;
}) => {
  const progress =
    steps.filter((s) => s.status === 'done').length / steps.length;

  return (
    <div className="rounded-2xl border border-blue-200 bg-blue-50 p-4">
      {/* 头部：问题 + 进度 */}
      <div className="mb-3 flex items-start justify-between">
        <div className="flex-1">
          <div className="mb-1 flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-blue-600" />
            <span className="text-sm font-semibold text-blue-900">
              正在进行深度研究
            </span>
          </div>
          <div className="line-clamp-2 text-xs text-blue-700">{query}</div>
        </div>

        {/* 操作按钮 */}
        <div className="flex items-center gap-1">
          <IconButton
            size="xs"
            variant="ghost"
            onClick={onViewCanvas}
            title="在 Canvas 中查看"
          >
            <Layout className="h-3 w-3" />
          </IconButton>
          <IconButton
            size="xs"
            variant="ghost"
            onClick={onCancel}
            title="取消研究"
          >
            <X className="h-3 w-3" />
          </IconButton>
        </div>
      </div>

      {/* 进度条 */}
      <div className="mb-3 h-1.5 w-full overflow-hidden rounded-full bg-blue-200">
        <div
          className="h-full bg-blue-600 transition-all duration-300"
          style={{ width: `${progress * 100}%` }}
        />
      </div>

      {/* 步骤列表（可折叠） */}
      <Collapsible>
        <CollapsibleTrigger className="text-xs text-blue-600 hover:underline">
          {isExpanded ? '隐藏详情' : '显示详情'}
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="mt-2 space-y-2">
            {steps.map((step) => (
              <ResearchStepItem key={step.id} step={step} />
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
};
```

**视觉状态**：

```
┌─────────────────────────────────────────────────┐
│ ✨ 正在进行深度研究              [Canvas] [X]    │
│ 分析当前人工智能技术的发展趋势...              │
│ ▓▓▓▓▓▓░░░░░░ 60%                               │
│                                                 │
│ ▼ 显示详情                                      │
│   ✓ 分析查询意图 (2s)                  [查看节点]│
│   ⟳ 搜索相关论文... (5 results)       [查看节点]│
│   ○ 提取内容                                    │
│   ○ 综合分析                                    │
└─────────────────────────────────────────────────┘
```

**交互细节**：

- 默认折叠详情（避免占用过多空间）
- 每个步骤旁边可点击"查看节点"（聚焦到 Canvas 对应节点）
- 完成后卡片自动淡出或变为摘要卡片

---

### 3. ResearchStepItem（步骤项）

```tsx
const ResearchStepItem = ({ step }: { step: ResearchStep }) => {
  const icon = {
    pending: <Circle className="h-3 w-3 text-gray-400" />,
    running: <Loader2 className="h-3 w-3 animate-spin text-blue-600" />,
    done: <CheckCircle2 className="h-3 w-3 text-green-600" />,
    error: <AlertCircle className="h-3 w-3 text-red-600" />,
  }[step.status];

  return (
    <div className="flex items-start gap-2 text-xs">
      <div className="mt-0.5">{icon}</div>

      <div className="min-w-0 flex-1">
        <div className="font-medium text-gray-900">{step.title}</div>
        {step.detail && (
          <div className="mt-0.5 text-gray-600">{step.detail}</div>
        )}
      </div>

      {/* 如果有关联节点，显示跳转按钮 */}
      {step.nodeIds && step.nodeIds.length > 0 && (
        <button
          onClick={() => focusCanvasNodes(step.nodeIds)}
          className="whitespace-nowrap text-blue-600 hover:underline"
        >
          查看节点
        </button>
      )}
    </div>
  );
};
```

---

### 4. Canvas 节点视觉标识

**研究生成的节点应该有区分标识：**

```tsx
// 方案 A：顶部彩色标签
┌─────────────────────────────┐
│ 🔬 AI 研究生成        [...]  │ ← 紫色渐变背景
├─────────────────────────────┤
│                             │
│  节点内容...                │
│                             │
└─────────────────────────────┘

// 方案 B：左侧彩色边框（推荐 ⭐）
┃ ┌───────────────────────┐
┃ │ 节点标题        [...] │
┃ ├───────────────────────┤
┃ │                       │
┃ │  节点内容...          │
┃ │                       │
┃ └───────────────────────┘
↑ 4px 紫色边框
```

**实现**：

```tsx
// apps/web/src/components/Nodes/NodeWrapper.tsx

const isResearchGenerated = node.data.metadata?.researchGenerated === true;

<div
  className={clsx(
    'node-wrapper',
    isResearchGenerated && 'border-l-4 border-l-purple-500',
  )}
>
  {isResearchGenerated && (
    <div className="absolute -top-2 left-2 rounded-full bg-purple-100 px-2 py-0.5 text-[10px] text-purple-700">
      AI 研究
    </div>
  )}
  ...
</div>;
```

---

### 5. Canvas 自动布局动画

**节点添加时的视觉效果：**

```tsx
// 新节点淡入 + 从上方滑入
@keyframes slideInFromTop {
  from {
    opacity: 0;
    transform: translateY(-20px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.research-node-enter {
  animation: slideInFromTop 0.4s ease-out;
}
```

**聚焦效果**（点击"查看节点"时）：

```tsx
const focusCanvasNodes = (nodeIds: string[]) => {
  // 1. 高亮节点（临时边框动画）
  setHighlightedNodes(nodeIds);

  // 2. 平滑移动视口
  reactFlowInstance?.fitView({
    nodes: nodes.filter((n) => nodeIds.includes(n.id)),
    duration: 600,
    padding: 0.3,
  });

  // 3. 3秒后取消高亮
  setTimeout(() => setHighlightedNodes([]), 3000);
};
```

---

## 🔄 完整交互流程

### 场景：用户研究 "Web3 在供应链中的应用"

#### 1. 触发阶段（0-2s）

```
用户操作：
  1. 在 ChatInput 输入："分析 Web3 在供应链管理中的应用案例"
  2. 点击 "Deep Research" 按钮

系统响应：
  - Deep Research 按钮变为加载状态
  - Chat 面板立即添加用户消息卡片
  - 显示 ResearchProgressCard（初始状态：0% 进度）
```

---

#### 2. 思考阶段（2-5s）

```
SSE Event: { type: 'thinking', data: {...} }

Chat 更新：
  ResearchProgressCard 显示：
  ✓ 分析查询意图
    "识别到关键词：Web3, 供应链, 应用案例
     计划搜索：技术实现、实际案例、挑战分析"

Canvas 更新：
  添加 Text 节点（position: {x: 100, y: 100}）
  ┌─────────────────────────────┐
  │ 🧠 研究计划                  │
  ├─────────────────────────────┤
  │ 1. 搜索 Web3 供应链技术论文  │
  │ 2. 查找实际商业案例         │
  │ 3. 分析技术挑战与解决方案    │
  └─────────────────────────────┘
```

---

#### 3. 搜索阶段（5-15s）

```
SSE Event: { type: 'searching', data: { query: '...', results: 5 } }
SSE Event: { type: 'node_created', data: { nodeId: 'node-abc', ... } }

Chat 更新：
  ⟳ 搜索 "Web3 supply chain implementations"
    找到 5 个相关来源            [查看节点]

Canvas 更新：（依次添加）
  ┌─────────────────┐  ┌─────────────────┐
  │ 📄 IBM Food Trust│  │ 📄 Walmart 区块链│
  │                 │  │                 │
  │ [Web] ibm.com   │  │ [Web] walmart...│
  └─────────────────┘  └─────────────────┘

  ┌─────────────────┐
  │ 📄 Maersk TradeLens
  │
  │ [Web] maersk.com
  └─────────────────┘

  （自动布局：横向排列，间距 300px）
```

**视觉反馈**：

- 每个节点添加时带淡入动画
- Canvas 自动平移，保持新节点可见
- 节点左侧紫色边框标识

---

#### 4. 摄入阶段（15-25s）

```
SSE Event: { type: 'ingesting', data: { sourceId: '...', nodeId: '...' } }

Chat 更新：
  ⟳ 提取内容（3/5）
    正在处理：IBM Food Trust 文档...

Canvas 更新：
  已摄入的节点显示 ✓ 标记
  ┌─────────────────┐
  │ ✓ IBM Food Trust│ ← 左上角绿色勾
  │                 │
  │ [Web] ibm.com   │
  └─────────────────┘
```

---

#### 5. 综合阶段（25-35s）

```
SSE Event: { type: 'synthesis', data: { content: '...', nodeId: '...' } }

Chat 更新：
  ✓ 综合分析完成
    生成 2 个洞察节点            [查看节点]

Canvas 更新：
  在搜索节点下方添加 Note 节点

  ┌─────────────────────────────┐
  │ 💡 技术实现分析              │
  ├─────────────────────────────┤
  │ IBM Food Trust 和 Walmart... │
  │ 都采用联盟链架构，解决了...  │
  │                             │
  │ 关键技术：                   │
  │ - Hyperledger Fabric        │
  │ - 智能合约                   │
  └─────────────────────────────┘

  ┌─────────────────────────────┐
  │ 💡 挑战与解决方案            │
  ├─────────────────────────────┤
  │ 主要挑战：                   │
  │ 1. 数据隐私保护              │
  │ 2. 跨组织协作成本            │
  │ ...                         │
  └─────────────────────────────┘

  （自动创建 edges 连接来源节点 → 分析节点）
```

---

#### 6. 完成阶段（35s+）

```
SSE Event: { type: 'complete', data: { totalNodes: 8, canvasVersion: 42 } }

Chat 更新：
  ResearchProgressCard 变为摘要卡片：

  ┌─────────────────────────────────────────┐
  │ ✅ 研究完成                              │
  │ Web3 在供应链管理中的应用案例            │
  │                                          │
  │ 📊 已添加到 Canvas:                      │
  │   · 5 个来源节点                         │
  │   · 3 个分析节点                         │
  │   · 1 个研究框架                         │
  │                                          │
  │         [在 Canvas 中查看]               │
  └─────────────────────────────────────────┘

Canvas 更新：
  - 自动创建 Frame 节点包裹所有研究节点
  - Frame 标题："Web3 供应链研究 - 2026-02-24"
  - 执行 fitView 让整个研究框架可见
```

---

## 🎮 高级交互

### 1. 研究控制

**暂停/继续**：

```tsx
<PillButton onClick={handlePause}>
  {isPaused ? <Play size={14} /> : <Pause size={14} />}
  {isPaused ? '继续' : '暂停'}
</PillButton>
```

- 暂停时停止后续搜索，但完成当前步骤
- 继续时从断点恢复

**取消研究**：

```tsx
<IconButton onClick={handleCancel}>
  <X size={14} />
</IconButton>
```

- 弹出确认对话框："取消后已生成的节点将保留，是否继续？"
- 确认后停止执行，保留已生成内容

---

### 2. 调整研究参数（可选）

**在 Deep Research 按钮旁边添加设置图标：**

```tsx
<Popover>
  <PopoverTrigger>
    <IconButton size="xs" variant="ghost">
      <Settings size={12} />
    </IconButton>
  </PopoverTrigger>

  <PopoverContent>
    <div className="space-y-3">
      <div>
        <label>搜索深度</label>
        <Select value={depth} onChange={setDepth}>
          <option value="basic">基础 (3 来源)</option>
          <option value="standard">标准 (5 来源)</option>
          <option value="deep">深度 (8+ 来源)</option>
        </Select>
      </div>

      <div>
        <label>布局方式</label>
        <Select value={layout} onChange={setLayout}>
          <option value="hierarchical">层级（上下）</option>
          <option value="radial">辐射（中心）</option>
          <option value="force">力导向（自动）</option>
        </Select>
      </div>

      <div>
        <Checkbox checked={autoFocus} onChange={setAutoFocus}>
          自动聚焦新节点
        </Checkbox>
      </div>
    </div>
  </PopoverContent>
</Popover>
```

---

### 3. 研究历史

**在 Chat 面板头部添加下拉菜单：**

```tsx
<DropdownMenu>
  <DropdownMenuTrigger>
    <IconButton size="sm" variant="ghost">
      <History size={14} />
    </IconButton>
  </DropdownMenuTrigger>

  <DropdownMenuContent>
    <DropdownMenuLabel>最近的研究</DropdownMenuLabel>

    <DropdownMenuItem onClick={() => loadResearch('research-1')}>
      <Clock size={12} className="mr-2" />
      Web3 供应链应用 (今天 14:32)
    </DropdownMenuItem>

    <DropdownMenuItem onClick={() => loadResearch('research-2')}>
      <Clock size={12} className="mr-2" />
      AI 伦理问题 (昨天 09:15)
    </DropdownMenuItem>
  </DropdownMenuContent>
</DropdownMenu>
```

- 点击历史记录：
  1. 在 Canvas 中高亮对应的研究框架
  2. 在 Chat 中显示研究摘要

---

### 4. 导出研究报告（bonus）

**在研究完成后显示：**

```tsx
<DropdownMenu>
  <DropdownMenuTrigger>
    <PillButton>
      <Download size={14} />
      导出研究
    </PillButton>
  </DropdownMenuTrigger>

  <DropdownMenuContent>
    <DropdownMenuItem onClick={() => exportAs('markdown')}>
      Markdown 文档
    </DropdownMenuItem>
    <DropdownMenuItem onClick={() => exportAs('pdf')}>
      PDF 报告
    </DropdownMenuItem>
    <DropdownMenuItem onClick={() => exportAs('json')}>
      JSON 数据
    </DropdownMenuItem>
  </DropdownMenuContent>
</DropdownMenu>
```

---

## 🎨 视觉规范

### 颜色系统（研究模式）

```css
/* 主色调：紫色系（区别于对话的蓝色） */
--research-primary: #8b5cf6; /* 紫色-500 */
--research-light: #ede9fe; /* 紫色-100 */
--research-border: #c4b5fd; /* 紫色-300 */

/* 状态色 */
--status-pending: #94a3b8; /* 灰色 */
--status-running: #3b82f6; /* 蓝色 */
--status-done: #10b981; /* 绿色 */
--status-error: #ef4444; /* 红色 */
```

### 图标使用

```tsx
import {
  Sparkles, // 研究模式标识
  Search, // 搜索中
  Lightbulb, // 思考/洞察
  FileText, // 文档/来源
  Network, // 关系/连接
  Layout, // Canvas 视图
  History, // 历史记录
} from 'lucide-react';
```

### 动画时序

```
节点淡入：400ms ease-out
进度条更新：300ms ease-in-out
卡片展开/折叠：200ms ease-in-out
视口移动：600ms ease-in-out
高亮闪烁：1000ms ease-in-out (3次)
```

---

## 📱 响应式适配

### 小屏幕（< 768px）

- ResearchProgressCard 简化为单行进度条 + 展开按钮
- 步骤详情默认隐藏
- Canvas 自动切换为全屏模式（隐藏 Chat 面板）

### 中等屏幕（768px - 1024px）

- ResearchProgressCard 显示前 3 个步骤，其余折叠
- Canvas 和 Chat 左右分屏

### 大屏幕（> 1024px）

- ResearchProgressCard 完整显示
- 可选：在 Canvas 顶部显示浮动进度条

---

## 🚨 错误处理

### 场景 1：搜索失败

```
Chat 显示：
  ⚠️ 搜索 "..." 失败：Tavily API 限流
      [重试] [跳过] [使用本地知识]

Canvas：
  不添加节点（或创建占位符说明原因）
```

### 场景 2：内容提取失败

```
Chat 显示：
  ⚠️ 提取失败：无法访问 example.com
      已保存链接，您可以稍后手动查看

Canvas：
  创建 Web 节点但标记为"待确认"
  ┌─────────────────┐
  │ ⚠️ 待确认        │
  │ example.com     │
  └─────────────────┘
```

### 场景 3：LLM 调用失败

```
Chat 显示：
  ❌ 综合分析失败：OpenAI API 超时
      [重试] [使用其他模型] [查看原始数据]

用户可选择：
  - 重试当前步骤
  - 切换到 Claude/Gemini
  - 跳过综合，只保留来源节点
```

---

## 🎯 最小可行版本（MVP）

**第一版应该包含：**

✅ Deep Research 按钮（ChatInput）  
✅ ResearchProgressCard（基础版：仅进度条 + 步骤列表）  
✅ Canvas 自动添加节点（Text + Web + Note）  
✅ 简单的线性布局（上下排列）  
✅ 基础错误提示

**可以延后：**

⏸️ 暂停/继续控制  
⏸️ 研究历史记录  
⏸️ 导出功能  
⏸️ 高级布局算法  
⏸️ 自定义参数

---

## 🧪 A/B 测试建议

### 测试维度

1. **触发方式**：

   - A: 单独的 Deep Research 按钮
   - B: 长按 Send 按钮显示菜单

2. **进度显示**：

   - A: 在 Chat 中显示卡片
   - B: 在 Canvas 顶部显示浮动条

3. **节点标识**：
   - A: 左侧紫色边框
   - B: 节点周围渐变光晕

通过用户反馈迭代优化。

---

## 📊 成功指标

- **完成率**：启动研究 → 完成（目标 > 80%）
- **节点查看率**：用户点击"查看节点"的比例（目标 > 50%）
- **重用率**：用户事后编辑/重组研究节点（目标 > 60%）
- **满意度**：用户对研究结果的评分（目标 > 4.0/5.0）

---

**最后更新**: 2026-02-24
