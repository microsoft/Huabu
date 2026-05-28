# Assistant Segments & ACP Rich Updates — Implementation Plan

> Status: **planning**（§0.5 Spike 已完成且推翻原 §3.2；§2.2 已切换到官方 `@agentclientprotocol/sdk`；§1/§2.4/§3.2/§4.3/§4.4/§4.5/§7 已加 `internalToolName` 逃生门 + `permission` 字段预留，保留现有 `CanvasCommandCard` / `WebSearchToolDisplay` / `MergedAgentToolRow` 渲染路径。等 PR-1 实施。）
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

## 0.5 Pre-PR-1 Spike（已完成）

> Status: Spike 三件事已跑完，结论回填如下。**架构上发生了一次转向**：原计划「把自定义 block 塞进 pi-ai content」被抓出不可行，改为 **sidecar JSON**。§3.2 已被重写。

### S1 — pi-ai 自定义 block 可行性 → 🔴 不可行

所查版本：`@earendil-works/pi-ai@0.75.5`（[dist/types.d.ts](../node_modules/.pnpm/@earendil-works+pi-ai@0.75.5_ws@8.19.0_zod@4.3.6/node_modules/@earendil-works/pi-ai/dist/types.d.ts)）。

关键事实：

1. **名字不叫 `ToolCallBlock`，叫 `ToolCall`**，且字段远少于 ACP：
   ```ts
   // pi-ai @ 0.75.5
   export interface ToolCall {
     type: 'toolCall';
     id: string;
     name: string;
     arguments: Record<string, any>;
     thoughtSignature?: string;
   }
   ```
   ACP `tool_call` 的 `kind / status / locations / content / rawInput / rawOutput` 在 pi-ai 这里**都无处可存**。
2. **`AssistantMessage.content` 是封闭 discriminated union**：
   ```ts
   export interface AssistantMessage {
     role: 'assistant';
     content: (TextContent | ThinkingContent | ToolCall)[]; // 封闭
     // …
   }
   ```
   TS 编译层直接拒收 `{ type: 'plan', entries }`；pi-ai 内部如果对 `content[]` 做 `filter(isKnownType)` / `map(toApiFormat)` 也会静默丢掉未知 block。
3. **`Context` 没有 metadata / extensions / `[key: string]: unknown` 任何开放扩展点**：
   ```ts
   export interface Context {
     systemPrompt?: string;
     messages: Message[];
     tools?: Tool[];
   }
   ```
4. **`ToolResultMessage.content` 同样封闭**：只允许 `(TextContent | ImageContent)[]`。ACP `tool_call_update.content[]` 里的 `diff` / `terminal` / `resource_link` 三种 block 同样无处可存。
5. pi-ai 全包 grep `'plan'` 只出在服务商名称里，**不存在 plan / planning 概念**。

结论：原 §3.2 中间分枝（🟡 "`ToolCallBlock` 存在但 union 封闭"）**部分命中** —— union 确实封闭，但根本没 `ToolCallBlock`。采纳事先列出的「plan 走 sidecar JSON」分支，并把同一机制扩展到「**ACP tool 的所有顶出 pi-ai ToolCall 的字段也走 sidecar**」。

### S2 — ACP `kind` 字段下发率 → 🟡 无法静态测算，保守采 fallback

- Sediment 目前未依赖 ACP 官方 SDK，ACP 是手写 JSON-RPC（[client.ts](../apps/server/src/modules/agent/acp/client.ts)）。无本地可静态远访的 schema 源。
- 但 [client.ts L662](../apps/server/src/modules/agent/acp/client.ts#L662) 里处理 `session/request_permission` 时，`toolCall` 被声明为 `{ toolCallId?: unknown; title?: unknown; kind?: unknown }`——三个都 optional。这与 ACP spec（agentclientprotocol.com/protocol/schema）中 `ToolCall.kind` 为 optional 一致。
- 代码中现有 TODO 注释：「_when we add UI gating, branch here on `toolCall.kind`_」也隐含 kind 下发不稳定。

结论：PR-3 的 `ToolKindIcon` **必须实现 fallback 启发式**（按 `title` 前缀 / 关键字推断 kind），不能依赖 ACP server 传 `kind`。真实下发率较高到 metric 阶段再决定是否可以拍掉实现：PR-1 同步在 [translator.ts](../apps/server/src/modules/agent/acp/translator.ts) 加一行「`update.kind == null` 统计计数器 + info-level 日志」，PR-1 合入后收集 1–2 周生产数据再评估。

**Spike 后补充**：调研发现 ACP 官方 TS SDK 已发布在 `@agentclientprotocol/sdk@^0.22.1`（schema v0.13.2，peer-dep zod ^3 || ^4），同时提供 `types.gen.ts` 与 `zod.gen.ts`。决定 §2.2 直接 re-export SDK 类型而非手写 mirror，§2.3 的 zod 也大幅退化为「只写三个 wire 包装」。完整理由见新 §2.2 / §2.3。

### S3 — 文档冲突解锁 → 可以收口

- 本计划 §2.1 「不复用 `tool_start` / `tool_result`，新增 `tool_call` / `tool_call_update` / `plan`」的决定**保留**。[`huabu-acp-client-plan.md`](./huabu-acp-client-plan.md) §2.3 表格需同步重写为：
  - `tool_call` → `tool_call`（不是 `tool_start`）
  - `tool_call_update` → `tool_call_update`（不是 `tool_result`）
  - `plan` → `plan`（不是 `thinking_delta`）
- [`agent-architecture.md`](./agent-architecture.md) 的 SSE 事件清单从 9 个扩到 12 个。
- 这两份同步动作放进 PR-1 一起提交，避免其他 ACP PR 按旧映射接续出错。

### Spike 后留下的 Open Questions（随 PR-1 解决）

1. **sidecar 与 Context 的 messageId 关联键**：pi-ai `Message` 没有 `id` 字段，只有 `timestamp: number`。Sidecar 应该用「`messages` 数组下标」还是「`timestamp + partIndex` 复合键」关联？下标依赖 pi-ai append-only——需要 PR-1 加 vitest 验证 pi-ai resume / streaming 不重排 `messages`。**推荐**：PR-1 默认用下标，同时在 sidecar 里冗余写 timestamp 作 sanity check，读时不匹配则 warn 并以下标为准。
2. **两份文件的事务性**：`writeChat()` 与未来的 `writeChatParts()` 是两次独立 atomic write，中间崩溃会造成片面一致。**推荐**：不引入跨文件事务。Sidecar 丢失退化为「只剩 pi-ai 原生 ToolCall 信息」（UI 展示 kind=other / 无 plan），数据不会坏。但要在 buildHistoryItems 里容忘 sidecar 缺失。
3. **ACP 模式下 pi-ai Context 的角色变了**：ACP 外部 agent 不依赖 Sediment 调 pi-ai LLM，所以 ACP 模式下 `Context.messages` 实际上退化为「UI 历史快照」，不再是 LLM 上下文。这让 sidecar 方案在 ACP 模式下零风险（不需担心污染 LLM）。Internal agent 模式下 sidecar 大概率是空的（internal tool 不走 ACP 扩展字段，也没 plan）。两种模式都安全。

---

## 1. 目标终态

```ts
type AssistantPart =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool';
      // ACP 通用字段
      toolCallId: string;
      title: string;
      toolKind: AcpToolKind;
      status: AcpToolCallStatus;
      locations?: AcpToolCallLocation[];
      content?: AcpToolCallContent[];
      rawInput?: unknown;
      rawOutput?: unknown;
      // Sediment internal-agent 逃生门（对 ACP 模式恒为 undefined）
      internalToolName?: InternalAgentToolName;
      internalToolData?: unknown;
      // ACP permission state（PR-1/2/3 期间 server auto-allow 时 outcome 预填）
      permission?: ToolPermissionState }
  | { kind: 'plan'; entries: AcpPlanEntry[] };

/** Nominal union of Sediment 自家 internal agent 工具名（与 apps/server/.../tools/definitions.ts 对齐）。 */
type InternalAgentToolName =
  | 'read' | 'grep' | 'find' | 'ls'
  | 'inspect_nodes' | 'get_canvas_outline'
  | 'canvas_commands' | 'web_search';

type ToolPermissionState = {
  options: AcpPermissionOption[];
  outcome?:
    | { type: 'allowed'; optionId: string }
    | { type: 'denied'; optionId: string }
    | { type: 'cancelled' };
  requestedAt: number;
  resolvedAt?: number;
};

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

### 2.2 ACP 数据类型 → 直接复用官方 SDK

> 决定：引入 `@agentclientprotocol/sdk@^0.22.1`（schema v0.13.2 / wire protocol v1 / Apache-2.0），不再自行 mirror。

**新文件** `packages/shared/src/types/agent/acp-tool.ts` 改为薄薄的 re-export，只放 type：

```ts
// Re-export upstream ACP types under Sediment-stable aliases.
// type-only —— SDK runtime (zod) 留在 sibling .schemas.ts，web 永远只 `import type`。
export type {
  ToolCall as AcpToolCall,
  ToolCallUpdate as AcpToolCallUpdate,
  ToolCallContent as AcpToolCallContent,
  ToolCallStatus as AcpToolCallStatus,
  ToolCallLocation as AcpToolCallLocation,
  ToolKind as AcpToolKind,
  ContentBlock as AcpContentBlock,
  PlanEntry as AcpPlanEntry,
  Plan as AcpPlan,
  Diff as AcpDiff,
  Terminal as AcpTerminalRef,
  // Permission（PR-1 仅引入类型，UI/wire 回路留 PR-4）
  PermissionOption as AcpPermissionOption,
  PermissionOptionKind as AcpPermissionOptionKind,
  RequestPermissionRequest as AcpRequestPermissionRequest,
  RequestPermissionResponse as AcpRequestPermissionResponse,
} from '@agentclientprotocol/sdk';
```

**与原手写 §2.2 的差异**（SDK 严格更对）：

- `ContentBlock` 多 `audio` variant —— 我们之前手写漏了。UI 端 PR-3 在 `ToolCallCard` body 分派里补一个占位渲染（建议「Audio playback not supported in v1」），与现有的 `terminal` 占位同处理。
- 所有对象都带 `_meta?: Record<string, unknown> | null`。**序列化时直接保留**，零类型成本；buildHistoryItems 输出也透传。
- `ToolCallLocation` 多 `_meta`；`PlanEntry` 多 `_meta`；`Diff` 多 `_meta` —— 同理透传。
- SDK 自带 `AGENT_METHODS / CLIENT_METHODS` 字符串常量，可顺手替换 [client.ts](../apps/server/src/modules/agent/acp/client.ts) 里硬编码的方法名（属顺手清洁，非必须）。

**依赖卫生（关键）**：

- `packages/shared/package.json` 加 `dependencies: "@agentclientprotocol/sdk": "^0.22.1"`；zod 已有满足 peer-dep `^3.25.0 || ^4.0.0`。
- 本 `.ts` 文件**只 re-export type**，配套 zod 全部走 sibling 文件 `acp-tool.schemas.ts`（详见 §2.3），保证 web 端 `import type` 即可，SDK 运行时不会进 web bundle（遵循 [copilot-instructions](../.github/copilot-instructions.md) 「web bundle zod-free」要求）。
- 加 vitest 单测：`it('shared/index does not pull SDK runtime', ...)`，import 整个 `@sediment/shared` 后断言 `require.cache` 不含 SDK runtime 路径，防止后续不小心从 type 文件 re-export 出 schema。

**SDK ≠ wire 协议版本**：SDK 自身版本会随 schema 演进 bump，但 wire `protocolVersion` 仍是 1。升 SDK 时读 CHANGELOG 即可，不会破 wire 兼容。

**明确 out of scope**：SDK 提供 `ClientSideConnection` 完整 JSON-RPC 实现，可替换 Sediment 手写的 [client.ts](../apps/server/src/modules/agent/acp/client.ts)。但涉及 `fs/read_text_file` capability hook、permission auto-allow 等多处自定义路由，**非平凡改造**，留作独立 follow-up PR，不进本计划。

### 2.3 Zod schema（PR-1 必交付）—— 大头复用 SDK

`.github/copilot-instructions.md` 的 API 设计规则要求：每个新增 wire 类型在 `packages/shared/src/types/api/*` 用 zod schema + `z.infer` 定义，server 端 `safeParse`。本计划新增的不是 HTTP payload 而是 SSE event payload，但翻译路径 `acpUpdateToStreamEvent` 也要在出口 `safeParse`，保证 ACP server 的奇形怪状 payload 不污染 wire。

**ACP 协议层 schema 全部直接复用 SDK**（[`src/schema/zod.gen.ts`](https://github.com/agentclientprotocol/typescript-sdk/blob/main/src/schema/zod.gen.ts)）：

```ts
// packages/shared/src/types/agent/acp-tool.schemas.ts —— server-only import
export {
  zToolCall as ZAcpToolCall,
  zToolCallUpdate as ZAcpToolCallUpdate,
  zToolCallContent as ZAcpToolCallContent,
  zToolKind as ZAcpToolKind,
  zToolCallStatus as ZAcpToolCallStatus,
  zToolCallLocation as ZAcpToolCallLocation,
  zContentBlock as ZAcpContentBlock,
  zPlan as ZAcpPlan,
  zPlanEntry as ZAcpPlanEntry,
  zSessionUpdate as ZAcpSessionUpdate,
} from '@agentclientprotocol/sdk';
```

**PR-1 仍需手写的 schema**——只剩三个 wire event data 包装：

- `AgentToolCallEventDataSchema` —— 在 `ZAcpToolCall.pick({...}).extend({ kind: ZAcpToolKind.default('other'), status: ZAcpToolCallStatus.default('pending') })` 上拼装；
- `AgentToolCallUpdateEventDataSchema` —— 复用 `ZAcpToolCallUpdate` 不动；
- `AgentPlanEventDataSchema` —— `z.object({ entries: z.array(ZAcpPlanEntry) })`。

translator.ts 出口加一行 `ZAcpSessionUpdate.safeParse(update)`，同时覆盖三个 case 入口校验。

**工作量**：从原估 ~150 行 zod + 测试降到 ~30 行（嵌套 discriminated union 不用再写），PR-1 表格据此调整。

### 2.4 `ChatHistoryItem` parts 化

```ts
export type AssistantHistoryPart =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; toolCallId: string; title: string;
      toolKind: AcpToolKind; status: AcpToolCallStatus;
      locations?: AcpToolCallLocation[]; content?: AcpToolCallContent[];
      rawInput?: unknown; rawOutput?: unknown;
      // 与 §1 AssistantPart 同步：internal agent 逃生门 + permission state
      internalToolName?: InternalAgentToolName;
      internalToolData?: unknown;
      permission?: ToolPermissionState }
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

入参类型直接用 SDK 的 `SessionUpdate`（[`@agentclientprotocol/sdk`](https://github.com/agentclientprotocol/typescript-sdk)），不再人肉 narrow。`switch (update.sessionUpdate)` 补三个 case，无聚合、无状态，原样透传；出口走 `safeParse` 校验：

```ts
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import {
  ZAcpToolCall,
  ZAcpToolCallUpdate,
  ZAcpPlan,
} from '@sediment/shared/types/agent/acp-tool.schemas';

case 'tool_call': {
  const parsed = ZAcpToolCall.safeParse(update);
  if (!parsed.success) { log.warn(...); return null; }
  return { type: 'tool_call', data: {
    toolCallId: parsed.data.toolCallId, title: parsed.data.title,
    kind: parsed.data.kind ?? 'other',         // metric 计数器在这里 +1
    status: parsed.data.status ?? 'pending',
    rawInput: parsed.data.rawInput,
    locations: parsed.data.locations,
    content: parsed.data.content,
  }};
}
case 'tool_call_update': {
  const parsed = ZAcpToolCallUpdate.safeParse(update);
  if (!parsed.success) { log.warn(...); return null; }
  return { type: 'tool_call_update', data: parsed.data };
}
case 'plan': {
  const parsed = ZAcpPlan.safeParse(update);
  if (!parsed.success) { log.warn(...); return null; }
  return { type: 'plan', data: { entries: parsed.data.entries } };
}
```

### 3.2 持久化：sidecar JSON（**于 S1 后推翻原方案**）

> S1 结论：pi-ai 0.75.5 的 `AssistantMessage.content` 是封闭 union，`Context` 无开放扩展点，`ToolCall` 字段大幅低于 ACP。原计划「复用 `ToolCallBlock` + 新增自定义 `plan` block」不可行。【详见 §0.5 S1】

**分层**：

- **pi-ai Context（`<canvasId>/.history/chat/<threadId>.json`）**：保持原生。只存 pi-ai 内建 union 允许的 `TextContent | ThinkingContent | ToolCall` 与 `ToolResultMessage`。ACP `tool_call` 进来时，**如果**能压缩出 pi-ai `ToolCall` 的三个字段（`id=toolCallId, name=title, arguments=rawInput`）就写进去，其余字段走 sidecar。
- **Sidecar（新文件 `<canvasId>/.history/chat/<threadId>.parts.json`）**：存 ACP 扩展信息 + plan。

**Sidecar schema**（同步补进 §2.5）：

```ts
type ChatPartsSidecar = {
  schemaVersion: 1;
  parts: Array<
    | {
        messageIndex: number;
        partIndex: number;
        kind: 'plan';
        entries: AcpPlanEntry[];
      }
    | {
        messageIndex: number;
        partIndex: number;
        kind: 'tool_acp_ext';
        toolCallId: string;
        extension: {
          toolKind?: AcpToolKind;
          status?: AcpToolCallStatus;
          locations?: AcpToolCallLocation[];
          content?: AcpToolCallContent[];
          rawOutput?: unknown;
          /** ACP permission state；PR-1/2/3 期间 server auto-allow 时由 translator 预填。 */
          permission?: ToolPermissionState;
        };
      }
  >;
  /** Sanity check: pi-ai message timestamps in same order as messageIndex; mismatch → warn. */
  messageTimestamps: number[];
};
```

**写入点**（agent.service 收到 ACP event 时）：

- `tool_call`：处理当前 assistant message 尾部。拼出 pi-ai `ToolCall` push 进 `content[]`；如果有 `kind/status/locations/content` 任一 → 同时 append 一条 `tool_acp_ext` 进 sidecar。
- `tool_call_update`：同 `toolCallId` 查 sidecar、浅 merge；`content` / `locations` 整体替换；`status: 'completed'` 时如果有 `rawOutput` 且可压缩为文本 → 写一条 pi-ai `ToolResultMessage` 以保 LLM 各状（ACP 模式下其实不需要，但保证 internal-agent migration 路径一致）。
- `plan`：一条 `plan` sidecar 条目，同 turn 内后续 `plan` 原地替换不 push 新条（§7 决策 #5）。

**读取点**（§3.3 `buildHistoryItems`）：遵循 pi-ai Context 时序产出 parts；同时按 `messageIndex` 从 sidecar 拉 extras：

- `tool` part：以 pi-ai ToolCall 信息初始化（`toolCallId=id, title=name, rawInput=arguments, toolKind='other', status='completed'`），再从 sidecar `tool_acp_ext` extension 覆盖。Sidecar 缺失 → 退化为基础信息不报错。
- `plan` part：直接从 sidecar 插进 assistant.parts 的相应 `partIndex`。没有则不插。

**为什么不走 SQLite 表**：现有 [storage/canvas-store.ts](../apps/server/src/modules/storage/canvas-store.ts) 不涉及 chat history 的 SQLite（SQLite 给 canvas / knowledge / langgraph 用）；chat 持久化是纯文件。为 sidecar 拉起一个新表 / 新连接不偏。`<threadId>.parts.json` 与 `<threadId>.json` 同目录、同生同死，同一 `CanvasStore` API 表面上加 `writeChatParts / readChatParts` 即可。

**为什么不担心污染 LLM**：ACP 模式下 pi-ai Context 退化为 UI 快照，不调 LLM；internal-agent 模式下 sidecar 为空。两者都不会把 sidecar 字段递给 LLM【详见 §0.5 Open Question #3】。

**为什么 sidecar 不存 `internalToolData`**：internal agent 的 `tool_result.toolResponse.data` 已经被 pi-ai 序列化成 JSON 字符串塞进 `ToolResultMessage.content[0].text`（[agent.route.ts L665](../apps/server/src/modules/agent/agent.route.ts#L665) 附近），是 LLM 上下文的固有部分。sidecar 再存一份是双写——体积爆炸（`canvas_commands.data.commands[]` 可能巨大）且容易漂移。**`buildHistoryItems` 在产出 `kind:'tool'` part 时按 `toolCallId` 找对应 `ToolResultMessage`，`JSON.parse(content[0].text)` 塞回 `internalToolData` 字段**。ACP 模式下不存在 internal `tool_result`，`internalToolData` 自然为 undefined。`internalToolName` 同理从 pi-ai `ToolCall.name` 推回，无需 sidecar 冗余。

### 3.3 `buildHistoryItems` 改为 parts 翻译器

遍历 `Context.messages` 时按时序产出 parts；当遇到 `toolResult` 顶层 message，按 `toolCallId` 回填到上一条 assistant 的 `tool` part 的 `rawOutput` / `internalToolData` / `internalToolName`：

- `internalToolName`：从同 turn pi-ai `ToolCall.name` 推回，对 nominal union（§7 #7）做白名单校验，不在表内则丢弃（避免外部 ACP tool 名字 leak 进 nominal union 触发 UI 误分派）；
- `internalToolData`：`JSON.parse(toolResultMessage.content[0].text)`，parse 失败则原字符串落到 `rawOutput`；
- `permission`：从 sidecar `tool_acp_ext.extension.permission` 覆盖，不存在则不写。

不再产出顶层 `role: 'tool'` ChatHistoryItem。

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

| Event                                          | 行为                                                                                                                                                                                                                                                  |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `text_delta` / `thinking_delta`                | extend 末尾同 kind segment / push 新 segment（已实现）                                                                                                                                                                                                |
| `tool_call`                                    | push `{kind:'tool', status:'in_progress', ...}`，登记 `toolSegmentIndex.set(id, idx)`                                                                                                                                                                 |
| `tool_call_update`                             | 按 id 取 segment，浅 merge；`content` / `locations` 整体替换                                                                                                                                                                                          |
| `plan`                                         | 若 `planSegmentIdx` 存在，**原地替换**那条 segment 的 entries；否则 push 新 plan segment 并记录 idx                                                                                                                                                   |
| `tool_start` / `tool_result`（internal agent） | **wire 不动**——server 端 internal agent 继续发旧事件；client `useAgentStream` 内做 adapter，把这两条翻译成与 `tool_call` / `tool_call_update` 同构的 `kind:'tool'` segment（共用 `toolSegmentIndex` 这套聚合管线）。删掉 `role:'tool'` 顶层 message。 |
| `done`                                         | 清空 turn-scope 的两个 lookup                                                                                                                                                                                                                         |

> **双轨 wire / 单轨 store** 的设计取舍：保留旧 SSE 事件可以让 PR-3 完全不动 internal agent 的 server 侧（[`apps/server/src/modules/agent/agent.service.ts`](../apps/server/src/modules/agent/agent.service.ts) / runner 都不用改），代价是 client 多一层 ~30 行的 adapter。未来 internal agent 自己迁到 `tool_call` / `tool_call_update` 后，adapter 与旧事件常量一起删。
>
> Adapter 的最小映射：
>
> - `tool_start { toolCallId?, toolName, toolArgs }` →
>   `tool_call { toolCallId: toolCallId ?? createId('tool'), title: toolName, kind: 'other', status: 'in_progress', rawInput: toolArgs, internalToolName: assertInternal(toolName) }`
> - `tool_result { toolCallId, toolResponse }` →
>   `tool_call_update { toolCallId, status: toolResponse.status === 'success' ? 'completed' : 'failed', rawOutput: toolResponse.data, internalToolData: toolResponse.data }`
>   - `assertInternal(name)`：在 `InternalAgentToolName` 白名单内返回 name，否则返回 undefined（退化为通用 ACP 路径渲染，非错误）。
> - 缺 `toolCallId` 的旧事件按 FIFO 队列回填（沿用现有 [`useAgentStream.ts`](../apps/web/src/hooks/useAgentStream.ts) 的 `toolQueue.fifo` 兜底）。

**分组键升级**：原「相邻 `kind:'tool' && toolKind` 相同」**改为**「相邻 `kind:'tool' && internalToolName` 相同；`internalToolName === undefined`（纯 ACP）一律单独成组」。理由：`toolKind` 是 ACP 协议层语义（read/edit/…），多个无关 ACP tool 都是 `read` 不该被合成一行；`internalToolName` 是同一个具体工具的多次调用（"Inspected 3 nodes" / "Grep ×2"），合并语义才正确。

### 4.3 UI 组件

> **核心原则**：**`internalToolName` 命中 → 走旧组件**（`CanvasCommandCard` / `WebSearchToolDisplay` / `MergedAgentToolRow`，body 不删不改），保留 NodeRef / canvasChanges preview / revert / per-tool 标题等 Sediment 自家产品价值；**未命中（纯 ACP）→ 走新 `ToolCallCard`**（通用 kind 图标 + ToolCallContent 分派）。

- **保留组件（不删，迁位置 / 改 props 签名）**：[`ToolMessage.tsx`](../apps/web/src/components/Messages/ToolMessage.tsx) 现有 `ToolMessageGroup` / `CanvasCommandCard` / `WebSearchToolDisplay` / `MergedAgentToolRow` / `reconstructChangesFromCommands` 全部**保留**。差异只有：
  - **入参**：`ToolEntry { messageId, toolResponse, isExecuting }` → `ToolPart { messageId, part: AssistantPart & { kind: 'tool' } }`。内部用 `part.internalToolData` 替原 `toolResponse.data`、`part.status === 'in_progress'` 替原 `isExecuting`、`part.status === 'failed'` 替原 `toolResponse.status === 'error'`。
  - **挂载点**：从 `MessageList` 顶层挪到 `AIMessage` 内部（§4.4）。
  - **store 操作**：`CanvasCommandCard` 现在通过 `useChatStore.updateMessage` 改 `m.toolResponse.data.canvasChanges` 的路径，改为定位到 `m.parts[i].internalToolData.canvasChanges` —— chatStore 加新 action `updateAssistantToolPart(messageId, toolCallId, updater)`，PR-3 内同步完成。

- **`ToolCallCard`**（`apps/web/src/components/Messages/ToolCallCard.tsx`，新增，**仅服务无 `internalToolName` 的纯 ACP tool**）
  - 头部：`ToolKindIcon` 按 `toolKind` 取图标 + `title` + 状态指示（pending/灰、in_progress/spinner + `text-info`、completed/`text-success`、failed/`text-danger`）+ 右侧 `locations[0].path:line`（多个显示 `+N`）+ `permission.outcome?.type === 'allowed' && optionId === 'auto'` 时 `text-fg-subtle` 的 "auto-allowed" 文本徽章（供 metric 评估，PR-4 真 UI 之前临时显示）。
  - 默认 in_progress 展开、completed 折叠、failed 展开。
  - body 按 `ToolCallContent.type` 分派：
    - `content + text` → 轻量 markdown（不走 Milkdown）；
    - `content + resource_link` → 文件链接卡（v1 仅 `console.log`，Phase 4 与 canvas binding 联动）；
    - `content + image` → `<img>`；
    - `content + audio` → "Audio playback not supported in v1"（§2.2 SDK 多出的 variant 兜底）；
    - `diff` → 最小化 unified-diff text（TODO: Monaco DiffEditor）；
    - `terminal` → "Terminal embedding disabled in v1"。
  - a11y：`role="group"`，状态变化 `aria-live="polite"`。

- **`PlanCard`**（`apps/web/src/components/Messages/PlanCard.tsx`，新增）
  - 头部：`Plan` 标题 + `completed/total` 进度。
  - 每行：状态图标（`○` pending / `▸` in_progress + spinner / `✔` completed）+ 内容 + 优先级 pill。
  - 默认展开；语义 token：pending=`text-fg-muted` / in_progress=`text-info` / completed=`text-success`；priority pill 用 `info`/`warning`/`subtle` 色阶，不用 raw 颜色。
  - a11y：外层 `role="list"`，每行 `role="listitem"`，进度数字 `aria-label`。

- **`ToolKindIcon`**（`apps/web/src/config/toolIcons.ts`，新增）
  - `read=FileText, edit=Pencil, delete=Trash, move=MoveRight, search=Search, execute=Terminal, think=Brain, fetch=Download, switch_mode=SlidersHorizontal, other=Wrench`。
  - fallback 启发式（§0.5 S2 要求）：`title` 含 `read|view|cat|inspect` → `read`；`edit|write|modify|patch` → `edit`；`bash|exec|run|shell` → `execute`；`search|find|grep` → `search`；都不命中 → `other`。

### 4.4 `AIMessage` 渲染分派

按 `parts` 顺序 map，`kind:'tool'` 先按 `internalToolName` 路由：

```tsx
// groupAdjacentToolParts: ~20 行纯函数，把相邻同 internalToolName 的 tool parts 折成 group；
// non-tool parts 与 internalToolName=undefined 的 tool parts 一律单独成组。
const groups = groupAdjacentToolParts(parts);

groups.map((g, i) => {
  if (g.kind === 'non-tool') {
    const p = g.part;
    switch (p.kind) {
      case 'text':     return <MilkdownMessageCard key={i} content={p.text} />;
      case 'thinking': return <ThinkingCard key={i} text={p.text} isStreaming={...} />;
      case 'plan':     return <PlanCard key={i} entries={p.entries} />;
    }
  }
  // tool group：按 internalToolName 穷举式 narrow（新工具上线 TS 会报漏分派）
  switch (g.internalToolName) {
    case 'canvas_commands':
      return g.parts.map((p) => <CanvasCommandCard key={p.toolCallId} part={p} />);
    case 'web_search':
      return g.parts.map((p) => <WebSearchToolDisplay key={p.toolCallId} part={p} />);
    case 'read': case 'grep': case 'find': case 'ls':
    case 'inspect_nodes': case 'get_canvas_outline':
      return <MergedAgentToolRow key={i} tool={g.internalToolName} parts={g.parts} />;
    case undefined:
      // 纯 ACP tool（外部 agent）→ 通用 ToolCallCard
      return g.parts.map((p) => <ToolCallCard key={p.toolCallId} part={p} />);
  }
});
```

`groupAdjacentToolParts` 单测覆盖 4 个典型序列（§6 PR-3）：（a）全 internal 同名连续；（b）internal 混合外部 ACP；（c）纯 ACP；（d）text/thinking 间插 tool。

### 4.5 删除 / 简化

- `MessageList` 的 `role: 'tool'` 分支删除；分组改由 `AIMessage` 内 `groupAdjacentToolParts` 完成（§4.4）。
- `useSketchClusterMessages`、`useChatHistory` 改为产出 parts。
- `assistantMessageText` 继续只取 `kind:'text'` 段，**仅**用于 copy / "add as note"——历史序列化走 `parts` 本身，不再借这个函数。两个使用场景都明确只要纯文本：copy 不应含 thinking / tool output / plan；note 是把 AI 的最终回答作为知识沉淀，过程产物不该进 note。

**不删的（容易误删，明列）**：

- [`ToolMessage.tsx`](../apps/web/src/components/Messages/ToolMessage.tsx) 的 `CanvasCommandCard` / `WebSearchToolDisplay` / `MergedAgentToolRow` / `reconstructChangesFromCommands` / [`useCanvasChangePreview`](../apps/web/src/hooks/useCanvasChanges.ts) —— 全部保留，仅改 props 签名（详见 §4.3）。
- `ToolMessageGroup` 这个外层 group wrapper 可以删（被 `groupAdjacentToolParts` + AIMessage 分派取代），但内部三个 per-tool 组件**必须保留**。
- `useChatStore.updateMessage` —— 保留为通用 store action；`CanvasCommandCard` 改用更精准的新 action `updateAssistantToolPart(messageId, toolCallId, updater)`，避免误改其他 part。

---

## 5. PR 拆分与落地顺序

| PR       | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 可独立合入             |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| **PR-1** | **引入 `@agentclientprotocol/sdk@^0.22.1`** 到 `packages/shared`，§2.2 改为 SDK re-export（type 与 zod 分文件，permission 类型一并 re-export 备 PR-4 用）+ web bundle 卫生 vitest；shared `AssistantPart` / `AssistantHistoryPart` 的 `kind:'tool'` variant 加 `internalToolName?: InternalAgentToolName` + `internalToolData?: unknown` + `permission?: ToolPermissionState` 三字段（§1/§2.4）；shared 新增三个 `AgentStreamEvent` variant 的 wire 包装 schema（~30 行，§2.3）；translator 三个 case 在出口 `ZAcpSessionUpdate.safeParse`，同时加 `kind == null` 计数器 + info 日志供后续 metric 评估；translator 写 `tool` part 时把 ACP auto-allow 的 permission outcome 预填进 part（§7 #6）。**Sidecar 持久化（新 §3.2）**：`apps/server/src/modules/agent/store/` 下新增 `chat-parts-store.ts`，ACP `tool_call_update` 的扩展字段 + `plan` + `permission` 写入 `<canvasId>/.history/chat/<threadId>.parts.json`；pi-ai Context 只写 pi-ai 原生 union 允许的 `ToolCall` 三字段；`internalToolData` **不入 sidecar**（从 pi-ai `ToolResultMessage` 重建，§3.2/§3.3）。**vitest 必覆盖**：（1）pi-ai resume / streaming 不重排 `messages` 数组，`messageIndex` 稳定；（2）sidecar / Context 二者崩溃后退化路径（3 种场景：sidecar 缺失、Context 缺失、messageIndex 不匹配）；（3）translator + schema 单测；（4）web bundle 不含 SDK runtime；（5）translator 对 auto-allow permission 的预填正确写入 sidecar、buildHistoryItems 重建后 `permission.outcome` 完整；（6）`internalToolName` / `internalToolData` 经 buildHistoryItems 重建后等于原 `ToolResponse.data`（含 `canvas_commands` 大 payload 用例）。**同时提交 S3 文档同步**：huabu-acp-client-plan §2.3 表格 + agent-architecture 事件清单。 | ✅                     |
| **PR-2** | `ChatHistoryItem` parts 化（§2.4）+ `buildHistoryItems` 翻译器 + pi-ai plan block 持久化补齐。**`useChatHistory` 走 reverse-adapter**：wire 已是 parts，但 hook 内部把 parts 拆回 `role:'tool'` 顶层消息塞进 store，保持 client store schema 与 PR-3 之前完全一致；PR-3 时连同 adapter 一起撤掉，避免 PR-2 阶段「live = 顶层 tool / 历史 = parts」的形状漂移。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | ✅                     |
| **PR-3** | `useAgentStream` 把 ACP 三类事件 + internal `tool_start/tool_result` 统一聚合进 `assistant.parts`；删 `role:'tool'` 顶层 message；新增 `ToolCallCard` + `PlanCard`；`MessageList` 简化。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | ✅（合并后改动面最大） |
| **PR-4** | `locations` 点击 follow-along；**`session/request_permission` 全套**：新增 SSE event `permission_request`（server→web）+ HTTP endpoint `POST /agent/permission/:requestId/respond`（web→server）；[client.ts](../apps/server/src/modules/agent/acp/client.ts) 的 auto-allow 改为「先 SSE 请 web 决定 → 超时回退 auto-allow」；UI 在 `ToolCallCard` / `CanvasCommandCard` 头部 pending 锁图标处展开 allow/deny 控件；persist outcome 进 PR-1 已开槽的 `permission.outcome` 字段（**无 wire/sidecar schema 变更**）。与 ACP Phase 3 PR I 合并。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | ✅                     |
| **PR-5** | rich content：Monaco DiffEditor 接入；`resource_link` 与 canvas 节点 binding；terminal embed（若开启 capability）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | ✅                     |

> PR-1 / PR-2 合入后，**当前 thinking PR 的 #3「持久化 thinking」自然解决**——server 端本来就存了，只是 wire 不再拍平。

---

## 6. 测试策略

- **PR-1**：translator 单测 — mock 各种 `SessionUpdate` payload → 期望 `AgentStreamEvent`；覆盖 `tool_call_update` 的"缺省字段不变 / `content` 整体替换"两条规则。
- **PR-2**：`buildHistoryItems` 单测 — 构造含 thinking / toolCall / plan blocks 的 pi-ai Context → 期望 parts 顺序无损。
- **PR-3**：`useAgentStream` 聚合测试 — 顺序灌入事件序列（含乱序 `tool_call_update`、同 turn 多个 `plan`、internal `tool_start/tool_result`、adapter 写入 `internalToolName` / `internalToolData`）→ 检查最终 `assistant.parts` 形状；`groupAdjacentToolParts` 4 个典型序列单测（§4.4）；snapshot 覆盖 `AIMessage` 内 ACP-only `ToolCallCard` / internal `CanvasCommandCard` / `MergedAgentToolRow` / mixed sequence 四条分派路径。
- 浏览器手测：claude-code agent 真实跑一次 read+edit+plan turn，确认 follow-along / 折叠 / 进度条无回退。

---

## 7. 决策结论

1. **plan 在 turn 内作为 part。**
   - 归属清晰、与 ACP 时序一致；不作顶层悬浮。
2. ~~**是否把 internal `tool_start/tool_result` 一并迁到 `kind:'tool'` segment？**~~ **wire 双轨 / client 单轨 via adapter。**
   - 结论：wire 上保留旧 `tool_start` / `tool_result` 事件不动，server 侧 internal agent 不改；client 在 `useAgentStream` 加 ~30 行 adapter 把旧事件折叠进同一套 `toolSegmentIndex` 聚合管线（详见 §4.2 表格下方说明）。
   - 好处：PR-3 不触碰 internal agent 的 server 实现，回退面小；store 仍然单一真相。
   - 后续：等 internal agent 也迁到 `tool_call` / `tool_call_update` 后，统一删 adapter + 旧事件常量。
3. **`terminal` content 走占位渲染。**
   - v1 不开 terminal capability，但 `AcpToolCallContent` 保留 `terminal` type；渲染占位文案建议「_Terminal embedding disabled in v1_」以阐明是产品限制、不是 bug。
4. **`available_commands_update` 不纳入本轮（已实现，与本计划正交）。**
   - 该事件使命是推送 slash command 元数据，与 assistant.parts 模型无关；server 侧已在 [`apps/server/src/modules/agent/acp/service.ts`](../apps/server/src/modules/agent/acp/service.ts) 落到 session-registry 的 `availableCommands`，有完整单测 + CHANGELOG 记录。
5. **`plan` 多次快照不保留历史，就地替换。**
   - turn 内永远只有 0 或 1 条 plan segment（**scope = turn-scoped**；ACP spec 不强制 scope，session-scoped 是已知备选，若未来产品定位偏长任务可改为 thread-scoped `Map<threadId, planEntries>`）。未来若有「plan 演化动画」需求，另开新的 `kind:'plan_snapshot'` part，**不仅仅是「允许多条 plan 共存」**这种模糊语义——避免后续语义滑坡。
6. **`session/request_permission`：本计划只做数据模型预留，不做 UI。**
   - PR-1 在 `AssistantPart.kind:'tool'` 与 sidecar `tool_acp_ext.extension` 加 `permission?: ToolPermissionState` 字段，SDK 的 `PermissionOption` / `PermissionOptionKind` / `RequestPermissionRequest` / `RequestPermissionResponse` 一并 re-export 备用（§2.2）。
   - PR-1/2/3 期间 server 端 [client.ts](../apps/server/src/modules/agent/acp/client.ts) 维持 **auto-allow**（现状由 `pickPermissionOption` 决定 optionId），translator 写 `tool` part 时把 `permission.outcome` 预填为 `{ type: 'allowed', optionId: <pickPermissionOption 结果>, resolvedAt = requestedAt }`，UI 显示 "auto-allowed" 徽章供 metric 评估。
   - PR-4 才加 **wire event `permission_request`**（server→web）+ **HTTP endpoint `POST /agent/permission/:requestId/respond`**（web→server），把 client.ts 的 auto-allow 改为「先 SSE 请 web 决定 → 超时回退 auto-allow」。届时 part 字段 / sidecar schema 不动，`outcome` 从「PR-1 默认填 allowed」变成「PR-4 真实 user choice」。
   - 这样**接口一次到位**，PR-4 仅加事件回路与 UI 控件，零 schema 漂移。
7. **`internalToolName` 是 Sediment 自家 nominal union（不暴露给 ACP 协议层）。**
   - union 显式列出当前 8 个工具（与 [tools/definitions.ts](../apps/server/src/modules/agent/tools/definitions.ts) 对齐：`read` / `grep` / `find` / `ls` / `inspect_nodes` / `get_canvas_outline` / `canvas_commands` / `web_search`）；扩工具时同步加 union 成员 + §4.4 UI 分派 case。
   - ACP 模式下 `internalToolName` 恒为 undefined，wire 上 ACP server 不会看到这些字段。
   - 不用 `string` 是为了让 §4.4 的 `switch (name)` 是穷举式 narrow，新工具上线 TS 编译器会主动报漏分派——避免 UI 静默回退到 fallback `ToolCallCard` 且无人发现。

---

## 8. 已知风险

- **Sidecar 与 pi-ai Context 的事务一致性**：两个 JSON 文件是两次独立 atomic write，中间崩溃会造成片面一致（sidecar 有但 Context 旧、或反之）。**不引入跨文件事务**；sidecar 丢失退化为「只剩基础 ToolCall / 无 plan」，UI 能展示不报错。`buildHistoryItems` 必须容忘 sidecar 缺失且加单测。
- **`messageIndex` 依赖 pi-ai append-only**：若 pi-ai 未来某个版本在中间重排 / 去重 / splice `Context.messages`，sidecar 关联全部错位。PR-1 必加 vitest 实际跳动 pi-ai 现有版本验证；pi-ai bump 时需重跑该测试。Sidecar 里冗余写 `messageTimestamps` 作 sanity check，读时不一致则 warn。
- **`role:'tool'` 顶层消息删除**：需要扫一遍所有引用（`useSketchClusterMessages` / 任何 store selectors），避免漏改。PR-3 前可先以 grep `role.*'tool'` 起一份变更清单。
- **wire 不向后兼容**：PR-2 一旦合入，旧版客户端连新服务端会拿不到 assistant.content 字符串。**推荐双发过渡**：PR-2 server 同时返回 `content: string`（legacy）和 `parts`（new），client 优先 parts；下个 minor 刪 content。避免「用户旧 web tab 连新 server 立刻白屏」。
- **旧 `chat/<threadId>.json` 反序列化容忘**：老 thread 没有 sidecar，读时需按「缺失 = 空」处理，不要报错。老 thread 也不会有 plan 或 ACP 扩展字段重现——不提供迷踪脚本，避免用户误期待。
- **evals / agentlet 影响面**：[evals/trace.ts](../apps/server/evals/trace.ts) import pi-ai `Context`——`Context` 形状本轮不变，但 `buildHistoryItems` 输出形状变了，需检查 evals fixture。[external/agentlet/](../external/agentlet/) 若消费 `@sediment/shared` 的 wire 类型需同步发版。
- **`@agentclientprotocol/sdk` 升级管理**：SDK 版本与 ACP wire 协议版本是两套独立 SemVer（详见 [SDK README](https://github.com/agentclientprotocol/typescript-sdk#versioning)）。bump SDK 时必读 CHANGELOG —— 重点看 `types.gen.ts` 的 ContentBlock / ToolCallContent variants 增减、`SessionUpdate` 新成员。建议固定到 caret `^0.22.x`、在 renovate 配置里把该包标记为 minor-only 自动合并、major 手动审。配套加一条 vitest 守门：`expect(Object.keys(zSessionUpdate.options).length).toBe(N)` —— bump 后若多出 update 类型，强制评估是否要在 translator 加 case。
- **Context.messages 体积**：tool content 含 image base64 / diff 大文件时，单条 turn 存档会膨胀（这里指 sidecar，不是 pi-ai Context——后者原样干净）。
  - **v1（PR-2/PR-3）**：仅在 translator 入口加一条 per-event 硬上限（建议 1MB），超限就把 `content` 字段换成 `[{type:'content', content:{type:'text', text:'[content too large, omitted]'}}]` 占位，`status` / `locations` / `title` 照常推。零类型改动、零迁移成本。
  - **后续（PR-5）**：真正的 artifact ref 化与 Monaco DiffEditor / `resource_link` ↔ canvas binding 一并做，复用 `apps/server/src/modules/storage/` 既有机制——`ToolCallContent` 增加可选 `bodyRef?: string`，UI 按需 lazy fetch。届时只需把 v1 的"丢弃"分支换成"转存"，类型 / UI / 聚合逻辑都不动。
  - **LLM 上下文层独立处理**：`buildHistoryItems` → provider 之间的窗口策略（近 K 轮全文 / 更早只留摘要 / image strip 成占位）不依赖 artifact ref，可独立演进。
