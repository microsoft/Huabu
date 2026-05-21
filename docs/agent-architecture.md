# Agent Architecture

> agent 的运行架构、tool 与 skill 的 design，以及尚未完成的 TODO。
> Last updated: 2026-05-11

---

## 1. Runtime 架构

服务端 agent 循环跑在 `@earendil-works/pi-agent-core` 的 `Agent` 类上。三条调用入口共用同一套工具 / skill 体系，但触发方式不同：

| 入口                   | 模式                             | 入口文件                                                                                                                                                                      |
| ---------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chat                   | `ask` / `operate`（`AgentMode`） | [agent.route.ts](../apps/server/src/modules/agent/agent.route.ts) → [agent.service.ts](../apps/server/src/modules/agent/agent.service.ts) `runAgent()`                        |
| Sketch 识别            | `sketch`                         | [intent.route.ts](../apps/server/src/modules/agent/intent.route.ts) → [sketch.service.ts](../apps/server/src/modules/agent/sketch.service.ts)（`runAgent` 多轮 tool-calling） |
| Prompt 节点 / Question | 复用 chat                        | 走 chat 入口                                                                                                                                                                  |

**SSE 协议**：服务端只发 [`AgentStreamEvent`](../packages/shared/src/types/agent/agent.ts) 自定义事件（`meta` / `text_delta` / `thinking_delta` / `tool_start` / `tool_result` / `done` / `error` / `end`）；pi-agent-core 的内部事件被 `runAgent` 映射后转出，前端 [useAgentStream.ts](../apps/web/src/hooks/useAgentStream.ts) 不感知 pi-agent-core。

**关键运行时特性**：

- `toolExecution: 'parallel'`——独立工具并发派发；`canvas_commands` 在 tool definition 上挂 `executionMode: 'sequential'`，整批退化为串行（避免 server 端 nodeTypeMap race + client 端 SSE 完成顺序 race）。
- `getApiKey: () => ensureApiKey()`——长跑工具期间 OAuth token 可刷新。
- `maxIterations` 软上限：service 层 `subscribe` 计 `turn_end`，超限 `agent.abort()` 后追加 cap-out 提示。
- Abort 中断：pi-agent-core 自动写入 `stopReason:'aborted'` 的 final assistant message（含中断前累计文本），`runAgent` finally 回灌 `context.messages`。
- 历史会话：`AgentMessage` 是 pi-ai `Message` 的超集，旧 `.history/chat/<threadId>.json` 直接可用。

---

## 2. Tool 设计

### 2.1 文件组织

```
apps/server/src/modules/agent/tools/
  definitions.ts        ← 纯 schema + description（pure，无 IO）
  index.ts              ← buildToolsForMode(mode, ctx) 把 def 包成 AgentTool
  executor.ts           ← name → handler 分派；注入 canvasId
  schemas/              ← TypeBox 命令 / 节点 / 边原子 schema
  handlers/
    canvas-query.ts     ← get_canvas_outline / inspect_nodes / inspect_edges
    canvas-write.ts     ← canvas_commands
    fs-read.ts          ← read
    fs-search.ts        ← grep / find / ls
    fs-sandbox.ts       ← 画布隔离的路径解析（含 skills/ resolver）
    web-search.ts       ← web_search
```

### 2.2 工具清单（9）

| Tool                 | 类别      | 说明                                                                                                                                                                                      |
| -------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_canvas_outline` | 读 · 几何 | 整张画布 map：每节点 `id/type/label/filename/parentFrame?/position/size/style?/preview?` + 拓扑-only edges + 预计算 `spatial.clusters`。`includePreviews` / `includeStyle` opt-in。       |
| `inspect_nodes`      | 读 · 几何 | 谓词 AND：`ids / byType / byParent / labelPattern / inRect / nearNode / nearPoint / inSameClusterAs / connectedTo`。返回派生字段（`distance / direction / edgeIds / hops / clusterId`）。 |
| `inspect_edges`      | 读 · 几何 | EdgeStyle 谓词：`ids / connectedTo / bySource / byTarget / between / byDirection / byLineStyle / byLineType`。                                                                            |
| `read`               | 读 · 文件 | 单文件文本读取，2000 行 / 50 KB 截断 + `nextOffset` 分页；自动解析 YAML frontmatter；二进制拒绝。                                                                                         |
| `grep`               | 读 · 文件 | regex/literal 搜索；命中 `nodes/<id>.md` 时附 `nodeId/label/nodeType` 富化。                                                                                                              |
| `find`               | 读 · 文件 | glob 文件名搜索；同样富化。                                                                                                                                                               |
| `ls`                 | 读 · 文件 | 目录列举（`count/total/truncated`）。                                                                                                                                                     |
| `canvas_commands`    | 写        | 单工具承包 14 个命令；handler 不直接落盘，注入 `origin / provenance / labelSource` 后由 SSE → 前端 `useAgentStream` 走 `executeCanvasCommands` 生效。                                     |
| `web_search`         | 其他      | Tavily。                                                                                                                                                                                  |

**模式划分**（[definitions.ts](../apps/server/src/modules/agent/tools/definitions.ts) 末尾）：

- `askTools`：所有读 + `web_search`，**无** `canvas_commands`。
- `operateTools`：在 ask 之上加 `canvas_commands`。
- `sketch`：read + inspect_nodes + inspect_edges + canvas_commands（在 [agents/sketch/AGENT.md](../apps/server/src/prompt/agents/sketch/AGENT.md) 声明）。

### 2.3 设计原则

1. **磁盘可读的不重复造**：节点文本字段（label/content/summary/keywords/type/src）走 `read("nodes/<id>.md")`；空间字段（position/size/parent/style）走 `inspect_nodes`；edge 视觉走 `inspect_edges`。outline 只承担 topology。
2. **画布隔离**：所有工具的运行范围都限定在当前画布；`safeResolve(canvasId, path)` 以画布目录为根做严格前缀校验。无跨画布访问。
3. **错误协议**：handler 失败 `throw`，pi-agent-core 包成 `isError: true` 的 toolResult；服务端 SSE bridge 提升为 `{ tool, status:'error', error }` envelope。**禁止**把 error 编码进 success JSON。
4. **截断契约**：所有读工具返回 `count + truncated`，能廉价拿到全集时再返回 `total`；`grep` / `find` 是早退式扫描，无 `total`。

### 2.4 `canvas_commands` 13 个命令

CREATE_NODES, CREATE_QUESTION, DELETE_NODES, MERGE_NODE_DATA, SET_NODE_PARENT, DISSOLVE_FRAME, SET_NODE_GEOMETRY, REORDER_NODES, CONNECT_NODES, DISCONNECT_EDGES, SET_EDGE_STYLE, ALIGN_NODES, DISTRIBUTE_NODES。

Schema 在 [schemas/command.ts](../apps/server/src/modules/agent/tools/schemas/command.ts)，是 [`CanvasCommand`](../packages/shared/src/types/canvas/command.ts) 的 agent 子集（排除 UI-only 的 `SET_NODE_LOCKED / SET_NODE_SELECTION / SET_EXPANDED_NODE / CHANGE_NODE_TYPE`，以及已废弃的 `AUTO_LAYOUT`）。详见 [canvas-command-architecture.md](./canvas-command-architecture.md)。

---

## 3. Skill 设计

### 3.1 文件布局

```
apps/server/src/prompt/
  skill-loader.ts       ← 启动期扫盘 + frontmatter 校验
  skills/
    index.ts            ← getSkillCatalogue(scope) — 渲染 system prompt 用的 catalogue
    canvas/             ← 唯一对 ask/operate/sketch/external 都生效的核心 skill
      SKILL.md          (≤ ~200 行：心智模型 + 工具决策矩阵 + 命令目录)
      references/
        layout-recipes.md
        command-cookbook.md
    sketch-gestures/    ← 仅 sketch 流水线
      SKILL.md
```

Per-canvas 覆盖：`<workspace>/<canvasId>/skills/<id>/SKILL.md`（含 `references/`）优先于全局；解析逻辑在 `resolveSkillPath`，做了 `..` 越界防御。

### 3.2 加载机制

- 启动期 `preloadSkills()` 扫每个 `<id>/SKILL.md` 并校验 frontmatter（`id / name / description / appliesTo` 必填，`appliesTo ∈ {ask, operate, sketch, external}`），不合法直接抛错。
- `references/*.md` **不**经 loader，只作为 `read` 的可达文件存在。
- catalogue 通过 `getSkillCatalogue(scope)` 注入 system prompt（一行 `- **id** — description`），agent 自助调用 `read("skills/<id>/SKILL.md")` 加载完整内容；`use_skill` 工具已下线。

### 3.3 Skill 内容约束

- SKILL.md 写**语义和 idiom**；schema / 字段名以 [schemas/](../apps/server/src/modules/agent/tools/schemas/) 为唯一来源，skill 不内联 TypeBox。
- 跨 surface 复用的canvas 读取与操作知识放 `canvas`；pipeline 专属（如 sketch 手势 → 命令映射）独立 skill 并 `appliesTo` 收紧。
- 长内容下沉到 `references/`，从 SKILL.md 用 `read("skills/<id>/references/<file>.md")` 显式链接。

---

## 4. TODO

> 每条标注**触发条件**和**范围**。

### 4.1 Tool 覆盖范围扩展 (low-priority)

| #   | 项                            | 触发条件                                                                                                            | 范围                                                                                                                                                                                                                                     |
| --- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | `describe_node_position` 工具 | prompt 节点 / sketch cluster trace 上看到反复用 `inspect_nodes({nearNode}) + inspect_nodes({ids}) + 自己拼自然语言` | 新增 `handlers/canvas-describe.ts` 包装现有 `buildNodeNeighbourhoodContext()`（`apps/server/src/modules/canvas/node-neighbourhood.ts`）；schema 仅 `nodeId + radius?`；输出 `{description, neighbors, cluster?}`。**严禁**新写空间算法。 |

### 4.2 视觉信号 ↔ 空间工具协同 (medium-priority)

- 触发条件：LLM 出现"截图里看到的 X 节点 vs 工具返回的 nodeId 对不上"trace；或给 prompt 节点加截图通道时。
- 范围：
  - 审计 [apps/web/src/handler/canvasCommand/utils/screenshot.ts](../apps/web/src/handler/canvasCommand/utils/screenshot.ts) 的 nodeId 角标化；
  - `inspect_nodes({inRect})` 输出加 `viewportRelative?: {x,y,w,h}`；
  - 评估给 chat agent 加 opt-in 的 `take_viewport_snapshot`（目前只有 intent 端用截图）。

### 4.3 Skill 体系尾巴

- **D4 ask-mode `system.ts` 抽 skill**：故意推后；低重复 / 低价值，等 ask prompt 第二次出现重复内容再做。
- **Phase 4 — 外部 agent 集成**：在 workspace 根放 `AGENTS.md`（"操作 Sediment 画布请从 `skills/canvas/SKILL.md` 开始"）；adapter 启动时把 skills 目录物化到外部工作目录或暴露 mini MCP server——选型留到 adapter 设计阶段。
- **Phase 5 — DX & governance**：CI lint（frontmatter 必填、SKILL.md 行数上限、`id` 唯一、`references/...` 引用必须可达）、dev-only `mtime` 热重载。
- **Skill versioning**：`version` 是否需要强制？倾向不强制，仅记录。

### 4.4 旁路（不在本文档主线，仅指引）

- External agent permission policy 占位 `approveAll` —— [external_agent_design.md](./external_agent_design.md#L430)。

---

## 5. 修改 / 新增工具或 skill 的 checklist

新增 / 修改一个 tool（4 步）：

1. schema 入 `tools/schemas/`（如复用现有原子，跳过）。
2. 在 `tools/definitions.ts` 添加 `*ParamsSchema` + `ToolDefinition`，写清楚边界（什么时候用、什么时候不用）。
3. body 入 `tools/handlers/<name>.ts`，失败 `throw`，禁止把 error 包进 success JSON。
4. `tools/executor.ts` 加 `case`，按需 `withCanvasId(...)` 注入。

新增 / 修改一个 skill（3 步）：

1. `apps/server/src/prompt/skills/<id>/SKILL.md` —— frontmatter 必填 `id / name / description / appliesTo`。
2. 长内容拆 `references/*.md`，从 SKILL.md 用 `read("skills/<id>/references/<file>.md")` 链接。
3. 启动一次确认 `preloadSkills()` 不报错；catalogue 自动出现在对应 scope 的 system prompt。

---

## 相关文档

- [canvas-command-architecture.md](./canvas-command-architecture.md) — `CanvasUiIntent / CanvasCommand / CanvasExecution` 三层模型。
- [agent-context.md](./agent-context.md) — 注入 system prompt 的上下文构造。
- [sketch-intent-pipeline.md](./sketch-intent-pipeline.md) — Sketch 识别完整链路。
- [external_agent_design.md](./external_agent_design.md) — 外部 agent 适配设计。
