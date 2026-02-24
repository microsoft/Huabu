# Deep Research - 处理 Canvas 现有内容

> 当 Canvas 上已有内容时，Deep Research 应该如何智能地添加新节点

---

## 🎯 设计目标

1. **不破坏现有布局**：新节点不应覆盖或干扰现有内容
2. **建立智能关联**：如果研究与现有内容相关，应该创建连接
3. **保持可组织性**：用户应该能轻松区分和管理新旧内容
4. **给予控制权**：提供配置选项，让用户选择行为

---

## 📐 核心策略：智能空间分配

### 1. 检测可用空间

```typescript
// apps/server/src/modules/canvas/layout.service.ts

interface CanvasBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * 计算 Canvas 已有节点的边界
 */
export const calculateCanvasBounds = (
  nodes: CanvasNode[],
): CanvasBounds | null => {
  if (nodes.length === 0) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const node of nodes) {
    const { x, y } = node.position;
    const width = node.measured?.width ?? node.style?.width ?? 200;
    const height = node.measured?.height ?? node.style?.height ?? 150;

    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + width);
    maxY = Math.max(maxY, y + height);
  }

  return { minX, minY, maxX, maxY };
};
```

---

### 2. 选择放置策略

```typescript
export type PlacementStrategy =
  | 'right' // 在现有内容右侧
  | 'bottom' // 在现有内容下方
  | 'empty-space' // 寻找最大空白区域
  | 'new-canvas' // 创建新 Canvas（未来）
  | 'auto'; // 智能选择

export interface ResearchPlacementConfig {
  strategy: PlacementStrategy;
  padding: number; // 与现有内容的间距（默认 200）
  groupWithFrame: boolean; // 是否用 Frame 包裹（默认 true）
  autoConnect: boolean; // 是否自动连接相关节点（默认 false）
}
```

---

### 3. 实现各种策略

#### 策略 A：右侧放置（推荐 ⭐）

```typescript
export const placeResearchRight = (
  existingBounds: CanvasBounds,
  config: ResearchPlacementConfig,
): Point => {
  // 在现有内容的最右侧添加
  return {
    x: existingBounds.maxX + config.padding,
    y: existingBounds.minY,
  };
};
```

**适用场景**：

- 研究内容与现有内容相关（可建立水平连接）
- 用户习惯从左到右阅读
- Canvas 宽度足够

**视觉效果**：

```
┌──────────────┐     ┌──────────────────────┐
│ 现有节点 A   │     │ 🔬 研究计划          │
├──────────────┤     ├──────────────────────┤
│ ...          │     │ 1. 搜索...           │
└──────────────┘     │ 2. 分析...           │
                     └──────────────────────┘
┌──────────────┐
│ 现有节点 B   │     ┌──────────┐ ┌──────────┐
├──────────────┤     │ Web 1    │ │ Web 2    │
│ ...          │     └──────────┘ └──────────┘
└──────────────┘
                     ┌──────────────────────┐
                     │ 💡 综合分析          │
                     └──────────────────────┘
←─ 现有内容 ─→ ←space→ ←─── 研究内容 ───→
```

---

#### 策略 B：下方放置

```typescript
export const placeResearchBottom = (
  existingBounds: CanvasBounds,
  config: ResearchPlacementConfig,
): Point => {
  // 在现有内容的下方添加（左对齐）
  return {
    x: existingBounds.minX,
    y: existingBounds.maxY + config.padding,
  };
};
```

**适用场景**：

- 研究是对现有内容的深入探索
- Canvas 宽度有限
- 纵向流程更自然

**视觉效果**：

```
┌──────────────┐ ┌──────────────┐
│ 现有节点 A   │ │ 现有节点 B   │
└──────────────┘ └──────────────┘

─────────── 分隔线 ────────────

┌────────────────────────────────┐
│ 🔬 Deep Research: XXX          │
├────────────────────────────────┤
│ ┌────────┐ ┌────────┐         │
│ │ Web 1  │ │ Web 2  │  ...    │
│ └────────┘ └────────┘         │
│                                │
│ ┌────────────────────┐        │
│ │ 💡 综合分析         │        │
│ └────────────────────┘        │
└────────────────────────────────┘
```

---

#### 策略 C：空白区域（高级）

```typescript
export const findLargestEmptySpace = (
  nodes: CanvasNode[],
  viewport: { x: number; y: number; width: number; height: number },
): Point => {
  // 1. 将 Canvas 划分为网格
  const gridSize = 100;
  const grid: boolean[][] = [];

  // 2. 标记已占用的格子
  for (const node of nodes) {
    markOccupiedCells(grid, node, gridSize);
  }

  // 3. 寻找最大的连续空白区域
  const emptyRegions = findEmptyRegions(grid);
  const largest = emptyRegions.sort((a, b) => b.area - a.area)[0];

  // 4. 返回该区域的左上角
  return {
    x: largest.x * gridSize,
    y: largest.y * gridSize,
  };
};
```

**适用场景**：

- Canvas 上节点分布不规则
- 希望最大化利用空间
- 用户手动调整过布局

---

#### 策略 D：智能选择（推荐默认）

```typescript
export const autoSelectPlacementStrategy = (
  nodes: CanvasNode[],
  viewport: { x: number; y: number; width: number; height: number },
): PlacementStrategy => {
  if (nodes.length === 0) {
    // 空 Canvas：从左上角开始
    return 'empty-space';
  }

  const bounds = calculateCanvasBounds(nodes);
  if (!bounds) return 'empty-space';

  const canvasWidth = bounds.maxX - bounds.minX;
  const canvasHeight = bounds.maxY - bounds.minY;
  const aspect = canvasWidth / canvasHeight;

  // 如果现有内容是横向布局（宽 > 高），优先下方
  if (aspect > 1.5) {
    return 'bottom';
  }

  // 如果现有内容是纵向布局，优先右侧
  if (aspect < 0.66) {
    return 'right';
  }

  // 否则，检查可用空间
  const viewportWidth = viewport.width;
  const spaceOnRight = viewportWidth - bounds.maxX;

  // 右侧空间充足（> 600px），使用右侧
  if (spaceOnRight > 600) {
    return 'right';
  }

  // 否则使用下方
  return 'bottom';
};
```

---

## 🔗 智能关联：连接相关内容

### 1. 语义相似度检测（可选）

```typescript
/**
 * 检测研究主题是否与现有节点相关
 */
export const detectRelatedNodes = async (
  researchQuery: string,
  existingNodes: CanvasNode[],
): Promise<string[]> => {
  // 提取现有节点的文本内容
  const nodeContents = existingNodes
    .filter((n) => n.type !== 'frame')
    .map((n) => ({
      nodeId: n.id,
      content: extractNodeText(n),
    }));

  // 使用 LLM 判断相关性（快速调用）
  const relatedNodeIds = await llm.invoke(
    `Research query: ${researchQuery}
    
    Existing nodes:
    ${nodeContents
      .map((nc) => `- ${nc.nodeId}: ${nc.content.slice(0, 100)}`)
      .join('\n')}
    
    Which node IDs are related to the research query? Return as JSON array.`,
    { temperature: 0, max_tokens: 100 },
  );

  return JSON.parse(relatedNodeIds);
};
```

### 2. 自动创建连接

```typescript
export const connectResearchToExisting = (
  researchFrameId: string,
  relatedNodeIds: string[],
): Edge[] => {
  return relatedNodeIds.map((nodeId) => ({
    id: `e-${nodeId}-${researchFrameId}`,
    source: nodeId,
    target: researchFrameId,
    type: 'smoothstep',
    animated: true,
    label: '拓展研究',
    style: {
      stroke: '#8b5cf6',
      strokeWidth: 2,
    },
    markerEnd: {
      type: 'arrowclosed',
      color: '#8b5cf6',
    },
  }));
};
```

**视觉效果**：

```
┌──────────────┐
│ 现有：区块链 │────┐
│ 技术介绍     │    │
└──────────────┘    │
                    ↓ "拓展研究"
                ┌───────────────────────┐
                │ 🔬 Frame: Web3 供应链  │
                │ ┌─────────┐           │
                │ │ Web 1   │  ...      │
                │ └─────────┘           │
                └───────────────────────┘
```

---

## 🎛️ 用户配置选项

### 方案 A：触发时询问（首次使用）

```tsx
// 第一次使用 Deep Research 时弹出配置对话框

<Dialog open={isFirstResearch}>
  <DialogTitle>Deep Research 设置</DialogTitle>
  <DialogContent>
    <div className="space-y-4">
      <div>
        <Label>Canvas 上已有内容，新节点应该放在哪里？</Label>
        <RadioGroup value={placement} onChange={setPlacement}>
          <RadioItem value="auto">
            智能选择（推荐）
            <span className="text-muted text-xs">自动判断最佳位置</span>
          </RadioItem>
          <RadioItem value="right">现有内容右侧</RadioItem>
          <RadioItem value="bottom">现有内容下方</RadioItem>
        </RadioGroup>
      </div>

      <div className="flex items-center gap-2">
        <Checkbox checked={groupWithFrame} onChange={setGroupWithFrame} />
        <Label>用 Frame 包裹研究内容</Label>
      </div>

      <div className="flex items-center gap-2">
        <Checkbox checked={autoConnect} onChange={setAutoConnect} />
        <Label>自动连接相关节点（实验性）</Label>
      </div>

      <div className="flex items-center gap-2">
        <Checkbox checked={remember} onChange={setRemember} />
        <Label>记住我的选择</Label>
      </div>
    </div>
  </DialogContent>
  <DialogActions>
    <Button variant="outline" onClick={handleCancel}>
      取消
    </Button>
    <Button onClick={handleStart}>开始研究</Button>
  </DialogActions>
</Dialog>
```

---

### 方案 B：设置面板（推荐）

```tsx
// 在 ChatInput 的设置按钮中添加

<SettingsPopover>
  <SettingsSection title="Deep Research">
    <SettingItem label="节点放置">
      <Select value={placement} onChange={setPlacement}>
        <option value="auto">智能选择</option>
        <option value="right">现有内容右侧</option>
        <option value="bottom">现有内容下方</option>
        <option value="empty-space">寻找空白区域</option>
      </Select>
    </SettingItem>

    <SettingItem label="与现有内容的间距">
      <Slider
        value={padding}
        onChange={setPadding}
        min={100}
        max={500}
        step={50}
      />
      <span className="text-xs">{padding}px</span>
    </SettingItem>

    <SettingItem>
      <Checkbox checked={groupWithFrame} onChange={setGroupWithFrame}>
        用 Frame 包裹研究内容
      </Checkbox>
    </SettingItem>

    <SettingItem>
      <Checkbox checked={autoConnect} onChange={setAutoConnect}>
        自动连接相关节点
      </Checkbox>
    </SettingItem>
  </SettingsSection>
</SettingsPopover>
```

---

## 🎨 视觉区分：研究 Frame

### 自动创建研究框架

```typescript
export const createResearchFrame = (
  researchQuery: string,
  timestamp: Date,
  color: 'purple' | 'blue' | 'green' = 'purple',
): FrameNode => {
  return {
    id: createId('frame'),
    type: 'frame',
    position: { x: 0, y: 0 }, // 由布局算法确定
    data: {
      label: `🔬 ${researchQuery.slice(0, 40)}...`,
      metadata: {
        researchGenerated: true,
        createdAt: timestamp.toISOString(),
        query: researchQuery,
      },
      style: {
        backgroundColor: `rgba(139, 92, 246, 0.05)`, // 紫色半透明
        borderColor: '#8b5cf6',
        borderWidth: 2,
        borderStyle: 'dashed',
      },
    },
    style: {
      width: 800, // 初始宽度，会自动调整
      height: 600, // 初始高度，会自动调整
    },
  };
};
```

**视觉效果**：

```
Canvas 全局视图：

┌────────────────┐  ┌────────────────┐
│ 用户手动创建   │  │ 用户手动创建   │
│ 的笔记 A       │  │ 的笔记 B       │
└────────────────┘  └────────────────┘

┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┐
┊ 🔬 Web3 供应链应用研究 - 2026-02-24   ┊ ← 紫色虚线边框
┊ ┌────────────────────────────────┐  ┊
┊ │ 🧠 研究计划                    │  ┊
┊ └────────────────────────────────┘  ┊
┊                                      ┊
┊ ┌──────┐ ┌──────┐ ┌──────┐         ┊
┊ │ Web 1│ │ Web 2│ │ Web 3│   ...   ┊
┊ └──────┘ └──────┘ └──────┘         ┊
┊                                      ┊
┊ ┌────────────────────────────────┐  ┊
┊ │ 💡 综合分析                    │  ┊
┊ └────────────────────────────────┘  ┊
┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┘
```

---

## 🔄 完整交互流程

### 场景 1：空 Canvas

```
用户触发研究
  ↓
检测：Canvas 为空
  ↓
从左上角 (100, 100) 开始放置
  ↓
正常执行研究流程
```

---

### 场景 2：Canvas 有少量节点

```
用户触发研究
  ↓
检测：Canvas 有 3 个节点，分布在左侧
  ↓
智能选择：右侧空间充足 → 使用 "right" 策略
  ↓
计算起始位置：(maxX + 200, minY)
  ↓
创建研究 Frame（虚线紫色边框）
  ↓
在 Frame 内添加节点（层级布局）
  ↓
视口自动调整，同时显示现有内容和研究框架
```

---

### 场景 3：Canvas 内容密集

```
用户触发研究
  ↓
检测：Canvas 有 15+ 个节点，横向分布
  ↓
智能选择：横向过长 → 使用 "bottom" 策略
  ↓
计算起始位置：(minX, maxY + 200)
  ↓
创建研究 Frame（标题显示折叠箭头）
  ↓
在 Frame 内添加节点
  ↓
完成后显示提示："研究内容已添加到下方"
  ↓
提供 "跳转到研究" 按钮
```

---

### 场景 4：启用自动关联

```
用户触发研究："深入分析区块链共识算法"
  ↓
检测：Canvas 有节点 "区块链技术介绍"
  ↓
LLM 判断：相关度 85%
  ↓
在右侧创建研究 Frame
  ↓
自动创建 Edge：
  "区块链技术介绍" ──→ "研究 Frame"
  label: "拓展研究"
  ↓
研究完成后在 Chat 显示：
  "✓ 已关联到现有节点：区块链技术介绍"
```

---

## 🎯 推荐配置

### 默认配置（适合大多数用户）

```typescript
const DEFAULT_RESEARCH_CONFIG: ResearchPlacementConfig = {
  strategy: 'auto', // 智能选择位置
  padding: 200, // 200px 间距
  groupWithFrame: true, // 用 Frame 包裹
  autoConnect: false, // 不自动连接（避免混乱）
};
```

### 高级用户配置

```typescript
const ADVANCED_RESEARCH_CONFIG: ResearchPlacementConfig = {
  strategy: 'empty-space', // 寻找最大空白区域
  padding: 150, // 紧凑布局
  groupWithFrame: true, // 保持 Frame
  autoConnect: true, // 启用自动关联
};
```

---

## 💡 特殊场景处理

### 场景 A：Canvas 接近视口边界

```typescript
// 如果计算出的位置超出合理范围，自动调整
export const adjustPositionToViewport = (
  position: Point,
  viewport: { width: number; height: number },
  maxOffset = 5000, // 最大偏移 5000px
): Point => {
  return {
    x: Math.min(position.x, maxOffset),
    y: Math.min(position.y, maxOffset),
  };
};
```

**提示用户**：

```
⚠️ Canvas 内容过多，研究节点已放置在较远位置
[在 Canvas 中查看] [调整布局]
```

---

### 场景 B：用户在研究过程中移动节点

```typescript
// 监听节点移动事件
const handleNodeDragStop = (event: NodeDragEvent, node: Node) => {
  const researchState = getOngoingResearch();

  if (researchState && researchState.frameId === node.parentId) {
    // 用户正在调整研究框架内的节点
    // 暂停自动布局，改为手动模式
    researchState.layoutMode = 'manual';

    showToast('已切换为手动布局模式', {
      action: {
        label: '恢复自动',
        onClick: () => {
          researchState.layoutMode = 'auto';
        },
      },
    });
  }
};
```

---

### 场景 C：多次研究的隔离

```typescript
// 如果用户连续发起多个研究，自动分隔
export const placeMultipleResearches = (
  previousResearchBounds: CanvasBounds,
  index: number,
): Point => {
  // 每个研究之间间隔 300px
  const offset = index * 300;

  return {
    x: previousResearchBounds.minX + offset,
    y: previousResearchBounds.maxY + 200,
  };
};
```

**视觉效果**：

```
┌─────────────────────┐ ┌─────────────────────┐
│ 🔬 研究 1           │ │ 🔬 研究 2           │
│  (第一次)           │ │  (第二次)           │
└─────────────────────┘ └─────────────────────┘

         ↓                        ↓
┌─────────────────────┐
│ 🔬 研究 3           │
│  (第三次)           │
└─────────────────────┘
```

---

## 🧪 实现优先级

### Phase 1 - MVP

- ✅ 检测 Canvas 边界
- ✅ 智能选择策略（auto: right vs bottom）
- ✅ 创建研究 Frame（紫色虚线边框）
- ✅ 基础布局（right 和 bottom）

### Phase 2 - 增强

- ⏸️ 空白区域检测（empty-space 策略）
- ⏸️ 用户配置选项（设置面板）
- ⏸️ 视口边界检测和调整
- ⏸️ 多次研究的隔离

### Phase 3 - 高级

- ⏸️ 语义相似度检测
- ⏸️ 自动关联功能
- ⏸️ 手动/自动布局切换
- ⏸️ 研究历史和回放

---

## 📊 测试用例

### 用例 1：空 Canvas

```
输入：Canvas 无节点
期望：从 (100, 100) 开始
```

### 用例 2：左侧有内容

```
输入：3 个节点在 x: 0-400 范围
期望：从 x: 600 开始（右侧放置）
```

### 用例 3：横向分布

```
输入：节点宽度 > 1000px，高度 < 500px
期望：使用 bottom 策略
```

### 用例 4：纵向分布

```
输入：节点宽度 < 500px，高度 > 1000px
期望：使用 right 策略
```

### 用例 5：密集布局

```
输入：20+ 个节点，占满视口
期望：下方放置 + 提示用户滚动查看
```

---

## 🎬 演示视频脚本（建议）

**场景描述**：

```
1. 打开 Sediment，Canvas 上已有 3 个笔记节点
2. 在 Chat 输入："分析量子计算在密码学中的应用"
3. 点击 "Deep Research" 按钮
4. 动画：
   - Canvas 右侧淡入紫色虚线 Frame
   - 标题："🔬 量子计算密码学研究"
   - Frame 内自动添加节点（思考 → 搜索 → 分析）
5. 用户点击 Chat 中的 "查看节点"
   - Canvas 平滑移动，聚焦到新 Frame
6. 研究完成，显示摘要卡片
```

---

**最后更新**: 2026-02-24
