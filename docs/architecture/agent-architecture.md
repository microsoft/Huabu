# Agent Architecture

> 服务端 agent 的运行架构：运行时、入口、工具、skill、外部 agent、持久化。
> Last updated: 2026-06-30

模块根：[apps/server/src/modules/agent](../../apps/server/src/modules/agent) · prompt 根：[apps/server/src/prompt](../../apps/server/src/prompt)

---

## 1. 运行时

服务端 agent 循环跑在 `@earendil-works/pi-agent-core` 的 `Agent` 类上，封装在 [agent.service.ts](../../apps/server/src/modules/agent/agent.service.ts) 的 `runAgent()` async generator。

关键运行时特性：

- **并发工具**：`toolExecution: 'parallel'` 默认并发派发；`canvas_commands` / `fs_write` / `generate_image` 在 def 上挂 `executionMode: 'sequential'` 退化为串行（避免 server race + SSE 完成顺序 race）。
- **`maxIterations` 软上限**：service 计 `turn_end`，超限 `agent.abort()` 后追加 cap-out 提示。每个 agent 在 AGENT.md frontmatter 的 `runtime.maxIterations` 声明（默认 20，sketch=6）。
- **`getApiKey: () => ensureApiKey()`**：长跑工具期间 OAuth token 可刷新（[llm.ts](../../apps/server/src/modules/agent/llm.ts) / [oauth.ts](../../apps/server/src/modules/agent/oauth.ts)）。
- **Abort**：路由 `signal` → `agent.abort()`，pi-agent-core 写入 `stopReason:'aborted'` 的 final message。

---

## 2. 入口与 agent

5 个内置 agent，各一份 [prompt/agents/<id>/AGENT.md](../../apps/server/src/prompt/agents)（frontmatter 声明 `tools` / `skillScope` / `runtime`，loader 见 [agents/loader.ts](../../apps/server/src/prompt/agents/loader.ts)）：

| Agent             | 入口                                                                                                                                                | 说明                                                                                                               |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `ask` / `operate` | `POST /api/agent`（[agent.route.ts](../../apps/server/src/modules/agent/agent.route.ts) → `runAgent`）                                              | chat 主链路；ask 只读、operate 可写。question 节点也走这里                                                         |
| `sketch`          | [sketch.service.ts](../../apps/server/src/modules/agent/sketch.service.ts) `recognizeSketchCommands()`                                              | 手势 → `CanvasCommand[]`，同 `runAgent` 但 `sketch` scope + `sketch-recognized` origin，drains generator（无 SSE） |
| `intent`          | [intent.route.ts](../../apps/server/src/modules/agent/intent.route.ts) → [intent.service.ts](../../apps/server/src/modules/agent/intent.service.ts) | 单次 LLM 排候选，`tools: []`，无 agent 循环                                                                        |
| `memory`          | [memory/](../../apps/server/src/modules/agent/memory) 后台 curator                                                                                  | op-counter 触发，详见 [agent-memory.md](./agent-memory.md)                                                         |

**外部 / ACP agent**：chat 请求带 `binding` 字段时走 [acp/](../../apps/server/src/modules/agent/acp)（§5），不走内置 `runAgent`。

---

## 3. SSE 协议

服务端只发自定义 [`AgentStreamEvent`](../../packages/shared/src/types/agent/agent.ts)（14 种：`meta` / `text_delta` / `thinking_delta` / `tool_call` / `tool_call_update` / `plan` / `permission_request` / `config_options_update` / `session_mode_update` / `session_info_update` / `session_usage_update` / `done` / `error` / `end`）；前端 [useAgentStream.ts](../../apps/web/src/hooks/useAgentStream.ts) 不感知 pi-agent-core。

内部 pi-ai 工具与外部 ACP 共用同一套 `tool_call` 信封：内部回合在 `tool_call` 携带 `internalToolName` 驱动前端 render variant + 本地副作用（如 `canvas_commands` 执行）；ACP 回合不带该字段、渲染为 `generic`。

---

## 4. 工具

文件组织：

```
tools/
  definitions.ts   ← TOOL_REGISTRY：纯 schema + description（pure）
  index.ts         ← buildToolsForScope / buildAgentToolsByNames（按名解析）
  executor.ts      ← executeTool(name, args, ctx) → handler 分派，注入 canvasId
  schemas/         ← TypeBox command / node / edge 原子 schema
  handlers/        ← 各工具实现
```

12 个工具，按 agent frontmatter 的 `tools` 数组分配（**非**代码硬编码列表）：

| Tool                                                     | Handler                                                                                       | scope                                   |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------- |
| `get_canvas_outline` / `inspect_nodes` / `inspect_edges` | [canvas-query.ts](../../apps/server/src/modules/agent/tools/handlers/canvas-query.ts)         | ask/operate/sketch                      |
| `read`                                                   | [fs-read.ts](../../apps/server/src/modules/agent/tools/handlers/fs-read.ts)                   | ask/operate/sketch/memory               |
| `grep` / `find` / `ls`                                   | [fs-search.ts](../../apps/server/src/modules/agent/tools/handlers/fs-search.ts)               | ask/operate/sketch                      |
| `web_search`                                             | [web-search.ts](../../apps/server/src/modules/agent/tools/handlers/web-search.ts)             | ask/operate                             |
| `canvas_commands`                                        | [canvas-write.ts](../../apps/server/src/modules/agent/tools/handlers/canvas-write.ts)         | operate/sketch                          |
| `fs_write`                                               | [fs-write.ts](../../apps/server/src/modules/agent/tools/handlers/fs-write.ts)                 | operate/memory                          |
| `snapshot_nodes`                                         | [snapshot-node.ts](../../apps/server/src/modules/agent/tools/handlers/snapshot-node.ts)       | operate（+ sketch route 自动 snapshot） |
| `generate_image`                                         | [image-generation.ts](../../apps/server/src/modules/agent/tools/handlers/image-generation.ts) | operate                                 |

设计原则：

1. **磁盘可读的不重复造**：节点文本（label/content/summary/...）走 `read("nodes/<id>.md")`；空间字段走 `inspect_nodes`；edge 视觉走 `inspect_edges`；outline 只承担 topology。
2. **画布隔离**：`safeResolve(canvasId, path)` 以画布目录为根做严格前缀校验，无跨画布访问（[fs-sandbox.ts](../../apps/server/src/modules/agent/tools/handlers/fs-sandbox.ts)）。
3. **错误协议**：handler 失败 `throw`，pi-agent-core 包成 `isError: true`，禁止把 error 编进 success JSON。
4. **截断契约**：读工具返回 `count + truncated`，能廉价拿全集时再给 `total`。

`canvas_commands` 承包 14 个命令（[schemas/command.ts](../../apps/server/src/modules/agent/tools/schemas/command.ts)）：CREATE_NODES, DELETE_NODES, MERGE_NODE_DATA, SET_NODE_PARENT, DISSOLVE_FRAME, SET_NODE_GEOMETRY, REORDER_NODES, CONNECT_NODES, DISCONNECT_EDGES, SET_EDGE_STYLE, ALIGN_NODES, DISTRIBUTE_NODES, CREATE_QUESTION, SET_FRAME_LAYOUT —— 是 [`CanvasCommand`](../../packages/shared/src/types/canvas/command.ts) 的 agent 子集（排除 UI-only 的 `SET_NODE_LOCKED / SET_NODE_SELECTION / CHANGE_NODE_TYPE`）。命令服务端执行、落盘并返回 deltas，详见 [canvas-command-architecture.md](./canvas-command-architecture.md)。

---

## 5. 上下文与持久化

chat 上下文以 **envelope-first** 模型组装（详见 [agent-context.md](./agent-context.md)）：

- [conversation/](../../apps/server/src/modules/agent/conversation) 把每回合渲染成 `ChatEnvelope`（用户文本 + selection + anchor + skills），再序列化成 pi-ai 消息。
- 持久化在 [store/chat-thread-store.ts](../../apps/server/src/modules/agent/store/chat-thread-store.ts)：`<canvasDir>/.history/chat/<threadId>.turns.jsonl`（append-only 已完成回合）+ `.active.json`（进行中）。每条 turn 记录 `{ envelope, transcript, acp? }`；envelope 是单一真相，user message 不单独持久化，reload 时由 envelope 重建（`rebuildContextMessages`）。
- intent episode 记录在 [store/intent-store.ts](../../apps/server/src/modules/agent/store/intent-store.ts)。

---

## 6. 外部 agent（ACP）

[acp/](../../apps/server/src/modules/agent/acp) 是外部 agent（Copilot CLI / Claude Code / Gemini / agentlet）的集成层：

- [service.ts](../../apps/server/src/modules/agent/acp/service.ts) `runAcpAgent()` — 对应 `runAgent`，跟外部 daemon 对话
- [preprocessor.ts](../../apps/server/src/modules/agent/acp/preprocessor.ts) — 把 `ChatEnvelope` 序列化成外部 wire payload（内外共用同一 envelope）
- [translator.ts](../../apps/server/src/modules/agent/acp/translator.ts) — ACP update → `AgentStreamEvent`
- [session-registry.ts](../../apps/server/src/modules/agent/acp/session-registry.ts) / [session-store.ts](../../apps/server/src/modules/agent/acp/session-store.ts) — 一个 Sediment thread 一个 ACP session
- [profile-store.ts](../../apps/server/src/modules/agent/acp/profile-store.ts) / [spawn-orchestrator.ts](../../apps/server/src/modules/agent/acp/spawn-orchestrator.ts) / daemon 路由 — agent 配置 + daemon 生命周期

外部 agent 可通过 **reachback** 通道读 / 写画布（详见 [agent-reachback.md](./agent-reachback.md)）。连接 / 协议 internals 正在重构，见 [acp-eventstore-refactor-plan.md](../proposals/acp-eventstore-refactor-plan.md) 与 [agentlet-upgrade-plan.md](../proposals/agentlet-upgrade-plan.md)。

---

## 7. Skill

skill **不是工具**，通过 catalogue（按需）+ invoked（显式 `/cmd`）两条路径进 prompt，详见 [agent-context.md §3.2](./agent-context.md)。

```
prompt/skills/
  loader.ts      ← loadSkill / mergeSkill：system + user 双源合并，mtime cache
  catalogue.ts   ← getSkillCatalogue(scope) 渲染 system prompt 的清单
  canvas/        ← 核心画布 skill（commands + references + layout recipes）
  sketch-gestures/  ← sketch 手势识别
  create-skill/ · update-skill/  ← skill 创作引导
  memory/        ← memory 写入策略子文档（见 agent-memory.md）
```

- 系统 skill 在 `prompt/skills/<id>/`（随程序发布）；用户 skill 在 `<workspace>/setting/skills/<id>/`，同 id 合并。
- frontmatter 必填 `id / name / description / appliesTo`（`∈ {ask,operate,sketch,external}`）；可选 `triggers / version / userInvokable`。
- catalogue 按 agent 的 `skillScope` 过滤；agent 自助 `read("skills/<id>/SKILL.md")` 取正文。`use_skill` 工具已下线。
- `/` 菜单可调用项由 [skills.route.ts](../../apps/server/src/modules/agent/skills.route.ts) 的 `isUserInvokableSkill()` 判定。

---

## 8. 改 / 加工具或 skill 的 checklist

加 / 改一个 tool：

1. schema 入 `tools/schemas/`（复用现有原子则跳过）。
2. `tools/definitions.ts` 加 def（schema + description + 边界说明），登记进 `TOOL_REGISTRY`。
3. body 入 `tools/handlers/<name>.ts`，失败 `throw`。
4. `tools/executor.ts` 加 `case`，按需 `withCanvasId(...)`。
5. 在用到它的 `agents/<id>/AGENT.md` 的 `tools` 数组里加名字。

加 / 改一个 skill：

1. `prompt/skills/<id>/SKILL.md`，frontmatter 必填四项。
2. 长内容拆 `references/*.md`，从 SKILL.md 用 `read("skills/<id>/references/<file>.md")` 链接。
3. 启动确认 loader 不报错；catalogue 自动出现在对应 scope。

---

## 相关文档

- [agent-context.md](./agent-context.md) — 上下文如何拼进 prompt（envelope / selection / skill 注入）。
- [agent-memory.md](./agent-memory.md) — 三层记忆与后台 curator。
- [canvas-command-architecture.md](./canvas-command-architecture.md) — `canvas_commands` 的三层模型与服务端执行。
- [sketch-node.md](./sketch-node.md) — sketch 节点与识别管线。
- [agent-reachback.md](./agent-reachback.md) — 外部 agent 读写画布的 reachback 通道。
