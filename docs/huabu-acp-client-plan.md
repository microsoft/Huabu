# Huabu as ACP Client — Implementation Plan

> Huabu 作为 ACP **client**，通过 [agentlet](https://github.com/hai-team/agentlet)
> 连接到外部 ACP 兼容 agent（Claude Code / Copilot CLI / Gemini CLI ...）。
>
> **External-agent 接入唯一路径**：ACP。早期讨论过的 copilot-sdk / claude-cli / generic-cli
> 三种 subprocess adapter 不再实现。
>
> Status: **Draft** · Last updated 2026-05-22

---

## 0. TL;DR — 你需要做的事

1. **架构决策**：embed `@agentlet/server` 进 Sediment 的 Fastify app
2. **新增模块** `apps/server/src/modules/agent/acp/`：
   - mount agentlet server 到 Fastify `/api/agentlet/{bridge,host}` upgrade endpoint
   - `AcpAgentClient` 类——单次会话的 ACP 状态机（initialize / session/new / session/prompt / session/update）
   - `runAcpAgent()` service 函数——跟现有 `runAgent()` 平行，yield `AgentStreamEvent`
   - 实现 client 侧 capabilities：`fs/read_text_file` / `fs/write_text_file` / `permission/request`，**全部走 canvas sandbox**
3. **协议事件翻译**：ACP `session/update` ↔ Sediment `AgentStreamEvent`
4. **UX**：token 颁发、agent 发现/选择、canvas ↔ code-repo 绑定
5. **路由层小改**：chat route 看消息里有没有 `@agentId`，有就 dispatch 到 `runAcpAgent`，否则继续走 `runAgent`
6. **跟 agentlet 团队协调**：确认 `@agentlet/client` SDK 何时发布；ACP 客户端
   capabilities 一些规范细节

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

| 组件              | 现状                                                                | 涉及文件                                                                       |
| ----------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Agent loop        | pi-agent-core 跑内置 9 个 tool；SSE `AgentStreamEvent` 协议成熟     | [agent.service.ts](../apps/server/src/modules/agent/agent.service.ts)          |
| External agent    | **未实现**——磁盘上有 `data/external-agents.json` 桩文件但代码没接入 | —                                                                              |
| @mention 路由     | **未实现**——目前 chat 消息全部走内置 agent                          | [agent.route.ts](../apps/server/src/modules/agent/agent.route.ts)              |
| Code-repo binding | **未实现**——canvas 跟代码仓库还没关联机制                           | —                                                                              |
| SSE 路由          | 现成的 streaming + abort + reconnect-resume 机制                    | [agent.route.ts](../apps/server/src/modules/agent/agent.route.ts)              |
| Sandbox 工具      | `safeResolve` / `walk` 用于内置 fs 工具                             | [fs-sandbox.ts](../apps/server/src/modules/agent/tools/handlers/fs-sandbox.ts) |

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
│        │  message 里有 @agentId? ─yes→ runAcpAgent()  │
│        │                            ─no → runAgent()  │
│        ▼                                              │
│   ┌──────────────────────────────────────────────┐   │
│   │  runAcpAgent()  (acp/service.ts)              │   │
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
├── server-mount.ts          ← embed @agentlet/server 到 Fastify
├── token-store.ts           ← Sediment 自己的 token 颁发/验证（绑到 canvas）
├── client.ts                ← AcpAgentClient（ACP 状态机，单 session）
├── service.ts               ← runAcpAgent()——跟现有 runAgent() 平行的入口
├── translator.ts            ← session/update ↔ AgentStreamEvent
├── repo-binding.ts          ← canvas ↔ code repo 绑定（cwd resolver）
├── context-injector.ts      ← Layer 2（Phase 2）：发 session/prompt 前把 canvas 概览拼到 user message 前
├── capabilities/
│   ├── fs-readwrite.ts      ← Layer 1（Phase 3）：fs/read_text_file / fs/write_text_file（走 fs-sandbox）
│   └── permission.ts        ← permission/request → Sediment UI 弹窗
└── types.ts                 ← 内部类型

# Layer 3 走独立模块（Phase 5，可选）：
apps/server/src/modules/agent/mcp/
├── server.ts                ← Huabu as MCP server（HTTP 或 stdio transport）
└── tools.ts                 ← 把 9 个内置 tool 的 schema 注册成 MCP tool
```

### 3.2 `AcpAgentClient`（核心，最大块）

负责跟单个 `AgentConnection` 维护一次 ACP 会话生命周期。

参考 [agentlet 的 ui/src/stores/session.ts](../../../agentlet/packages/ui/src/stores/session.ts)——
它已经写好了 server→client 一侧的协议处理，**几乎可以直接搬到 server 端**，主要区别：

| ui/stores/session.ts       | AcpAgentClient（server 端）                                 |
| -------------------------- | ----------------------------------------------------------- |
| Vue ref 存状态             | 普通 class 实例，状态字段                                   |
| 直接更新 UI                | yield `AgentStreamEvent` 给上游                             |
| transport 是 WS 客户端     | transport 是 `AgentConnection` 的 `send` / message callback |
| 单 session                 | 多 session（每 thread 一个）                                |
| 不实现 client capabilities | **必须实现 fs/permission 等**（agent 会调你）               |

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

chat route 拿到消息后，看 metadata 里有没有 `agentId`；有就调 `runAcpAgent`，否则调 `runAgent`。
两者返回值都是 `AsyncGenerator<AgentStreamEvent>`，**SSE 路由完全无感**。

```ts
// apps/server/src/modules/agent/acp/service.ts
export interface AcpRunOptions {
  agentId: string; // 用户在 UI 选的 connected agent
  prompt: string; // 用户消息
  canvasId: string;
  cwd: string; // 来自 canvas ↔ code repo 绑定
  signal?: AbortSignal;
  agentletServer: AgentletServer; // 注入，方便测试
}

export async function* runAcpAgent(
  opts: AcpRunOptions,
): AsyncGenerator<AgentStreamEvent, void, unknown> {
  const conn = opts.agentletServer.getConnection(opts.agentId);
  if (!conn || conn.status !== 'connected') {
    throw new Error(`Agent ${opts.agentId} not connected`);
  }

  const queue = new AsyncQueue<AgentStreamEvent>();
  const client = new AcpAgentClient(conn, {
    cwd: opts.cwd,
    canvasId: opts.canvasId,
    onEvent: (e) => queue.push(e),
    onClientRequest: makeCapabilityRouter({
      canvasId: opts.canvasId,
      cwd: opts.cwd,
    }),
  });

  try {
    await client.initialize();
    await client.newSession();
    await client.prompt(opts.prompt, opts.signal);
  } finally {
    await client.shutdown();
  }

  for await (const event of queue) yield event;
}
```

**注意**：不实现 `ExternalAgentAdapter` 之类的抽象接口。external agent 只有 ACP 一条路，
用 service 函数比 adapter 抽象更直接、更易测。将来若真有第二种 protocol 再抽。

### 3.4 Client-side capabilities（**安全关键**）

ACP 的双向性意味着 agent 会主动**调** client 暴露的方法。Sediment 必须实现并**鉴权**这些方法。

| ACP 方法                      | Sediment 实现                                                                                                     | 沙箱                                  |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `fs/read_text_file`           | 走 [fs-sandbox.ts](../apps/server/src/modules/agent/tools/handlers/fs-sandbox.ts) 的 `safeResolve(canvasId, ...)` | 只允许 canvas 目录 + cwd（code repo） |
| `fs/write_text_file`          | 同上，但**默认拒绝**写入 canvas 目录                                                                              | 只允许 cwd 写                         |
| `terminal/*`                  | **默认不实现** —— LLM 在你 server 上跑 bash 太危险                                                                | 不开                                  |
| `permission/request`          | 弹窗给 Sediment UI（reuse 现有的 confirm 流）                                                                     | 用户必须点确认                        |
| ~~自定义 `huabu/*` ACP 方法~~ | **不走 ACP**——见 §3.6 Layer 3，改用 MCP server                                                                    | Phase 5                               |

**双沙箱原则**：

- canvas 文件（`<workspace>/<canvasDir>/...`）→ 走 `safeResolve` + `canvasId`，**只读**
- code repo 文件（`<cwd>/...`，cwd 来自 canvas ↔ repo 绑定）→ 允许读 + 走 permission 流程写
- 任何不在以上两根之下的路径 → 直接拒绝（返回 ACP error）

### 3.5 协议翻译表

| ACP `session/update.sessionUpdate` | Sediment `AgentStreamEvent`                         |
| ---------------------------------- | --------------------------------------------------- |
| `agent_message_chunk` (type=text)  | `text_delta`                                        |
| `agent_thought_chunk`              | `thinking_delta`                                    |
| `tool_call` (status=in_progress)   | `tool_start`                                        |
| `tool_call` (status=completed)     | `tool_result`                                       |
| `plan`                             | 暂时也走 `thinking_delta`（或者新增 `plan_update`） |
| session/cancel response            | `done`（with stopReason=aborted）                   |
| ACP error response                 | `error`                                             |

**逆向**（Sediment → ACP，少数情况）：

| Sediment 触发 | 发给 agent                              |
| ------------- | --------------------------------------- |
| 用户点 stop   | `session/cancel`                        |
| 用户加新消息  | `session/prompt`（同一 sessionId）      |
| 关闭 thread   | （无显式 ACP 等价；客户端清理本地状态） |

### 3.6 External agent 怎么看到 canvas（Layer 1/2/3）

外部 agent 能不能感知 Huabu 的 canvas/node 结构？答案分三层，**复杂度从低到高、agent 体验从粗到细**。
v1 只做 Layer 1 + Layer 2，Layer 3 是 Phase 5 可选项。

| Layer       | 机制                                                                                                       | agent 视角                                                        | 落地 phase      |
| ----------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | --------------- |
| **Layer 1** | ACP 标准方法 `fs/read_text_file`，agent 读 `canvas.json` / `nodes/*.md` 原始文件                           | agent 用它内置的 `Read` tool，看到的是普通文件，要自己 parse 结构 | Phase 3         |
| **Layer 2** | Sediment 在调 `session/prompt` 前把 canvas 概览（节点数、列表、选中节点、code repo）拼到 user message 前缀 | agent 收到 prompt 就有 context，不用主动查；最确定、最便宜        | **Phase 2**     |
| **Layer 3** | Huabu 作为 **MCP server** 暴露 typed tool（`canvas_query` / `inspect_nodes` / `canvas_commands` ...）      | agent 看到 first-class typed tool，schema 自描述，支持写操作      | Phase 5（可选） |

**关键设计决策**：Layer 3 走 **MCP** 而不是 ACP 自定义方法。

- ACP spec 没规范化「client → agent 注册自定义 tool」机制；走 ACP 自定义就要为每个 agent 写胶水
- MCP 是 Anthropic 推的事实标准，主流 ACP agent（Claude Code / Cursor / Copilot CLI）大多自带 MCP client
- Huabu 9 个内置 tool 的 schema 直接复用到 MCP tool list，工作量最小

**典型搭配**：

| 用户场景                             | 推荐 Layer                             |
| ------------------------------------ | -------------------------------------- |
| 「让 claude 看一眼当前 canvas」      | Layer 1 + Layer 2                      |
| 「让 claude 在 canvas 里编辑节点」   | Layer 3（必须能写）                    |
| 「让 claude 结合代码 + canvas 重构」 | Layer 1 + Layer 2 + 现有 fs 写代码能力 |

**注意**：以上所有 layer 都看到的是 **canvas 在磁盘上的状态**——如果用户有未保存的改动，agent 看不到。
要么强制 auto-save，要么 Layer 2 注入时显式标注「脏状态」。

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

小改：从请求 body / message metadata 提取 `agentId`；若存在则
`dispatch = runAcpAgent`，否则 `dispatch = runAgent`。两者签名一致，**SSE 写出逻辑、abort 机制、
reconnect-resume 全不改**。

### 4.3 `packages/shared/src/types/agent.ts`

如果要新增 `plan_update` / `permission_request` 之类的 SSE 事件，schema 在这里加。
**优先复用现有类型**——能映射到 `thinking_delta` / `tool_start` 就不要新增。

`permission_request` 是必须新增的（前端要拿它弹窗）。

### 4.4 `data/external-agents.json` schema（重新定义）

现在桩文件是从未实现的多 adapter 设计留下的，直接重写为 ACP-only：

```ts
export interface AcpAgentEntry {
  /** 用户起的名字，用于 @mention，例如 "claude" */
  alias: string;
  /**
   * 选择策略：
   * - `pinned`: 必须连指定 agentId
   * - `last-connected`: 取最近上线的一个
   * - `prompt-user`: 多个候选时让用户选
   */
  selectionMode: 'pinned' | 'last-connected' | 'prompt-user';
  /** 当 selectionMode='pinned' 时必填 */
  agentId?: string;
  /** 可选：限定 agent 命令名（如 `claude`），过滤候选 */
  agentExecutable?: string;
}

export interface ExternalAgentsConfig {
  agents: AcpAgentEntry[];
}
```

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

### Phase 2 — 接入 @mention 路由 + Layer 2 context 注入（中等 PR）

**目标**：在 Sediment chat UI 里 @claude 能跑通整个链路，体验跟内置 agent 一致；外部 agent 能感知当前 canvas。

- [ ] `acp/service.ts`：`runAcpAgent()` 函数完整化
- [ ] `acp/context-injector.ts`：**Layer 2** —— 在调 `session/prompt` 前，把 canvas 概览（标题、节点列表前 N 个、选中节点、绑定的 code repo）拼到 user message 前缀。解决「外部 agent 完全不知道 canvas 长啥样」的问题。大 canvas 要有截断策略。
- [ ] `data/external-agents.json` schema 落地 + 加载逻辑
- [ ] `agent.route.ts` 加 `agentId` 分流（看消息有没有 `@agentId` 决定 dispatch）
- [ ] 前端 ChatPanel 加 `@claude` autocomplete + agent 列表 UI
- [ ] 删除 debug endpoint

**Exit criteria**：用户能在 Sediment chat 里 `@claude 描述一下当前 canvas`，claude 能给出准确描述（不需要它再调 fs）。

### Phase 3 — Client capabilities & 沙箱（中等 PR）

**目标**：让 agent 能调 fs/permission 等方法，但被 Huabu 沙箱住。

- [ ] `acp/capabilities/fs-readwrite.ts`：复用 [fs-sandbox.ts](../apps/server/src/modules/agent/tools/handlers/fs-sandbox.ts) 实现 `fs/*`
- [ ] `acp/capabilities/permission.ts`：通过 SSE 新事件 `permission_request` 推到前端，UI 弹窗，等用户点击，回信给 agent
- [ ] 文档：external agent 能访问什么、不能访问什么、为什么
- [ ] e2e 测试：模拟 agent 越权访问，确认被拒

**Exit criteria**：测试覆盖"agent 想读 canvas 外文件 → 被拒"、"agent 想写代码 → 弹窗 → 用户点同意"。

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
