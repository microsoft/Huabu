# Assistant Segments & ACP Rich Updates — Implementation Plan

> Status: **planning**（未开工，等决策点确认后起手 PR-1）
> Scope: 把 assistant 一次 turn 重构成「时序 parts 数组」，并把 ACP 的 `tool_call` / `tool_call_update` / `plan` 三类 update 接进 Sediment 的 wire 与 UI。
> 关联：[`huabu-acp-client-plan.md`](./huabu-acp-client-plan.md) §2.3、[`agent-architecture.md`](./agent-architecture.md)

---

## 0. Why

当前 assistant 消息在客户端虽然已经有了 `segments: AssistantSegment[]`（`text` / `thinking` 两种），但还存在以下断层：

1. **Wire 持久化拍平**：`ChatHistoryItem.assistant.content: string` 把服务端已经存好的 thinking / toolCall blocks 全砍掉，刷新后 thinking 丢失。
2. **Tool 仍是顶层 message**：`role: 'tool'` 与 assistant 平级，多轮 tool_call 在同一 turn 内会让"assistant segments"被 tool 顶层消息"切碎"——时序在视觉上断裂。
3. **ACP 三类 rich update 未接入**：`tool_call` / `tool_call_update` / `plan` 当前在 [`translator.ts`](../apps/server/src/modules/agent/acp/translator.ts) 全部返回 `null`，UI 看不到外部 agent 的工具执行与计划。

业界主流（Anthropic Messages、OpenAI Responses、Vercel AI SDK v5 `UIMessage.parts`、ACP `SessionUpdate`）都把一次 assistant turn 表示为 **「一条 message + 时序 parts 数组」**，tool/reasoning/text 是数组中的元素而不是独立消息。本计划把 Sediment 推到这条路径上。

---

## 1. 目标终态

```ts
type AssistantPart =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool';
      toolCallId: string;
      title: string;
      toolKind: AcpToolKind;
      status: AcpToolCallStatus;
      locations?: AcpToolCallLocation[];
      content?: AcpToolCallContent[];
      rawInput?: unknown;
      rawOutput?: unknown }
  | { kind: 'plan'; entries: AcpPlanEntry[] };

type ChatMessage =
  | { role: 'user'; ... }
  | { role: 'assistant'; id: string; parts: AssistantPart[]; resources?; ... }
  | { role: 'status' | 'intent-select' | 'prepared-prompt'; ... };
// 不再有 role: 'tool' 顶层消息
```

Wire 类型 `ChatHistoryItem.assistant.parts` 与上面一一对应；server `buildHistoryItems` 是 parts 翻译器；client `useChatHistory` 与 `useAgentStream` 走同一条聚合管线。

---

## 2. 协议层（`@sediment/shared`）

### 2.1 新增 `AgentStreamEvent` variant（三个）

```ts
| { type: 'tool_call';        data: AgentToolCallEventData }
| { type: 'tool_call_update'; data: AgentToolCallUpdateEventData }
| { type: 'plan';             data: AgentPlanEventData }
```

- `tool_call`：新工具调用发起。字段含 `toolCallId / title / kind / status('pending'|'in_progress') / rawInput? / locations? / content?`。
- `tool_call_update`：同一 `toolCallId` 的字段级补丁；**`content` 与 `locations` 是 replace 语义**，不是 append（按 ACP spec 原样透传）。
- `plan`：整张计划快照；agent 每次发都给完整 `entries[]`。

`AGENT_SSE_EVENTS` 常量同步追加。**不复用 `tool_start` / `tool_result`**——后者无法表达 in_progress 中途的 content/diff 流，也不含 `kind` / `locations`，两套语义并存反而清晰。

### 2.2 ACP 数据类型镜像（新文件 `packages/shared/src/types/agent/acp-tool.ts`）

```ts
export type AcpToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other';

export type AcpToolCallStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed';

export interface AcpToolCallLocation {
  path: string;
  line?: number;
}

export type AcpToolCallContent =
  | { type: 'content'; content: AcpContentBlock }
  | { type: 'diff'; path: string; oldText?: string | null; newText: string }
  | { type: 'terminal'; terminalId: string };

export type AcpContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string; uri?: string }
  | {
      type: 'resource_link';
      uri: string;
      name: string;
      mimeType?: string;
      description?: string;
    }
  | {
      type: 'resource';
      resource: {
        uri: string;
        mimeType?: string;
        text?: string;
        blob?: string;
      };
    };

export interface AcpPlanEntry {
  content: string;
  priority: 'high' | 'medium' | 'low';
  status: 'pending' | 'in_progress' | 'completed';
}
```

`terminal` 在 v1 不实现 capability，但**类型保留**避免未来反复扩。

### 2.3 `ChatHistoryItem` parts 化

```ts
export type AssistantHistoryPart =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; toolCallId: string; title: string;
      toolKind: AcpToolKind; status: AcpToolCallStatus;
      locations?: AcpToolCallLocation[]; content?: AcpToolCallContent[];
      rawInput?: unknown; rawOutput?: unknown }
  | { kind: 'plan'; entries: AcpPlanEntry[] };

export type ChatHistoryItem =
  | { role: 'user'; content: string; attachments?; selectedNodeIds? }
  | { role: 'assistant'; parts: AssistantHistoryPart[] }   // 新
  | { role: 'status' | 'intent-select' | 'prepared-prompt'; ... };
// 删掉 role: 'tool' 顶层项
```

---

## 3. 服务端

### 3.1 Translator（`apps/server/src/modules/agent/acp/translator.ts`）

`switch (update.sessionUpdate)` 补三个 case，无聚合、无状态，原样透传：

```ts
case 'tool_call':
  return { type: 'tool_call', data: {
    toolCallId: update.toolCallId, title: update.title,
    kind: update.kind ?? 'other',
    status: update.status ?? 'pending',
    rawInput: update.rawInput,
    locations: update.locations,
    content: update.content,
  }};
case 'tool_call_update':
  return { type: 'tool_call_update', data: {
    toolCallId: update.toolCallId,
    ...pick(update, ['status','title','kind','rawInput','rawOutput','locations','content']),
  }};
case 'plan':
  return { type: 'plan', data: { entries: update.entries } };
```

### 3.2 持久化（pi-ai Context）

- **tool_call / tool_call_update**：复用 pi-ai 已有的 `ToolCallBlock`；按 `toolCallId` 在当前 assistant message 的 `content[]` 内 merge。
- **plan**：pi-ai 没有 plan block，**新增自定义 block 类型 `{ type: 'plan', entries }`** 追加进 assistant.content。`buildHistoryItems` 翻译时 fold 成 `AssistantHistoryPart.plan`。**不走 `[SYSTEM AcpPlan]` sidecar**——sidecar 会污染 LLM 上下文。

### 3.3 `buildHistoryItems` 改为 parts 翻译器

遍历 `Context.messages` 时按时序产出 parts；当遇到 `toolResult` 顶层 message，按 `toolCallId` 回填到上一条 assistant 的 `tool` part；不再产出顶层 `role: 'tool'` ChatHistoryItem。

---

## 4. 客户端

### 4.1 类型搬家

`AssistantSegment` / `ChatMessage` 从 [`apps/web/src/components/Messages/types.ts`](../apps/web/src/components/Messages/types.ts) 下沉到 `apps/web/src/store/chatTypes.ts`，消除 store/hook → components 的反向依赖。`AssistantSegment` 与 wire `AssistantHistoryPart` 同构（可直接 `type AssistantSegment = AssistantHistoryPart`）。

### 4.2 聚合管线（`useAgentStream`）

每次新 turn 维护：

```ts
ctx.toolSegmentIndex: Map<toolCallId, segmentIdx>
ctx.planSegmentIdx?: number
```

事件处理：

| Event                                          | 行为                                                                                                |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `text_delta` / `thinking_delta`                | extend 末尾同 kind segment / push 新 segment（已实现）                                              |
| `tool_call`                                    | push `{kind:'tool', status:'in_progress', ...}`，登记 `toolSegmentIndex.set(id, idx)`               |
| `tool_call_update`                             | 按 id 取 segment，浅 merge；`content` / `locations` 整体替换                                        |
| `plan`                                         | 若 `planSegmentIdx` 存在，**原地替换**那条 segment 的 entries；否则 push 新 plan segment 并记录 idx |
| `tool_start` / `tool_result`（internal agent） | 同上路径，统一映射成 `kind:'tool'` segment；删掉 `role:'tool'` 顶层 message                         |
| `done`                                         | 清空 turn-scope 的两个 lookup                                                                       |

### 4.3 UI 组件

- **`ToolCallCard`**（`apps/web/src/components/Messages/ToolCallCard.tsx`，新增）
  - 头部：`kind` 图标 + `title` + 状态指示（pending/灰、in_progress/spinner + `text-info`、completed/`text-success`、failed/`text-danger`）+ 右侧 `locations[0].path:line`（多个显示 `+N`）。
  - 默认 in_progress 展开、completed 折叠、failed 展开。
  - body 按 `ToolCallContent.type` 分派：
    - `content + text` → 轻量 markdown（不走 Milkdown）；
    - `content + resource_link` → 文件链接卡（v1 仅 `console.log`，Phase 4 与 canvas binding 联动）；
    - `content + image` → `<img>`；
    - `diff` → 最小化 unified-diff text（TODO: Monaco DiffEditor）；
    - `terminal` → "Terminal output not available"。
  - a11y：`role="group"`，状态变化 `aria-live="polite"`。

- **`PlanCard`**（`apps/web/src/components/Messages/PlanCard.tsx`，新增）
  - 头部：`Plan` 标题 + `completed/total` 进度。
  - 每行：状态图标（`○` pending / `▸` in_progress + spinner / `✔` completed）+ 内容 + 优先级 pill。
  - 默认展开；语义 token：pending=`text-fg-muted` / in_progress=`text-info` / completed=`text-success`；priority pill 用 `info`/`warning`/`subtle` 色阶，不用 raw 颜色。
  - a11y：外层 `role="list"`，每行 `role="listitem"`，进度数字 `aria-label`。

- **`ToolKindIcon`**（`apps/web/src/config/toolIcons.ts`，新增）
  - `read=FileText, edit=Pencil, delete=Trash, move=MoveRight, search=Search, execute=Terminal, think=Brain, fetch=Download, switch_mode=SlidersHorizontal, other=Wrench`。

### 4.4 `AIMessage` 渲染分派

按 `parts` 顺序 map：

```tsx
parts.map((p, i) => {
  switch (p.kind) {
    case 'text':     return <MilkdownMessageCard key={i} content={p.text} />;
    case 'thinking': return <ThinkingCard key={i} text={p.text} isStreaming={...} />;
    case 'tool':     return <ToolCallCard key={p.toolCallId} part={p} />;
    case 'plan':     return <PlanCard key={i} entries={p.entries} />;
  }
})
```

相邻 `kind:'tool' && toolKind` 相同的 segments 可在 `AIMessage` 内部分组渲染（保留 internal agent 的 `ToolMessageGroup` 体验，也照顾 ACP 多文件批量 read）。

### 4.5 删除 / 简化

- `MessageList` 的 `role: 'tool'` 分支删除；`ToolMessageGroup` 分组逻辑搬进 `AIMessage`。
- `useSketchClusterMessages`、`useChatHistory` 改为产出 parts。
- `assistantMessageText` 继续只取 `kind:'text'` 段，用于 copy / "add as note" / 历史序列化。

---

## 5. PR 拆分与落地顺序

| PR       | 内容                                                                                                                                                                                     | 可独立合入             |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| **PR-1** | shared 新增三个 `AgentStreamEvent` + ACP 类型 + translator 三个 case；server 暂不渲染、不持久化（先打日志）。vitest 覆盖 translator 单元测试。                                           | ✅                     |
| **PR-2** | `ChatHistoryItem` parts 化 + `buildHistoryItems` 翻译器 + `useChatHistory` 1:1 映射。同时把 pi-ai plan block 持久化补齐。客户端流式仍走旧 `role:'tool'`，但读端已 parts。                | ✅                     |
| **PR-3** | `useAgentStream` 把 ACP 三类事件 + internal `tool_start/tool_result` 统一聚合进 `assistant.parts`；删 `role:'tool'` 顶层 message；新增 `ToolCallCard` + `PlanCard`；`MessageList` 简化。 | ✅（合并后改动面最大） |
| **PR-4** | `locations` 点击 follow-along；`session/request_permission` UI（与 ACP Phase 3 PR I 合并）。                                                                                             | ✅                     |
| **PR-5** | rich content：Monaco DiffEditor 接入；`resource_link` 与 canvas 节点 binding；terminal embed（若开启 capability）。                                                                      | ✅                     |

> PR-1 / PR-2 合入后，**当前 thinking PR 的 #3「持久化 thinking」自然解决**——server 端本来就存了，只是 wire 不再拍平。

---

## 6. 测试策略

- **PR-1**：translator 单测 — mock 各种 `SessionUpdate` payload → 期望 `AgentStreamEvent`；覆盖 `tool_call_update` 的"缺省字段不变 / `content` 整体替换"两条规则。
- **PR-2**：`buildHistoryItems` 单测 — 构造含 thinking / toolCall / plan blocks 的 pi-ai Context → 期望 parts 顺序无损。
- **PR-3**：`useAgentStream` 聚合测试 — 顺序灌入事件序列（含乱序 `tool_call_update`、同 turn 多个 `plan`、internal `tool_start/tool_result`）→ 检查最终 `assistant.parts` 形状；snapshot 覆盖 `AIMessage` 渲染分派。
- 浏览器手测：claude-code agent 真实跑一次 read+edit+plan turn，确认 follow-along / 折叠 / 进度条无回退。

---

## 7. 待确认决策点

1. **plan 是 turn 内 part 还是顶层悬浮？**
   - 推荐：turn 内 part（归属清晰、和 ACP 时序一致）。
   - 反方：若希望 plan 永远悬浮在 chat 顶部（VS Code todo list 风格），需走顶层 + store 单例。
2. **是否把 internal `tool_start/tool_result` 一并迁到 `kind:'tool'` segment？**
   - 推荐：迁。一套渲染路径、消除两套真相。
   - 代价：PR-3 改动面大；可分阶段（先 ACP，internal 留旧路径一段时间）。
3. **`terminal` content：v1 拒绝还是占位渲染？**
   - 推荐：占位（"Terminal output not available"），不动 wire 类型。
4. **`available_commands_update` 是否纳入本轮？**
   - 推荐：不纳入。留给 ChatInput slash-command 主题单独设计。
5. **`plan` 多次快照是否保留历史？**
   - 推荐：不保留（只渲染最新），但 segments 内允许多条 plan 共存为未来"plan 演化"留口子。当前聚合策略是**就地替换**，不 push 新条。

---

## 8. 已知风险

- **pi-ai 自定义 plan block**：若 pi-ai 后续升级冲突，需要本地适配层。
- **`role:'tool'` 顶层消息删除**：需要扫一遍所有引用（`useSketchClusterMessages` / 任何 store selectors / 持久化 sidecar），避免漏改。
- **wire 不向后兼容**：PR-2 一旦合入，旧版客户端连新服务端会拿不到 assistant.content 字符串；考虑加一次性兼容 shim 或同步发版。
- **Context.messages 体积**：tool content 含 image base64 / diff 大文件时，单条 turn 的存档会膨胀。需要在 PR-2 一起加个 size 阈值 + 截断标记（可继承 `apps/server/src/modules/storage/` 已有的 artifact ref 机制）。
