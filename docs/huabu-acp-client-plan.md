# Huabu as ACP Client — Implementation Plan

> Huabu 作为 ACP **client**，通过 [agentlet](https://github.com/hai-team/agentlet)
> 连接到外部 ACP 兼容 agent（Claude Code / Copilot CLI / Gemini CLI ...）。
>
> **External-agent 接入唯一路径**：ACP。早期讨论过的 copilot-sdk / claude-cli / generic-cli
> 三种 subprocess adapter 不再实现。
>
> Status: **Draft** · Last updated 2026-05-25 (round 2)
>
> 更新记录：
>
> - 2026-05-22 初稿
> - 2026-05-25 补 Phase 2 设计决策（D1–D4）+ Phase 3 Plan B 优化
> - 2026-05-25 (round 2) **架构方向调整**：1 thread = 1 agent 绑定 + preprocessor pipeline，废弃 @mention 路由模型。D1–D4 / Plan B 段落折叠归档，新 Phase 2 PR 拆分见 §5

---

## 0. TL;DR — 你需要做的事

1. **架构决策**：embed `@agentlet/server` 进 Sediment 的 Fastify app
2. **绑定模型**：每个 chat thread 在创建时绑定**唯一** agent（内部 huabu 或某个 external）。**1 thread = 1 ACP session**（持久，thread 关闭才回收）。绑定不可在 thread 内修改——切换 agent 即 implicit New conversation
3. **Preprocessor pipeline（核心新组件）**：当 thread 绑定到外部 agent 时，每条用户消息先经 Huabu 内部 LLM 重写为结构化 `ExternalAgentPrompt`（`task` + `fileRefs[{path, reason?}]`），再发给外部 agent。外部 agent 用自己的 Read tool 按需拉取节点内容
4. **v1 read-only 模式**：外部 agent 只读 `<canvasDir>/canvas.json` + `nodes/**` + `.artifacts/**`。无 fs 写、无 terminal——靠 capability 沙箱强制
5. **新增模块** `apps/server/src/modules/agent/acp/`：
   - `server-mount.ts` / `token-store.ts` / `agents.route.ts`（Phase 0/1/PR A 已完成）
   - `client.ts`（AcpAgentClient · 1 thread = 1 session）/ `service.ts`（runAcpAgent）/ `translator.ts` / `session-registry.ts`
   - `preprocessor.ts`（核心：rawMsg + canvas → ExternalAgentPrompt）
   - `capabilities/fs.ts` read-only / `capabilities/permission.ts`（Phase 3）
6. **UI 改动**：扩展现有 [ModeSelector](../apps/web/src/components/Panels/ChatPanel/ModeSelector.tsx) pill 下拉——把 connected external agents 列在 Ask/Agent 之后；空 thread 切换自由，非空 thread 切换触发 implicit New conversation。**删除** PR A 的 `ConnectedAgentsBar`
7. **协议事件翻译**：ACP `session/update` ↔ Sediment `AgentStreamEvent`；新增 `prepared_prompt` SSE event（前端展示折叠卡片）
8. **路由层**：`agent.route.ts` 读 request 里的 `agentBinding` 分流到 `runAgent` / `runAcpAgent`
9. **跟 agentlet 团队协调**：v1 embedded 模式**不需要** `@agentlet/client` SDK

---

## 1. 现状盘点（节省后续返工）

### 1.1 agentlet 已经做完的事

| Component            | 提供能力                                                                                | Huabu 怎么用                                                            |
| -------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `agentlet` CLI       | 在用户机器 spawn ACP agent，stdio↔WSS 中继，断线重连，buffer 重放                       | **用户自己装**，指向 Huabu 的 bridge endpoint                           |
| `@agentlet/server`   | WS 服务端：bridge endpoint 接 agentlet、host endpoint 接 Huabu；连接注册表（`agentId`） | **embed 到 Fastify**，Huabu 用 TS API 直接拿 connection                 |
| `@agentlet/protocol` | 共享类型（BridgeMethods、`AgentConnection` 等）                                         | 直接 import                                                             |
| `@agentlet/ui`       | Vue 3 reference 实现，**已经写好了 ACP 客户端状态机**                                   | 抄它的 `packages/ui/src/stores/session.ts` 作为 server 端 client 的蓝本 |
| `@agentlet/client`   | host-side SDK                                                                           | 文档提到但 repo 里没看到——**得跟 agentlet 团队确认**                    |

**结论**：Huabu 不用碰 stdio / WS reconnect / agentId / 进程生命周期。这些都已经解决。

### 1.2 Sediment 现状

| 组件              | 现状                                                                           | 涉及文件                                                                       |
| ----------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Agent loop        | pi-agent-core 跑内置 9 个 tool；SSE `AgentStreamEvent` 协议成熟                | [agent.service.ts](../apps/server/src/modules/agent/agent.service.ts)          |
| External agent    | **未实现**——磁盘上有 `data/external-agents.json` 桩文件但代码没接入            | —                                                                              |
| @mention 路由     | **不再做**——新模型走 thread 级 binding（见 §5 Phase 2）；message 没有 `@` 概念 | [agent.route.ts](../apps/server/src/modules/agent/agent.route.ts)              |
| Code-repo binding | **未实现**——canvas 跟代码仓库还没关联机制                                      | —                                                                              |
| SSE 路由          | 现成的 streaming + abort + reconnect-resume 机制                               | [agent.route.ts](../apps/server/src/modules/agent/agent.route.ts)              |
| Sandbox 工具      | `safeResolve` / `walk` 用于内置 fs 工具                                        | [fs-sandbox.ts](../apps/server/src/modules/agent/tools/handlers/fs-sandbox.ts) |

**关键认知**：external agent 这块是**白纸**——可以直接为 ACP 量身设计，不用兼容任何老路径。
架构比要兼容 multi-adapter 时简单得多：**不需要 `ExternalAgentAdapter` 抽象**，只需要一个 ACP service。

---

## 2. 架构决策

### 2.1 Embedded vs Standalone（首要决策）

|                  | Embedded（推荐）                                                       | Standalone                                                   |
| ---------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------ |
| 怎么做           | Sediment Fastify import `@agentlet/server`，mount 到 `/api/agentlet/*` | 用户独立跑 `agentlet-server`，Sediment 作 host client 远程连 |
| 网络拓扑         | 单一进程，零网络跳跃                                                   | 两进程，host↔server↔bridge 都过网络                          |
| 部署复杂度       | 跟 Sediment server 一起起                                              | 多一个 daemon                                                |
| 多用户           | 跟 Sediment 共享同一鉴权域                                             | 可独立认证、独立伸缩                                         |
| 用户拿 token     | Sediment UI 直接生成                                                   | UI 流要跨两个 server                                         |
| Agentlet UI 复用 | 不复用（Sediment 有自己的 chat UI）                                    | 可选地继续提供                                               |
| **v1 推荐**      | ✅                                                                     | ❌                                                           |

**v1 用 embedded**，理由：

1. 部署最简单——用户启动 Sediment server，bridge endpoint 自动就在了
2. token 管理在一个地方（用 Sediment 自己的用户/会话体系，比如绑到 canvas）
3. 单 process 内 in-memory `AgentConnection` registry，host 调 agent 没有额外延迟
4. 将来要拆 standalone 也简单（agentlet 已经支持两种模式，业务逻辑没变）

### 2.2 ACP client 跑在哪个 process

```
┌──────────────────────────────────────────────────────┐
│  Sediment Server (Fastify, embed agentlet)            │
│                                                       │
│   agent.route.ts                                      │
│        │  request.agentBinding.kind?                  │
│        │    'internal' → runAgent()                   │
│        │    'external' → runAcpAgent()                │
│        ▼                                              │
│   ┌──────────────────────────────────────────────┐   │
│   │  runAcpAgent()  (acp/service.ts)              │   │
│   │   ├─ preprocessor (acp/preprocessor.ts)       │   │
│   │   │    rawMsg + canvas → ExternalAgentPrompt  │   │
│   │   │    (yield 'prepared_prompt' SSE)          │   │
│   │   ├─ session-registry (threadId → session)    │   │
│   │   └─ AcpAgentClient  (acp/client.ts)          │   │
│   │        │ ACP JSON-RPC over AgentConnection   │   │
│   │        ▼                                      │   │
│   │      AgentConnection (来自 @agentlet/server)  │   │
│   └──────────────────────────────────────────────┘   │
│                       ▲                               │
│              host-side TS API                         │
│                       │                               │
│   ┌──────────────────────────────────────────────┐   │
│   │  @agentlet/server (embedded)                  │   │
│   │   - bridge WS endpoint /api/acp/agent         │   │
│   │   - connection registry                       │   │
│   └────────────────┬─────────────────────────────┘   │
└────────────────────┼─────────────────────────────────┘
                     │ WSS（用户机器 → Sediment）
                     ▼
            ┌─────────────────┐
            │  agentlet CLI   │  ← 用户自己装、自己跑
            │   (用户机器)     │
            └────────┬────────┘
                     │ stdio
                     ▼
            ┌─────────────────┐
            │  ACP Agent      │  ← claude --acp / copilot --acp / ...
            └─────────────────┘
```

**关键边界**：

- agentlet 团队负责：spawn agent、stdio↔WSS、reconnect、`agentId`、buffer 重放
- Sediment 负责：ACP 客户端语义（initialize / session/new / session/prompt）、`session/update` → SSE 翻译、client-side capabilities 实现、canvas sandbox

---

## 3. 必须新增的代码（具体清单）

### 3.1 模块结构

```
apps/server/src/modules/agent/acp/
├── README.md                ← 设计说明
├── server-mount.ts          ← (Phase 1 ✅) embed @agentlet/server 到 Fastify
├── token-store.ts           ← (Phase 1 ✅) Sediment 自己的 token 颁发/验证（绑到 canvas）
├── agents.route.ts          ← (PR A ✅) GET /api/acp/agents 暴露连接列表
├── client.ts                ← (PR C) AcpAgentClient — 1 thread = 1 ACP session（持久）
├── service.ts               ← (PR C) runAcpAgent() 入口，跟 runAgent() 平行
├── translator.ts            ← (PR C) session/update ↔ AgentStreamEvent
├── session-registry.ts      ← (PR C) threadId → AcpSession 映射（in-memory + thread-close 时清理）
├── preprocessor.ts          ← (PR D) **核心**：rawMsg + canvas state → ExternalAgentPrompt
├── repo-binding.ts          ← Phase 4：canvas ↔ code repo cwd resolver
├── capabilities/
│   ├── fs.ts                ← Phase 3：fs/read_text_file（**v1 read-only**，nodes/artifacts/canvas.json 之外拒绝）
│   └── permission.ts        ← Phase 3：permission/request → Sediment UI 弹窗
└── types.ts                 ← 内部类型

# Layer 3 走独立模块（Phase 5，可选）：
apps/server/src/modules/agent/mcp/
├── server.ts                ← Huabu as MCP server（HTTP 或 stdio transport）
└── tools.ts                 ← 把 9 个内置 tool 的 schema 注册成 MCP tool
```

**已弃用模块**（旧 @mention 模型遗留，新模型不再实现）：`context-injector.ts`（被 `preprocessor.ts` 取代）、`session-cache.ts` / Plan B（1 thread = 1 session 持久化后无意义）。

### 3.2 `AcpAgentClient`（核心，最大块）

负责跟单个 `AgentConnection` 维护一次 ACP 会话生命周期。

参考 [agentlet 的 ui/src/stores/session.ts](../../../agentlet/packages/ui/src/stores/session.ts)——
它已经写好了 server→client 一侧的协议处理，**几乎可以直接搬到 server 端**，主要区别：

| ui/stores/session.ts       | AcpAgentClient（server 端）                                                 |
| -------------------------- | --------------------------------------------------------------------------- |
| Vue ref 存状态             | 普通 class 实例，状态字段                                                   |
| 直接更新 UI                | yield `AgentStreamEvent` 给上游                                             |
| transport 是 WS 客户端     | transport 是 `AgentConnection` 的 `send` / message callback                 |
| 单 session                 | **1 thread = 1 持久 session**（本文核心决策），多 thread 则起多实例         |
| 不实现 client capabilities | Phase 3 必须实现 `fs/read_text_file` + `permission/request`（v1 read-only） |

简化的接口：

```ts
class AcpAgentClient {
  constructor(
    private connection: AgentConnection,
    private opts: {
      onEvent: (e: AgentStreamEvent) => void
      onClientRequest: (method: string, params: unknown) => Promise<unknown>
      cwd: string
      canvasId?: string
    }
  )

  async initialize(): Promise<void>           // 发 initialize，处理 result
  async newSession(): Promise<string>         // 发 session/new，返回 sessionId
  async prompt(text: string, signal?: AbortSignal): Promise<void>
                                              // 发 session/prompt，期间把 session/update 翻成 onEvent
  async cancel(): Promise<void>               // 发 session/cancel
  async shutdown(): Promise<void>             // 清理
}
```

### 3.3 `runAcpAgent()`——跟 `runAgent()` 平行的入口

chat route 读 `request.agentBinding`：`kind:'internal'` 走 `runAgent`，`kind:'external'` 走 `runAcpAgent`。
两者签名一致，**SSE 路由、abort 机制、reconnect-resume 全不改**。

```ts
// apps/server/src/modules/agent/acp/service.ts
export interface AcpRunOptions {
  threadId: string; // 查 session-registry 的 key
  agentBinding: AgentBindingExternal; // { kind:'external', alias, agentletAgentId }
  prompt: string; // raw user message（preprocessor 在 service 内部调）
  canvasId: string;
  selectedNodeIds?: string[]; // 当前 canvas 选中的节点（作为 hint 传给 preprocessor）
  signal?: AbortSignal;
  agentletServer: AgentletServer;
  sessionRegistry: SessionRegistry;
}

export async function* runAcpAgent(
  opts: AcpRunOptions,
): AsyncGenerator<AgentStreamEvent, void, unknown> {
  // 1. 查/建 AcpSession（1 thread = 1 持久 session）
  const session = await opts.sessionRegistry.getOrCreate({
    threadId: opts.threadId,
    agentBinding: opts.agentBinding,
    canvasId: opts.canvasId,
    agentletServer: opts.agentletServer,
  });

  // 2. 调 preprocessor
  const prepared = await preprocess({
    rawUserMessage: opts.prompt,
    canvasId: opts.canvasId,
    selectedNodeIds: opts.selectedNodeIds,
    recentHistory: await loadRecentHistory(opts.threadId),
    boundAgentAlias: opts.agentBinding.alias,
  });

  // 3. yield prepared_prompt event（前端展示折叠卡片）
  yield { type: 'prepared_prompt', data: prepared };

  // 4. 调 ACP（复用持久 session）
  yield* session.client.prompt(prepared.toAcpText(), opts.signal);
}
```

**设计要点**：

- `sessionRegistry.getOrCreate` 里面负责判定是否需要 `client.initialize()` + `client.newSession()`（首次），后续 thread 复用。
- preprocessor 出错时默认 fallback：在 `prepared` 里记一个 `fallbackReason`，`toAcpText()` 返原始 `rawUserMessage`（v1 策略，见 N13）。
- **不实现 `ExternalAgentAdapter`** 之类的抽象接口。external agent 只有 ACP 一条路，service 函数比 adapter 抽象更直接、更易测。

### 3.4 Client-side capabilities（**安全关键**）

ACP 的双向性意味着 agent 会主动**调** client 暴露的方法。Sediment 必须实现并**鉴权**这些方法。

**v1 read-only 原则**：外部 agent 只读 canvas 资产，没有任何写、没有 terminal。写能力推到 Phase 4 + code repo 绑定之后。

| ACP 方法                      | Sediment v1 实现                                                                                                | 沙箱                                                |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `fs/read_text_file`           | 走 [fs-sandbox.ts](../apps/server/src/modules/agent/tools/handlers/fs-sandbox.ts) 的 `safeResolve(canvasId, …)` | 只允许 `canvas.json` + `nodes/**` + `.artifacts/**` |
| `fs/write_text_file`          | **v1 直接返 ACP error**（读只模式）。Phase 4 上 code repo 后才开启对 cwd 的写                                   | 返错                                                |
| `terminal/*`                  | **不实现** — LLM 在你 server 上跑 bash 太危险                                                                   | 不开                                                |
| `permission/request`          | Phase 3：推送到 Sediment UI（reuse 现有 confirm 流）。v1 阶段因为无写动作不会被调到                             | 用户点确认                                          |
| ~~自定义 `huabu/*` ACP 方法~~ | **不走 ACP** — 见 §3.6 Layer 3，改用 MCP server                                                                 | Phase 5                                             |

**沙箱原则**：

- canvas 资产（`<workspace>/<canvasDir>/canvas.json` + `nodes/**` + `.artifacts/**`）→ 走 `safeResolve` + `canvasId`，**只读**
- canvas 资产之外的路径 → 直接拒绝（返回 ACP error）
- Phase 4 后：code repo 文件（`<cwd>/...`）→ 允许读 + 走 `permission/request` 流程写

### 3.5 协议翻译表

| ACP `session/update.sessionUpdate` | Sediment `AgentStreamEvent`                                                      |
| ---------------------------------- | -------------------------------------------------------------------------------- |
| `agent_message_chunk` (type=text)  | `text_delta`                                                                     |
| `agent_thought_chunk`              | `thinking_delta`                                                                 |
| `tool_call` (status=in_progress)   | `tool_start`                                                                     |
| `tool_call` (status=completed)     | `tool_result`                                                                    |
| `plan`                             | 暂时也走 `thinking_delta`（或者新增 `plan_update`）                              |
| session/cancel response            | `done`（with stopReason=aborted）                                                |
| ACP error response                 | `error`                                                                          |
| **（本地发送，不来自 ACP）**       | **`prepared_prompt`——preprocessor 产出的 ExternalAgentPrompt，前端渲染折叠卡片** |

**逆向**（Sediment → ACP，少数情况）：

| Sediment 触发 | 发给 agent                              |
| ------------- | --------------------------------------- |
| 用户点 stop   | `session/cancel`                        |
| 用户加新消息  | `session/prompt`（同一 sessionId）      |
| 关闭 thread   | （无显式 ACP 等价；客户端清理本地状态） |

### 3.6 External agent 怎么看到 canvas（Layer 1/2/3）

外部 agent 能不能感知 Huabu 的 canvas/node 结构？答案分三层。**v1 以 Layer 2 (preprocessor) + Layer 1 (fs/read) 为主**，Layer 3 是 Phase 5 可选项。

| Layer       | 机制                                                                                                                                        | agent 视角                                                                       | 落地 phase                                          |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------- |
| **Layer 1** | ACP 标准方法 `fs/read_text_file`，agent 主动读 `canvas.json` / `nodes/*.md` / `.artifacts/*` 原始文件（**read-only**）                      | agent 用它内置的 `Read` tool 拉取 preprocessor 推荐的 `fileRefs`；也可以自己探索 | Phase 2 (PR D 提供路径) + Phase 3 (实现 capability) |
| **Layer 2** | **Preprocessor**：Huabu 内部 LLM 把 (rawMsg + canvas state) 重写为结构化 `ExternalAgentPrompt`（`task` + `fileRefs`），起 prompt 工程师作用 | agent 收到清晰任务 + 需要读哪些文件的提示，自己决定怎么读                        | **Phase 2 (PR D)**                                  |
| **Layer 3** | Huabu 作为 **MCP server** 暴露 typed tool（`canvas_query` / `canvas_commands` ...）                                                         | agent 看到 first-class typed tool，schema 自描述，支持写操作                     | Phase 5（可选）                                     |

**为什么 v1 Layer 2 是 preprocessor 而不是“拼 canvas 概览到 prompt 前”**：

- 原拼接方案的问题：不管用户问什么都把整个 canvas 填进去——大 canvas 压倒 token 预算；不相关信息干扰 agent
- Preprocessor 方案里 Huabu 扮演“项目经理”：看完用户说什么、看一眼 canvas，出一份「该做什么 + 需要看哪些文件」的任务单给 agent
- 外部 agent 在其原生环境（代码仓助手背景）里本来就习惯“看到结构化任务 + 按需 Read 文件”，比被动收到一大坠 markdown 的体验好

**关键设计决策**：Layer 3 走 **MCP** 而不是 ACP 自定义方法。

- ACP spec 没规范化「client → agent 注册自定义 tool」机制；走 ACP 自定义就要为每个 agent 写胶水
- MCP 是 Anthropic 推的事实标准，主流 ACP agent（Claude Code / Cursor / Copilot CLI）大多自带 MCP client
- Huabu 9 个内置 tool 的 schema 直接复用到 MCP tool list，工作量最小

**典型搭配**：

| 用户场景                             | 推荐 Layer                             |
| ------------------------------------ | -------------------------------------- |
| 「让 claude 看一眼当前 canvas」      | Layer 1 + Layer 2                      |
| 「让 claude 在 canvas 里编辑节点」   | Layer 3（必须能写）                    |
| 「让 claude 结合代码 + canvas 重构」 | Layer 1 + Layer 2 + Phase 4 cwd 写能力 |

**注意**：以上所有 layer 都看到的是 **canvas 在磁盘上的状态**——如果用户有未保存的改动，agent 看不到。
要么强制 auto-save，要么 preprocessor 注入时显式标注「脏状态」。

---

## 4. 必须改动的现有代码

### 4.1 `apps/server/src/app.ts`

mount agentlet 的 bridge endpoint：

```ts
import { AgentletServer } from '@agentlet/server';
import { mountAgentletBridge } from './modules/agent/acp/server-mount.js';

const agentletServer = new AgentletServer({
  authenticate: async (token, hello) => {
    const auth = await validateSedimentToken(token);
    if (!auth) throw new Error('Invalid token');
    return { metadata: { userId: auth.userId, canvasId: auth.canvasId } };
  },
  onConnection: (agent) =>
    log.info({ agentId: agent.agentId }, 'agent connected'),
  onDisconnection: (agent, reason) =>
    log.warn({ agentId: agent.agentId, reason }, 'agent disconnected'),
});

// 接 Fastify 的 upgrade 事件到 agentletServer.handleUpgrade
mountAgentletBridge(fastify, agentletServer, '/api/acp/agent');
```

### 4.2 `apps/server/src/modules/agent/agent.route.ts`

小改：读 `request.agentBinding`（由前端 ChatState 随每次 send 携带）；

- `kind: 'internal'` （或字段缺省）→ `dispatch = runAgent`
- `kind: 'external'` → `dispatch = runAcpAgent`

两者签名一致，**SSE 写出逻辑、abort 机制、reconnect-resume 全不改**。

### 4.3 `packages/shared/src/types/agent.ts`

需要新增两个 SSE 事件：

- `prepared_prompt`（PR D）：preprocessor 产出的 `ExternalAgentPrompt` 走这个事件发到前端，供 ChatPanel 渲染「Prepared prompt」折叠卡片
- `permission_request`（Phase 3）：agent 调 `permission/request` 时推送到 UI 弹窗

其他事件（`plan_update` 等）**优先复用现有**——能映射到 `thinking_delta` / `tool_start` 就不要新增。

### 4.4 `data/external-agents.json`（Phase 4 才需要）

**v1 / Phase 2 不需要这个文件**。binding 信息存在前端 ChatState（随 localStorage）中，服务端仅根据 request 里的 `agentBinding` 分流。

Phase 4 引入这个文件是为了：

- 给同 alias 多实例 disambiguate（两台机器都跑了 `claude --acp`）
- 绑 code repo cwd、默认选择策略等

到 Phase 4 时重写 schema，**不要**沉淀旧的 multi-adapter 设计文件字段。

---

## 5. 阶段拆分

5 个 Phase，每个独立可发布。Phase 0-2 完成后已经能让用户在 Huabu 里 `@claude` 跑通基本对话。

### Phase 0 — 准备 & 依赖（小 PR）

**目标**：把 agentlet 接入 Sediment 的依赖图，不动业务逻辑。

- [ ] 跟 agentlet 团队约定发包策略（先 npm publish 还是用 git tag + workspace 引用？）
- [ ] `pnpm add @agentlet/server @agentlet/protocol` 到 `apps/server`
- [ ] 在 [setup.md](./setup.md) 加一节"如何用 `agentlet` CLI 连接你的本地 agent"
- [ ] 写一个 `docs/agentlet-integration.md` 说明依赖关系

**Exit criteria**：`pnpm install` + `pnpm typecheck` 全绿，dependencies 干净。

### Phase 1 — 最小可跑通（中等 PR）

**目标**：用户跑 `agentlet --agent "claude --acp"` 后能在 Sediment 看到 agent 上线、能发 prompt。

- [ ] `acp/server-mount.ts`：mount AgentletServer 到 Fastify upgrade
- [ ] `acp/token-store.ts`：发 token 的最简实现（暂时 in-memory + 单 token，全局复用）
- [ ] `acp/client.ts`：AcpAgentClient v1，只支持
  - initialize / session/new / session/prompt / session/update（agent_message_chunk）
  - 不实现 client capabilities（fs/permission），ACP error 直接 throw
- [ ] `acp/translator.ts`：基础事件翻译（text_delta + done）
- [ ] 一个新的 HTTP 调试 endpoint `POST /api/debug/acp-prompt`，绕过 agent.route 直接喂消息——**仅用于联调，不上 prod**

**Exit criteria**：

- 启动 Sediment server
- 在另一个终端跑 `agentlet --agent "claude --acp" --server ws://localhost:PORT/api/acp/agent --token dev`
- `curl POST /api/debug/acp-prompt` 能流回 Claude 的响应

### Phase 2 — Session-bound external agent + preprocessor pipeline（5 个小 PR）

**目标**：完成"thread 绑定外部 agent"的端到端体验。用户在 ChatPanel 顶部的 ModeSelector 里选一个外部 agent，thread 就绑定到该 agent + 一个 ACP session，后续每条消息走 preprocessor → ACP，结果以折叠卡片 + 流式输出呈现。

**核心心智模型变化**（相对旧 D1–D4 模型）：

- 旧：每条消息 `@agentId` 决定 dispatch；session 每次新建（"Plan A"）
- 新：**1 thread = 1 agent 绑定 = 1 持久 ACP session**；message 没有 `@mention` 概念
- 旧：Layer 2 = 拼 canvas 概览到 user message 前缀
- 新：Layer 2 = preprocessor 用内部 LLM 重写出 `ExternalAgentPrompt`（task + fileRefs），由 agent 自己 Read

#### PR 拆分（A done → B → C → D → E）

| PR    | 范围                                                                                                                                                                                                                                                                 | 用户能看到的变化                                                     | 状态                |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------- |
| **A** | `acp/agents.route.ts` 暴露 `GET /api/acp/agents`（flag off 时返 `[]`）+ 前端 `acp.ts` + `useAcpAgents()` 轮询 3s + 临时 ConnectedAgentsBar 指示器                                                                                                                    | "我看到 claude 上线了"                                               | ✅ commit `43ecdfa` |
| **B** | `AgentBinding` 类型 + ChatState 字段 + `agentRequestSchema` 加 `agentBinding` + **扩展 ModeSelector 下拉**（Ask / Agent + ─── External ─── 子列表）+ binding badge + **删除** PR A 的 ConnectedAgentsBar                                                             | "我选 claude 后这个 thread 就跟 claude 聊天"（前端打通，后端还没接） | ⏳                  |
| **C** | `acp/client.ts`（AcpAgentClient 类）+ `acp/session-registry.ts`（threadId → AcpSession 映射）+ `acp/translator.ts`（session/update ↔ AgentStreamEvent）+ `acp/service.ts` 走 ACP 真链路（**preprocessor 此 PR 暂用 passthrough**）+ `agent.route.ts` 加 binding 分流 | "我能跟 claude 说话了，但 prompt 是 raw user message"                | ⏳                  |
| **D** | `acp/preprocessor.ts`（内部 LLM 调用，输出 `ExternalAgentPrompt`）+ `service.ts` 调 preprocessor + `prepared_prompt` SSE 事件 + ChatPanel 渲染折叠卡片 + fallback 策略（preprocessor 出错降级到 passthrough）                                                        | "我看到 Huabu 写的任务单卡片，然后看 claude 按这个任务办"            | ⏳                  |
| **E** | 删除 Phase 1 的 `POST /api/debug/acp-prompt` 调试端点 + 清理 PR A 留下的 ConnectedAgentsBar 残留 export                                                                                                                                                              | 无（清理）                                                           | ⏳                  |

**Exit criteria（每 PR）**：

- **B**：选了外部 agent 后 send 一条消息能在 server log 里看到 `agentBinding: { kind:'external', alias:'claude' }`；选回 internal 走原路；浏览器刷新后绑定保留
- **C**：第 1 条消息能从 claude 收到回复并流式打字；第 2 条消息走同一 `sessionId`（log 验证）；abort 按钮能 cancel
- **D**：所有外部 agent 消息上方出现「Prepared prompt」折叠卡片（task + fileRefs）；preprocessor 抛错时降级到 raw message 且 log 告警
- **E**：`curl POST /api/debug/acp-prompt` 返 404；ConnectedAgentsBar 文件已删

<details>
<summary>已废弃（2026-05-25 round 2）：旧 @mention 路由模型的设计决策 D1–D4 + Plan A 编排</summary>

#### Phase 2 设计决策（2026-05-25 补遗）

Phase 2 开工前敲定的 4 个核心决策，对应代码改动直接照着这里写。

##### D1 — `agentId` 用 alias，不用完整 agentlet agentId

- agentlet 的 `agentId` 是 `host:cmd:cwd:uuid` 长串，不适合做 chat schema 主键
- 用 `connection.agentInfo.command.split(' ')[0]` 派生 alias（e.g. `claude --acp` → `claude`）
- 内置 agent：`agentId === null` / 字段缺省。**零迁移成本**——老 chat 文件全部默认走内置 agent
- 用户不能 `@huabu`（huabu 是无 `@` 时的默认 dispatch target，不是 `@`-able guest）
- 已知限制：两个 `claude --acp` 实例会撞 alias。Phase 2 接受，Phase 4 用 `external-agents.json` 解决稳定别名

##### D2 — 每次 prompt 都开新 session + 重放完整历史（"Plan A"）

- **不复用 ACP session**。每次 `@external-agent` 都 `session/new` + 把该 agent 的子线程历史拼成 Markdown 前缀塞进单次 `session/prompt`
- 历史拼接格式：`USER: ...\nYOU: ...` 反复，**不**用多次 `session/prompt` 假装多轮（spec 不允许伪造 assistant 响应）
- 为什么不复用 session：invalidation 复杂度高（见 Phase 3 Plan B），Plan A 始终正确，性能损失只是网络带宽
- **核心心智模型**：**ACP session = 缓存（Redis-like）；Sediment chat thread = 持久存储（DB-like）**。Sediment 永远是 source of truth，agent 的 session 只是它自己 LLM 调用的 KV 缓存
- agent 进程崩了、用户清了 chat、用户编辑过去消息、agentlet 重连——任何一种都会让 session 失效，Plan A 完全不用管这些

##### D3 — Chat 数据模型加 `agentId` 字段（多 agent attribution）

所有字段都是 **optional**，pi-ai `Context` 通过 `atomicWriteJson` 保留未知字段，**零迁移**：

| 类型                                  | 文件                                                | 字段                                     |
| ------------------------------------- | --------------------------------------------------- | ---------------------------------------- |
| `ChatHistoryItem`（user / assistant） | `packages/shared/src/types/agent/chat.ts` (L24-50)  | `agentId?: string`                       |
| `ChatMessage`                         | `apps/web/src/components/Messages/types.ts` (L6-45) | `agentId?: string`                       |
| `agentRequestSchema`                  | `packages/shared/src/types/api/agent.ts` (L169-220) | `agentId?: string`（路由 key）           |
| `AgentMetaEvent.data`                 | `packages/shared/src/types/agent/agent.ts` (L14-76) | `agentId?: string`（server echo 回前端） |

**语义**：user 消息的 `agentId` = "to whom"；assistant 消息的 `agentId` = "from whom"。**不要**单独加 `addressedTo` 字段——`agentId` 一字两用，减少 schema 表面积。

##### D4 — UX：视觉共享 + 上下文分区

- 一个 canvas 一个 chat thread（不变）
- 所有 agent 的消息按时间顺序渲染到同一个列表，用 sender avatar / 颜色区分
- **但是** 每个 agent prompt 时只看自己的子线程（server 按 `agentId` 过滤后才拼 prompt 前缀）
- 跨 agent 引用（`@huabu use what claude just said`）→ Phase 3+ 显式 quote 语法；Phase 2 用户自己复制粘贴
- `@` autocomplete 数据源 = 连接中的 agent 列表；**不**包含 `huabu`（huabu 是无 `@` 时的默认 dispatch target）

##### 旧 PR 拆分（A → B → C，渐进 ship）

| PR    | 范围                                                                                                                                                                        | 用户能看到的变化                                    |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| **A** | `acp/agents.route.ts` 暴露 `GET /api/acp/agents`（flag off 时返 `[]`）+ 前端 `acp.ts` + `useAcpAgents()` 轮询 3s + ChatPanel "Connected: claude" 指示器；**无** schema 改动 | "我看到 claude 上线了，但还不能跟它说话"            |
| **B** | D3 schema 改动 + `agent.route.ts` 加 `agentId` 分流 + `acp/service.ts`（Plan A 编排）+ `acp/context-injector.ts` Layer 2 + 前端 `@` autocomplete                            | "我可以 `@claude` 说话了，它知道当前 canvas 长啥样" |
| **C** | 删除 Phase 1 的 `POST /api/debug/acp-prompt` 调试端点                                                                                                                       | 无（清理 Phase 1 残留）                             |

推荐 **A → B → C**：先 ship 可见性（验证 Phase 0+1 连接真的活着，PR 小、风险低），再 ship 路由（核心功能），最后清理。

**废弃原因**：用户改为按 thread 绑定单一 agent（不是按消息 dispatch），且 prompt 工程通过 preprocessor 完成（不是裸塞 canvas 概览前缀），所以 D1 的 alias 路由、D2 的 Plan A 编排、D4 的多 agent 共存 thread UX 全部不再适用。D3 的 `agentId?` 字段在新模型里改为 thread 维度的 `agentBinding`，schema 表面积更小（已废弃 PR 表的 A/B/C 不要跟新表的 A/B/C/D/E 混淆）。

</details>

### Phase 3 — Client capabilities & 沙箱（中等 PR）

**目标**：让 agent 能调 fs/permission 等方法，但被 Huabu 沙箱住。

- [ ] `acp/capabilities/fs-readwrite.ts`：复用 [fs-sandbox.ts](../apps/server/src/modules/agent/tools/handlers/fs-sandbox.ts) 实现 `fs/*`
- [ ] `acp/capabilities/permission.ts`：通过 SSE 新事件 `permission_request` 推到前端，UI 弹窗，等用户点击，回信给 agent
- [ ] 文档：external agent 能访问什么、不能访问什么、为什么
- [ ] e2e 测试：模拟 agent 越权访问，确认被拒

**Exit criteria**：测试覆盖"agent 想读 canvas 外文件 → 被拒"、"agent 想写代码 → 弹窗 → 用户点同意"。

<details>
<summary>已废弃（2026-05-25 round 2）：Phase 3 可选优化 — Session 复用（"Plan B"）</summary>

**废弃原因**：新模型下「1 thread = 1 持久 session」由 `session-registry` 直接维护——session 跟 thread 同生命周期，不存在「Plan A 重放完整历史 → Plan B 缓存 sessionId」的优化区间。session 失效的 5 个 trigger（agent 重连、history 编辑、thread 清空、branching、TTL）在新设计里要么不存在（branching → 新 thread → 新 session），要么由 `session-registry` 统一处理（agent 重连 → registry 检测连接丢失 → drop entry → 下条消息触发重建）。Plan B 的 invalidation 复杂度不再适用。

#### Phase 3 可选优化 — Session 复用（"Plan B"）

**起源**：Phase 2 的 Plan A 每次都重放完整历史，对长对话浪费网络带宽。Plan B 通过缓存 ACP `sessionId` 跳过重放。

**前置条件**：Phase 2 已上线 + **实测有 latency 痛点**。没痛点不做——invalidation 逻辑的 bug 风险远大于网络带宽收益。

##### 数据结构

```ts
// apps/server/src/modules/agent/acp/session-cache.ts
interface CacheEntry {
  sessionId: string;
  agentConnectionId: string; // 检测 agentlet reconnect
  lastUsedAt: number;
  historyDigest: string; // sha 校验历史未被编辑/删除
}
const cache = new Map<`${canvasId}:${agentAlias}`, CacheEntry>();
```

##### Hot path

```
const key = `${canvasId}:${agentAlias}`;
const entry = cache.get(key);

if (entry
    && entry.agentConnectionId === currentConnection.id
    && entry.historyDigest === computeDigest(history)) {
  try {
    yield* client.prompt(entry.sessionId, [onlyNewUserMessage]);
    entry.lastUsedAt = now();
    return;
  } catch (e: UnknownSession) {
    cache.delete(key);
    // fall through to Plan A
  }
}

// Cache miss / invalidated / unknown-session
cache.delete(key);
const newSessionId = await client.newSession(...);
yield* runPlanA(newSessionId);
cache.set(key, {
  sessionId: newSessionId,
  agentConnectionId: currentConnection.id,
  lastUsedAt: now(),
  historyDigest: computeDigest(history),
});
```

##### Invalidation 触发器（**全部**都要实现，否则 agent 会看到错误的历史）

1. **Agent reconnect** — `agentConnectionId` 变化时丢弃 entry
2. **History 被编辑/删除** — `historyDigest` 不匹配时丢弃（用户编辑过去消息）
3. **Chat thread 清空** — 主动 delete 该 thread 的所有 entry
4. **Chat branching**（Phase 3+ feature，CanvasConvo 风格）— 每个分支独立 sessionId
5. **TTL 30 min idle** — 后台 sweep 清掉空闲 entry
6. **Agent 报 `unknown session` 错** — 兜底，丢弃 entry + 自动回退 Plan A

##### 预期收益 vs 代价

| 维度             | 影响                                                              |
| ---------------- | ----------------------------------------------------------------- |
| 网络带宽         | 长对话后约省 ~80% 字节（首轮不省）                                |
| LLM token        | **几乎不省** —— agent 内部 LLM 调用还是要喂完整历史               |
| 端到端延迟       | 主要是网络往返减少，不是 LLM inference 减少                       |
| 持久化 schema    | **不改任何** —— 纯运行时优化                                      |
| invalidation bug | 任何一个 trigger 漏实现 → agent 看到错误历史 → 回答错乱（高风险） |

##### 启动判据

开始 Plan B 之前确认：

- [ ] Phase 2 跑顺 ≥ 2 周
- [ ] 有用户反馈/监控数据证明 prompt latency 是问题
- [ ] 长对话场景占比 > 30%
- [ ] 6 个 invalidation trigger 全部有明确实现路径

任何一条不满足都**不要**动 Plan B。Plan A 始终正确这条性质太宝贵了。

</details>

### Phase 4 — Code-repo binding & 多 agent 选择（中等 PR）

**目标**：canvas ↔ code repo 绑定首次落地，支持多个 agent 共存。

- [ ] `acp/repo-binding.ts`：canvas → cwd 解析，存到 `canvas.json` 的 `codeRepos` 字段
- [ ] Canvas 设置 UI：添加/移除 code repository（pick folder）
- [ ] @mention 时 cwd 自动取 primary repo；多 repo 时支持 `@claude [my-app]` 前缀语法
- [ ] Agent 上线/离线在 chat UI 有 toast
- [ ] Settings UI 显示当前 connected agent 列表（agentId、command、cwd）
- [ ] Token 管理：每 canvas 一个 token；过期/撤销机制；UI 提供"copy command"按钮

**Exit criteria**：用户从零开始：开 canvas → 设置 repo → copy command → 在终端跑 agentlet → 回 Sediment @claude 干活。

### Phase 5（可选）— 把 Huabu 暴露为 MCP server（Layer 3）

**目标**：external agent 能直接调 `canvas_query` / `canvas_commands` 这种语义高级的 typed tool，
不用再去 parse 磁盘上的 markdown。

**关键决策：走 MCP 而不是 ACP 自定义方法**（理由见 §3.6）。

- [ ] `apps/server/src/modules/agent/mcp/server.ts`：新建 MCP server 模块（推荐 HTTP+SSE transport）
- [ ] `apps/server/src/modules/agent/mcp/tools.ts`：把现有 9 个 tool 的 schema 直接复用、注册为 MCP tool list
- [ ] Token & sandbox：MCP token 同样绑 canvasId，复用 Phase 3 的 fs-sandbox 逻辑
- [ ] UX：Settings UI 给出 `claude mcp add huabu http://localhost:PORT/mcp/<canvasId>?token=...` 的 copy command
- [ ] 文档：哪些 tool 是只读、哪些会改 canvas

**Exit criteria**：用户在 claude 里直接调 `canvas_query` 拿到结构化数据；调 `canvas_commands` 能写入 canvas 节点。

**注意**：MCP server 跟 ACP client 是**两条独立通道**——agentlet 不参与 MCP 流量。
两条通道共享 token-store 和 sandbox 逻辑，但 transport 完全不同。

---

## 6. Open Questions & 需要跟 agentlet 团队对齐的事

### Q1：`@agentlet/client` SDK 何时发布？

README 提到了，但 packages 目录里没看到。**v1 直接用 `@agentlet/server` embedded 模式**，
不依赖 client SDK——但 standalone 模式（v2）需要。需要跟 agentlet 团队约定时间点。

### Q2：authentication 接口的扩展性

[`AgentletServerOptions.authenticate`](../../../agentlet/packages/protocol/src/gateway-types.ts) 现在只返回 `{ metadata }`。
Sediment 想把 token 绑到 canvas + 过期时间——`metadata` 是 `Record<string, unknown>`，够用。
**但**如果 metadata 要参与后续路由决策，agentlet 是否暴露给 `getConnection`？看代码似乎是的，✓。

### Q3：client capabilities 在 ACP 规范里的当前状态

`fs/read_text_file` / `permission/request` 这些方法是 ACP 标准的一部分还是 Zed 的扩展？
**实施前必须确认**——读 [agentclientprotocol.com](https://agentclientprotocol.com) 最新 spec，
对照 Claude Code / Copilot CLI 实际发什么请求。

### Q4：单 agentlet 进程 spawn 一个 agent，还是多 agent？

agentlet 的 `agentId` = `<host>:<exec>:<cwd>:<uuid>`——一个 agentlet 进程对应一个 agent subprocess。
所以"用户想同时连 Claude 和 Gemini" → 跑两个 agentlet 进程。
**UX**：Settings UI 要清楚展示「每个 agent 一条命令」，避免用户以为一次性配完。

### Q5：用户怎么拿到 token

候选 UX：

- A. Settings → "Connect external agent" → 显示完整的 `agentlet --agent "..." --server ... --token ...` 命令
- B. Canvas 创建时自动生成 canvas-scoped token，复制按钮
- C. CLI 端 `agentlet --pair` 走类似 GitHub device-flow 的配对

**推荐 A**：最简单，符合用户在终端跑命令的习惯。B 是 nice-to-have。

### Q6：跟 [huabu-cli-design.md](./huabu-cli-design.md) 的关系

`huabu-cli-design` 的 §11 Q4 已经提到 ACP server 方向。这份文档专攻 ACP **client** 方向，两者**互不冲突**：

- ACP server（让 Zed 等用 Huabu agent）→ 单独 plan，先不做
- ACP client（让 Huabu 用别人的 agent）→ 本 plan，**优先级更高**
- Huabu CLI → 独立轨道，给人 + bash agent 用

三者交集在 `apps/cli/`：如果将来要做 Huabu CLI，可以让它通过 ACP 反向连一个 Sediment server 来跑 agent；但这不是 v1 必需。

### Q9：是否需要 fallback / 多 protocol 抽象？

**v1 不要。** 既然不再实现 subprocess adapter，就不要为「将来可能加别的 protocol」预留抽象层。
`runAcpAgent()` 是 concrete function，简单直接。等真有第二种 protocol 再抽 interface（YAGNI）。

### Q10：Agent-to-agent 委托（`ask_huabu` pattern）

外部 agent 不确定时能不能「反问 Huabu」？例如 claude 在重构时想知道「用户偏好 prettier 还是 biome？」。
两种路径：

- **A. Huabu 暴露 `ask_huabu(question)` MCP tool**（依赖 Phase 5）：外部 agent 主动调；
  Huabu 内部起一个 mini-agent 用 9 个内置 tool 尝试自动答；答不上来 → 通过 SSE `permission_request`
  问用户 → 把答复返还给外部 agent
- **B. 不做**：外部 agent 用 Layer 1 fs 摸 canvas + 走 `permission/request` 问用户（结构化选项）

**v1 不做。** 这是 Phase 6+ 的多 agent 编排话题，独立设计文档（待写 `docs/agent-to-agent-delegation.md`）。

**关键约束（如果将来做）**：内部 mini-agent **绝对不能**反向调外部 agent，否则无限递归——
mini-agent 的 tool list 必须是叶子（只读 + 仅 canvas/cwd 沙箱内）。

### Q7：性能

每条 agent 消息走 stdio→agentlet→WSS→Sediment→SSE→前端，跳跃数比内置 agent 多。
**预期**：本机部署延迟可忽略；将来 standalone + 跨网时主要瓶颈是 LLM 自身。
不做提前优化，留待 profile。

### Q8：安全模型分层

```
威胁                             防护
─────────────────────────────────────────────────────────
任意人伪造 token 连上 bridge      token 鉴权
agent 想读 canvas 外文件          fs-sandbox `safeResolve`
agent 想跑 terminal 命令          不实现 terminal/* 能力
agent 想读别的 canvas             token 绑 canvasId，metadata 校验
agent 越权写代码                  permission/request 弹窗
WebSocket 被中间人               TLS（标 ⚠️ dev 用 --allow-insecure 不能上 prod）
agentlet 进程在用户机器被劫持     agent 跑的是用户自己的 CLI，本来就是用户上下文
```

每条都要在 Phase 3 显式测过。

---

## 7. 风险

| 风险                                        | 概率 | 影响   | 缓解                                                                     |
| ------------------------------------------- | ---- | ------ | ------------------------------------------------------------------------ |
| ACP spec 还在演进，breaking change          | 中   | 中     | 锁定 protocol 包版本；监控 ACP 仓库；翻译层抽得干净                      |
| 不同 agent 实现 ACP 差异大                  | 高   | 中     | 每接入一个 agent 写一份 compatibility note；不强求行为一致               |
| agentlet 还没 1.0，API 可能变               | 高   | 中     | 你们是同一个团队，**同步推进、共同设计**；用 workspace 引用减少版本拖累  |
| client capabilities 实现 bug 导致沙箱破洞   | 中   | **高** | 强制 e2e 测试覆盖越权场景；安全 review                                   |
| 用户搞不懂为啥要跑 agentlet                 | 高   | 中     | 文档 + 一键 copy command + 后续可能集成到 Huabu CLI（`huabu pair` 命令） |
| Embedded 模式让 Sediment 进程更复杂、更易挂 | 中   | 中     | agentlet error 不应该 crash Sediment；隔离 try/catch                     |

---

## 8. 一句话总结

> agentlet 已经解决了"如何让 ACP agent 通过 NAT 被远程驱动"这件最难的事。
> Sediment 要做的只是"在 Fastify 里 embed agentlet server + 写一个 ACP 状态机 +
> 把 ACP 事件翻成 Sediment 现有的 SSE 协议 + 实现安全的 client capabilities"。
>
> 整件事**比外面看起来小得多**——主要工作量在 capability 沙箱和 UX，不在协议本身。

---

## Appendix A：实现路上的具体参考

| 你要做的事                                  | 参考                                                                                                               |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| ACP 客户端状态机怎么写                      | [agentlet/packages/ui/src/stores/session.ts](../../../agentlet/packages/ui/src/stores/session.ts) — 直接抄逻辑     |
| ACP 消息长什么样                            | agentlet README §9 「Protocol Examples」                                                                           |
| AgentletServer 怎么 embed                   | [agentlet/packages/server/src/server.ts](../../../agentlet/packages/server/src/server.ts) — `handleUpgrade` 是入口 |
| Fastify 怎么接 WebSocket upgrade            | `@fastify/websocket` 或直接用 raw http upgrade（agentlet 是 framework-agnostic）                                   |
| Sediment 现有 SSE 事件类型                  | `AgentStreamEvent` in [packages/shared/src/types/agent/agent.ts](../packages/shared/src/types/agent/agent.ts)      |
| Sediment 沙箱实现                           | [fs-sandbox.ts](../apps/server/src/modules/agent/tools/handlers/fs-sandbox.ts) `safeResolve`                       |
| Sediment 现有 agent service（参考实现风格） | [agent.service.ts](../apps/server/src/modules/agent/agent.service.ts) `runAgent`                                   |
| ACP 官方 spec                               | https://agentclientprotocol.com                                                                                    |

## Appendix B：跟其他相关文档的关系

| 文档                                                   | 跟本文档的关系                                                                                                           |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| [external_agent_design.md](./external_agent_design.md) | **被废弃**：里面的 copilot-sdk / claude-cli / generic-cli adapter 方案不再实现。文档保留作为历史参考但**不要按它写代码** |
| [huabu-cli-design.md](./huabu-cli-design.md)           | **正交**：CLI 是 Huabu 对外暴露接口；ACP client 是 Huabu 对外接入接口。两条不同方向                                      |
| [agent-architecture.md](./agent-architecture.md)       | **不改**：内置 agent loop 跟 ACP service 是并行的两条路径                                                                |

---

## Appendix C：你接下来一周的 checklist（执行优先级）

如果今天就开干，先做这 6 件事：

1. **[决策] 同意 v1 走 embedded 模式** ← 我推荐，需要你拍板
2. **[沟通] 跟 agentlet 团队约定发包策略** — npm 还是 workspace？v0.1 锁哪个 commit？
3. **[阅读] 把 agentlet README §3-§9 通读一遍** —— 30 分钟，把协议字段都背一遍
4. **[阅读] [agentclientprotocol.com](https://agentclientprotocol.com) 最新 spec** —— 重点是 client capabilities 部分
5. **[POC] Phase 1 的 debug endpoint 拉通** —— 一天的量，能验证 80% 的集成假设
6. **[决策] 写完 POC 后再正式立项 Phase 2-4**

不要先做的事：

- ❌ 不要先做 Layer 3 / MCP server —— Phase 5 才考虑（Layer 1+2 已经够日常用）
- ❌ 不要做 `ask_huabu` 之类 agent-to-agent 委托 —— 见 Q10，远超 v1
- ❌ 不要走「自定义 `huabu/*` ACP 方法」路线 —— 选 MCP（理由 §3.6）
- ❌ 不要先做 standalone 模式 —— v2
- ❌ 不要抽 `ExternalAgentAdapter` interface —— 只有 ACP 一条路，YAGNI
- ❌ 不要等 `@agentlet/client` SDK —— embedded 模式不需要它
