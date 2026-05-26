# Huabu as ACP Client — Implementation Plan

> Huabu 作为 ACP **client**，通过 [agentlet](https://github.com/hai-team/agentlet)
> 连接到外部 ACP 兼容 agent（Claude Code / Copilot CLI / Gemini CLI ...）。
>
> Status: **Phase 2 完成 (PR A–E 已 merge)** · Next: Phase 3 capabilities · Last updated 2026-05-26

---

# Part 1 — ACP Solution

## 1. Overview

Sediment server embed `@agentlet/server` 在自己的 Fastify 进程里开一个 WS bridge endpoint。
用户在自己机器上跑 `agentlet --agent "claude --acp" --server ws://.../api/acp/agent --token <t>`，
agent 进程通过 agentlet 注册到 bridge。Sediment 的 chat thread 可以绑定到某个 external agent，
之后每条用户消息走 preprocessor → ACP `session/prompt` → agent → `session/update` → SSE 翻译给前端。

**核心心智模型**：

- **1 chat thread = 1 agent 绑定 = 1 持久 ACP session**。绑定不可在 thread 内修改——切换 agent 即 implicit New conversation。
- **session-registry** 在 server 端按 `threadId` 维护 AcpSessionEntry，复用 connection + sessionId，直到 thread 关闭或 agent 重连。
- **Preprocessor** 把 raw user message 重写为结构化 `ExternalAgentPrompt`（`task` + `fileRefs`），Huabu 当 agent 的"项目经理"，外部 agent 用自己的 Read tool 按需拉取节点内容。

**v1 read-only 安全模型**：外部 agent 只能 `fs/read_text_file` 读 `<canvasDir>/canvas.json` + `nodes/**` + `.artifacts/**`，没有写、没有 terminal。写能力推到 Phase 4 (code repo 绑定) 之后。

**边界**：

- agentlet 团队负责：spawn agent subprocess、stdio↔WSS、reconnect、`agentId`、buffer 重放
- Sediment 负责：ACP 客户端语义（initialize / session/new / session/prompt）、`session/update` → SSE 翻译、client-side capabilities 实现、canvas 沙箱、preprocessor

## 2. Architecture

### 2.1 数据流

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
│   │   ├─ session-registry (threadId → entry)      │   │
│   │   └─ AcpAgentClient  (acp/client.ts)          │   │
│   │        │ ACP JSON-RPC over AgentConnection    │   │
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
            └────────┬────────┘
                     │ stdio
                     ▼
            ┌─────────────────┐
            │  ACP Agent      │  ← claude --acp / copilot --acp / ...
            └─────────────────┘
```

### 2.2 模块清单

```
apps/server/src/modules/agent/acp/
├── server-mount.ts       embed @agentlet/server 到 Fastify upgrade           ✅
├── token-store.ts        token 颁发/验证（v1 单 dev token: SEDIMENT_ACP_DEV_TOKEN）✅
├── agents.route.ts       GET /api/acp/agents 暴露连接列表                     ✅
├── client.ts             AcpAgentClient — 1 session lifecycle                ✅
├── session-registry.ts   threadId → AcpSessionEntry，replace 时 shutdown 旧  ✅
├── service.ts            runAcpAgent() async generator + preprocessor wire    ✅
├── translator.ts         session/update → AgentStreamEvent                   🟡 仅 text_delta
├── preprocessor.ts       rawMsg + canvas → ExternalAgentPrompt                ✅
├── capabilities/
│   ├── fs.ts             fs/read_text_file 沙箱                               ⏳ Phase 3
│   └── permission.ts     permission/request → UI 弹窗                         ⏳ Phase 3
└── repo-binding.ts       canvas ↔ code repo cwd resolver                     ⏳ Phase 4

# Layer 3（Phase 5，可选）：
apps/server/src/modules/agent/mcp/
├── server.ts             Huabu as MCP server
└── tools.ts              9 个内置 tool 注册成 MCP tool
```

前端：

```
apps/web/src/
├── api/acp.ts                                AcpAgentSummary fetch          ✅
├── hooks/useAcpAgents.ts                     3s 轮询                        ✅
├── hooks/useAgentStream.ts                   forwards agentBinding          ✅
├── store/chatStore.ts                        bindingMap (per-canvas persist) ✅
└── components/Panels/ChatPanel/
    ├── index.tsx                             ChatPanel 入口                 ✅
    ├── ModeSelector.tsx                      下拉含 ─── External ─── 子列表 ✅
    └── PreparedPromptCard.tsx                折叠卡片                       ✅
```

### 2.3 协议翻译表

| ACP `session/update.sessionUpdate`  | Sediment `AgentStreamEvent`       | 状态        |
| ----------------------------------- | --------------------------------- | ----------- |
| `agent_message_chunk` (type=text)   | `text_delta`                      | ✅          |
| `agent_thought_chunk`               | `thinking_delta`                  | ⏳ Phase 3  |
| `tool_call` (status=in_progress)    | `tool_start`                      | ⏳ Phase 3+ |
| `tool_call` (status=completed)      | `tool_result`                     | ⏳ Phase 3+ |
| `plan`                              | `thinking_delta` 或 `plan_update` | ⏳          |
| ACP error response                  | `error`                           | ✅          |
| stopReason (end_turn/cancelled/...) | `done` (with stopReason)          | ✅          |
| **（本地发送，不来自 ACP）**        | **`prepared_prompt`**             | ✅          |

逆向（Sediment → ACP）：

| Sediment 触发 | 发给 agent                             |
| ------------- | -------------------------------------- |
| 用户点 stop   | `session/cancel`                       |
| 用户加新消息  | `session/prompt`（同一 sessionId）     |
| 关闭 thread   | `client.shutdown()`（无显式 ACP 等价） |

### 2.4 Client-side capabilities (沙箱)

ACP 的双向性意味着 agent 会主动**调** client 暴露的方法。Sediment 必须实现并鉴权。

| ACP 方法             | Sediment v1 实现                            | 沙箱                                                |
| -------------------- | ------------------------------------------- | --------------------------------------------------- |
| `fs/read_text_file`  | 走 `fs-sandbox.ts:safeResolve(canvasId, …)` | 只允许 `canvas.json` + `nodes/**` + `.artifacts/**` |
| `fs/write_text_file` | **v1 直接返 ACP error**                     | 返错                                                |
| `terminal/*`         | **不实现** — LLM 在 server 上跑 bash 太危险 | 不开                                                |
| `permission/request` | 推送到 Sediment UI（reuse 现有 confirm 流） | 用户点确认                                          |

当前 (PR C) `AcpAgentClient` 把 agent 的所有 incoming JSON-RPC requests 一律 `-32601 method not found` 拒绝。Phase 3 才接入真实 capability handler。

### 2.5 External agent 怎么看到 canvas

v1 用 Layer 2 (preprocessor) + Layer 1 (fs/read) 组合；Layer 3 (MCP) 是 Phase 5 可选项。

| Layer       | 机制                                                                         | 落地 phase             |
| ----------- | ---------------------------------------------------------------------------- | ---------------------- |
| **Layer 1** | ACP 标准 `fs/read_text_file`，agent 用自己的 `Read` tool 拉指定路径          | Phase 3                |
| **Layer 2** | Preprocessor 用内部 LLM 重写 (rawMsg + canvas state) → `ExternalAgentPrompt` | Phase 2 PR D — ✅ done |
| **Layer 3** | Huabu 暴露为 MCP server，agent 看到 typed tool                               | Phase 5 (可选)         |

**为什么 Layer 2 用 preprocessor 而不是直接拼 canvas 概览**：大 canvas 会压垮 token 预算且不相关信息干扰 agent；preprocessor 让 Huabu 当"项目经理"，出一份「任务 + 需要看哪些文件」的清单，agent 按需 Read 即可。

**为什么 Layer 3 走 MCP 而不是 ACP 自定义方法**：ACP spec 没规范化「client → agent 注册自定义 tool」机制；MCP 是事实标准，主流 ACP agent 自带 MCP client。

**注意**：以上所有 layer 都看到的是 **canvas 在磁盘上的状态**——未保存改动 agent 看不到。PR D 推到了外部 agent 之前复用了 `useAgentStream.ts:flushCanvasEvents()`（与 ask / internal agent 同一条路径）；flush 错误被静默吞掉是三边共通的遗留 staleness 问题，需要加固请单开 issue。

---

# Part 2 — Implementation Plan

## 3. 进度速览

| Phase | PR  | 内容                                                     | 状态         |
| ----- | --- | -------------------------------------------------------- | ------------ |
| 0/1   | —   | embed agentlet/server + debug endpoint                   | ✅ `f4f4950` |
| 2     | A   | GET /api/acp/agents + 临时 ConnectedAgentsBar            | ✅ `43ecdfa` |
| 2     | B   | AgentBinding 类型 + ChatState + ModeSelector 下拉        | ✅ `1ee3834` |
| 2     | C   | AcpAgentClient + session-registry + service + route 分流 | ✅ `6fca129` |
| 2     | D   | preprocessor + `prepared_prompt` SSE + 折叠卡片          | ✅ `ba9e5c8` |
| 2     | E   | 删 debug.route + 清理                                    | ✅           |
| 3     | —   | fs/permission capabilities + 沙箱                        | ⏳           |
| 4     | —   | canvas ↔ repo binding + 多 agent 选择 + token 管理       | ⏳           |
| 5     | —   | Huabu as MCP server (可选)                               | ⏳           |

## 4. 已完成

- **Phase 0/1 (`f4f4950`)**：embed `@agentlet/server` 到 Fastify upgrade，`SEDIMENT_ENABLE_ACP=1` flag 控制开关，最小 `client.ts` + `translator.ts` 跑通 initialize/session/prompt/text_delta，`POST /api/debug/acp-prompt` 调试端点（已在 PR E 删除）。
- **Phase 2 PR A (`43ecdfa`)**：`GET /api/acp/agents` 暴露 alias + command + host + cwd；前端 `useAcpAgents()` 3s 轮询 + 临时 `ConnectedAgentsBar` 指示器（PR B 已删）。
- **Phase 2 PR B (`1ee3834`)**：`AgentBinding` discriminated union（internal/external）+ ChatStore `bindingMap` per-canvas localStorage 持久化；ModeSelector 下拉新增 `─── External ───` 子列表；`agentRequestSchema` 携带 `agentBinding`；删除 ConnectedAgentsBar。
- **Phase 2 PR C (`6fca129`)**：`AcpAgentClient` 完整 lifecycle（per-session updateHandlers Map、abort listener、`isClosed` flag、agent incoming requests 一律 `-32601` reject）+ `session-registry`（threadId → AcpSessionEntry，replace 时 shutdown 旧 client）+ `runAcpAgent()` async generator（preprocessor 暂走 passthrough，`cwd` 默认 `/` 让 agentlet 端覆盖）+ `agent.route.ts` 按 `agentBinding.kind` 分流。
- **Phase 2 PR D (`ba9e5c8`)**：`acp/preprocessor.ts` 调内部 LLM 重写 raw text → `ExternalAgentPrompt`（`task` + `fileRefs`）；`runAcpAgent` 在 session 打开后、queue 开启前调 preprocessor 并 yield `prepared_prompt` SSE（包含可选 `error`，失败时降级到 raw text）；`packages/shared/src/types/agent/agent.ts` 加 `prepared_prompt` event schema；`PreparedPromptCard.tsx` 渲染折叠卡片；history 里写 `[SYSTEM PreparedPrompt]` sidecar 让重连后 UI 能回填。**已定的设计决策**：
  - **preprocessor LLM**：复用 Sediment settings 的 **default model**，用户可控、无新 hardcode、无独立 token 预算。
  - **wire schema**：按 **path** 而非 node id，与 Phase 3 `fs/read_text_file` 语义一致；外部 agent 直接 `Read <path>` 即可。
    ```ts
    type ExternalAgentPrompt = {
      task: string; // 重写后的任务描述
      fileRefs: Array<{ path: string; reason?: string }>; // 相对 canvasDir
    };
    ```
  - **`selectedNodeIds`**：不加新字段，直接从 `agentRequestSchema.canvasContext.selectedNodes`（`apps/web/src/store/canvasStore.ts:getAgentChatContext` 产出）读，与 ask / internal agent 共用同一份 context。
  - **fallback UX**：preprocessor 失败时 `prepared_prompt` 带 `error` 字段，UI 在卡片里直接显示失败原因；不引入新组件、不加 toast。
  - **dirty canvas**：复用 `useAgentStream.ts:flushCanvasEvents()` 路径（与 ask / internal agent 同一条），加固需单独开 issue（影响范围更广）。
- **Phase 2 PR E**：删 `acp/debug.route.ts` + `app.ts` 的 import/register/log；`ConnectedAgentsBar` 已无残留（PR B 已删）；`service.ts` 的 `cwd ?? '/'` 默认值保持不变 —— `'/'` 是与 agentlet relay 约定的 sentinel：`relay.ts#enrichMessage` 在 `params.cwd` 为空或 `'/'` 时会用自己的 `process.cwd()` 替换（**不是 bug**，是显式契约），所以 Phase 4 之前用户的契约是 `cd <repo> && agentlet --agent "..." --server ...`。文档同步：README + plan doc 文件表 / 进度速览 / 协议翻译表 / Layer 表全部对齐到当前实现。

## 5. 待办

### Phase 3 — Client capabilities & 沙箱

**目标**：实现 `fs/read_text_file` + `permission/request`，让 agent 能调但被 Huabu 沙箱住；agent 越权访问被拒。

**任务**：

- [ ] `acp/capabilities/fs.ts`：基于 `fs-sandbox.ts:safeResolve` 实现 `fs/read_text_file`，只允许 `<canvasDir>/canvas.json` + `nodes/**` + `.artifacts/**`
- [ ] `acp/capabilities/permission.ts`：通过新 SSE 事件 `permission_request` 推前端，UI 弹窗等用户点击，回信给 agent
- [ ] `AcpAgentClient` 把 incoming JSON-RPC requests 路由到 capability handler（替换当前的 `-32601` reject）
- [ ] 跨 agent compatibility note：实测 Claude Code、Copilot CLI、Gemini CLI 实际发什么请求
- [ ] e2e 测试：模拟 agent 读 canvas 外文件 → 拒；读 canvas 内 → 通；写 → 拒

**Exit criteria**：测试覆盖越权场景；至少两款 agent（claude / copilot）能跑通 `fs/read_text_file`。

**Open design decisions**：

- **`fs/read_text_file` / `permission/request` 是 ACP 标准还是 Zed 扩展**？实施前必须读最新 spec + 抓 Claude/Copilot 实际包。
- **permission UI 复用还是新建**？现有 confirm 弹窗能否承载 ACP 的 `kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'` 四态？
- **`fs/write_text_file` 上线时机**：Phase 3 只开 read（v1 read-only 原则），还是顺手把 write 也接上（带 permission gate）？write 在没有 code repo 绑定（Phase 4）之前对外部 agent 意义不大。
- **`terminal/*` 永远不开还是 Phase 4+ 可选**？

### Phase 4 — Code-repo binding & 多 agent 选择

**目标**：canvas ↔ code repo 绑定，cwd 自动派生；支持同一 alias 多实例 disambiguate；token 颁发 UX 成型。

**任务**：

- [ ] `acp/repo-binding.ts`：canvas → cwd 解析，存到 `canvas.json` 的 `codeRepos` 字段
- [ ] Canvas 设置 UI：添加/移除 code repository（pick folder）
- [ ] `AgentBinding` 加 cwd / repoId 字段（多 repo 时支持选 primary）
- [ ] `data/external-agents.json` schema 重新设计（同 alias 多实例的稳定别名 + 默认 cwd）
- [ ] Settings UI 显示当前 connected agents 列表 + 「copy `agentlet --token ...` command」按钮
- [ ] Token 管理：per-canvas token + 过期 + 撤销 UI
- [ ] Phase 3 的 `fs/write_text_file` 在绑了 repo 的 thread 里启用（带 permission gate）

**Exit criteria**：用户从零开始：开 canvas → 设置 repo → copy command → 跑 agentlet → 在 Sediment 让 claude 真的改代码。

**Open design decisions**：

- **`external-agents.json` schema**：键用 `{ host, command, cwd }` 三元组自动派生？还是要求用户在 UI 里起别名？
- **多 repo per canvas**：UI 上怎么选 primary？还是每次 message dispatch 时要选？或者 binding 维度就只允许一个 repo？
- **同 alias 多实例 disambiguate**：两台机器都跑 `claude --acp` 时——加 host 前缀显示？还是 UI 里强制起别名？还是用 agentlet 的 full `agentId`（`host:cmd:cwd:uuid`）但 UI 截短？
- **token 颁发流**：(a) Settings 里点 "Connect external agent" → 显示完整 `agentlet --agent "..." --server ... --token ...` copy command（最简单）；(b) Canvas 创建时自动发 canvas-scoped token + copy 按钮；(c) device-flow 配对。倾向 (a)。
- **token 范围**：per-canvas 还是 per-binding？per-canvas 简单但跨 canvas 复用 agent 不行；per-binding 灵活但 UI 复杂。

### Phase 5 (可选) — Huabu as MCP server (Layer 3)

**目标**：external agent 不再 parse 磁盘 markdown，直接调 `canvas_query` / `canvas_commands` 这种语义 typed tool。

**任务**：

- [ ] `apps/server/src/modules/agent/mcp/server.ts`：MCP server（推荐 HTTP+SSE transport）
- [ ] `apps/server/src/modules/agent/mcp/tools.ts`：现有 9 个内置 tool schema 复用为 MCP tool list
- [ ] MCP token 同样绑 canvasId，复用 Phase 3 fs-sandbox
- [ ] Settings UI 给出 `claude mcp add huabu http://localhost:PORT/mcp/<canvasId>?token=...` copy command

**Exit criteria**：用户在 claude 里直接调 `canvas_query` 拿结构化数据；`canvas_commands` 能写入 canvas 节点。

**Open design decisions**：

- **transport**：HTTP+SSE（不用让用户跑额外进程）还是 stdio（MCP 默认）？
- **`canvas_commands` 写能力是否走 permission gate**？跟 ACP `permission/request` 流复用还是独立？
- **Phase 5 真的需要做吗**？如果 Phase 2 + 3 上线后 user feedback 表明 Layer 1+2 够用就跳过。

---

## 6. 风险

| 风险                                | 概率 | 影响 | 缓解                                                 |
| ----------------------------------- | ---- | ---- | ---------------------------------------------------- |
| ACP spec 演进 breaking change       | 中   | 中   | 锁 protocol 包版本；翻译层抽干净                     |
| 不同 agent ACP 实现差异             | 高   | 中   | 每接入一个写 compatibility note；不强求行为一致      |
| agentlet 还没 1.0、API 变           | 高   | 中   | 同团队协同推进；workspace 引用（已是当前做法）       |
| capability 沙箱破洞                 | 中   | 高   | Phase 3 强制 e2e 覆盖越权场景；安全 review           |
| 用户搞不懂为啥要跑 agentlet         | 高   | 中   | 文档 + 一键 copy command（Phase 4）                  |
| Embedded 模式让 Sediment 进程更易挂 | 中   | 中   | agentlet error 不应该 crash Sediment；隔离 try/catch |

---

## Appendix — 实现参考

| 你要做的事                  | 参考                                                                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| ACP 客户端状态机            | [`agentlet/packages/ui/src/stores/session.ts`](../../../agentlet/packages/ui/src/stores/session.ts) — 直接抄逻辑                            |
| AgentletServer embed        | [`agentlet/packages/server/src/server.ts`](../../../agentlet/packages/server/src/server.ts) — `handleUpgrade`                               |
| Sediment SSE 事件类型       | [`packages/shared/src/types/agent/agent.ts`](../packages/shared/src/types/agent/agent.ts) `AgentStreamEvent`                                |
| Sediment 沙箱               | [`apps/server/src/modules/agent/tools/handlers/fs-sandbox.ts`](../apps/server/src/modules/agent/tools/handlers/fs-sandbox.ts) `safeResolve` |
| Sediment 现有 agent service | [`apps/server/src/modules/agent/agent.service.ts`](../apps/server/src/modules/agent/agent.service.ts) `runAgent`                            |
| ACP 官方 spec               | https://agentclientprotocol.com                                                                                                             |
