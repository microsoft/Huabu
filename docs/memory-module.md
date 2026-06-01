# Memory Module

> Status: Shipped
> Last updated: 2026-06-01

让 agent 跨会话、跨画布地记住"用户是谁、这张画布在做什么、有什么做法可以复用"。整套机制非阻塞，写入由 LLM 自己决定。

---

## 1. 三层记忆

| 层        | 范围   | 路径                                       | 用户可见 | 用途                                             |
| --------- | ------ | ------------------------------------------ | -------- | ------------------------------------------------ |
| Workspace | 跨画布 | `<workspace>/setting/.huabu.md`            | ✅       | 用户画像、风格偏好、回答长短等 cross-canvas 偏好 |
| Canvas    | 单画布 | `<canvas>/.memory/canvas.md`               | ❌ 隐藏  | 这张画布在做什么、当前意图、已确认的小决定       |
| Skill     | 跨画布 | `<workspace>/setting/skills/<id>/SKILL.md` | ✅       | 可复用的做法 / recipe                            |

**容量**：workspace + canvas memory 各自硬上限 4 KB / 80 行；skill 没有体积上限，但创建门槛高（见 §4.3）。

**Skill 双源**：系统自带 skill 在 `apps/server/src/prompt/skills/<id>/`（随程序发布、用户不可改）；用户 / curator 写的 skill 在 `<workspace>/setting/skills/<id>/`。同 id 时按"system 在前 + user 追加"合并，loader 在 [skills/loader.ts](../apps/server/src/prompt/skills/loader.ts) 实现。

---

## 2. 触发 — 谁来写、什么时候写

写入有 **两条路径**，互不冲突：

### 2.1 后台 curator（自动）

- 每个 canvas 维护一个 op counter，落在 `<canvas>/.memory/state.json`。
- 任何 _mutating_ HTTP 请求（PUT / POST / PATCH / DELETE，对应 canvas 的）由 Fastify hook 统一计数，详见 [memory/op-counter-hook.ts](../apps/server/src/modules/agent/memory/op-counter-hook.ts)。
  - `POST /api/canvas/<id>/events` 按 `events.length` 计权（一次 flush 五个动作 = +5）。
  - 其它请求一律 +1。
  - 失败响应（4xx / 5xx）不计。
- counter ≥ `OP_THRESHOLD = 50` → 触发一轮 memory 分析。trigger 内部立刻清零，避免重复触发。
- 触发后走 **per-canvas single-flight** 的 worker（[memory/worker.ts](../apps/server/src/modules/agent/memory/worker.ts)）：已在跑的直接 set pending flag，不排队。
- `setImmediate` dispatch — 路由先 response 给客户端，curator 在下一 tick 才开始。
- 失败只 warn 不抛，下一次触发自然重试。
- curator 用 [agents/memory/AGENT.md](../apps/server/src/prompt/agents/memory/AGENT.md)，最多 5 iterations，sequential 工具调用。

### 2.2 Chat 内显式写入（用户驱动）

ask / operate 两个 chat agent 都拿到三个 memory write 工具。**只在用户明确说"记住这个"/"保存为 skill"时才能调用**，policy 写在它们各自的 AGENT.md 里。inferred preference 走 §2.1。

---

## 3. 读 — 谁怎么读

读路径只有一条：通过 `read()` 工具，三个入口。

| 工具调用                                            | 解析到                            |
| --------------------------------------------------- | --------------------------------- |
| `read("memory/workspace.md")`                       | `<workspace>/setting/.huabu.md`   |
| `read("memory/canvas.md")` （需要 canvasId 上下文） | `<canvas>/.memory/canvas.md`      |
| `read("skills/<id>/SKILL.md")`                      | system + user 合并后的 skill 整文 |

实现在 [tools/handlers/fs-read.ts](../apps/server/src/modules/agent/tools/handlers/fs-read.ts)；未知 `memory/*.md` 路径直接报错给 agent 看。

**注入策略**：

- **首轮**：route 在第一条 message 前推一条 `[SYSTEM Workspace memory ...]`，把 `.huabu.md` 内容塞给 agent（保证 cross-canvas 偏好对首句生效）。见 [agent.route.ts](../apps/server/src/modules/agent/agent.route.ts) 的 isFirstTurn 块。
- **后续轮**：不再主动注入。Skill catalogue 和 memory 入口在 system prompt 的"Available skills / memory"段里被列出来，agent 自己判断要不要 `read()`。
- `[SYSTEM` 开头的 user message 在 chat 历史渲染时被自动剔除，前端无感。

Canvas memory **永远是 pull-only** — 体积偏大、情境性强，由 agent 决定是否拉。

---

## 4. 写 — 三个 tool

三个工具长得对称：每个写一类，写入失败一律返回结构化 `WriteResult`（`{ ok, target, reason }`），不抛异常。

| Tool                     | 目标                                       | 行为                                                                       |
| ------------------------ | ------------------------------------------ | -------------------------------------------------------------------------- |
| `memory_workspace_write` | `<workspace>/setting/.huabu.md`            | `mode: "patch"` — bullet 合并 + trim-dedup，**只增不删**。`replace` 暂禁。 |
| `memory_canvas_write`    | `<canvas>/.memory/canvas.md`               | 整体 replace body                                                          |
| `memory_skill_write`     | `<workspace>/setting/skills/<id>/SKILL.md` | `op: "create"` 或 `op: "update"`；后者整体 replace body                    |

实现在 [memory/writers.ts](../apps/server/src/modules/agent/memory/writers.ts)，路径校验在 [memory/sandbox.ts](../apps/server/src/modules/agent/memory/sandbox.ts)。

### 4.1 共同约束

- Workspace + canvas memory 都做 **4 KB / 80 行** cap，超限 reject。
- Sandbox 双根：workspace root 是 `<workspace>/setting/`，canvas root 是 `<canvas>/.memory/`。`..` 逃逸直接 reject。

### 4.2 Workspace memory 的合并语义

只接 `patch`：每条 `diff` 里的非空行被当成 bullet 追加；trim 后已存在的 bullet 被跳过。**永远不删** — 用户手编内容必须保留。

### 4.3 Skill 写入门槛

- `op: "create"`：
  - 必须给 `rationale`，且 ≥ 20 字符（说明为什么不能 update 现有 skill）。
  - 同 id 已存在 → reject，提示用 update。
  - frontmatter 必填 `description` + `appliesTo`。
  - **`appliesTo` 必须包含调用方自己的 surface**（operate 写的 skill 要含 `'operate'`），否则它下一次 turn 在自己的 catalogue 里看不到 = 自我封禁。
- `op: "update"`：整体 replace body（caller 应先 read 旧 body、自己合并需要保留的内容再提交）。
- 写入成功立刻调 `invalidateUserSkill(id)`，下一次 `read("skills/<id>/SKILL.md")` 拿到新内容，不等 2s TTL。

### 4.4 写入策略（给 agent 看的）

每个 tool 描述里只写 mechanics（参数 / cap / 校验），**策略放在 SKILL.md 里**：

- Hub: [prompt/skills/memory/SKILL.md](../apps/server/src/prompt/skills/memory/SKILL.md) — 0–3 per turn、at most one per tier。
- 每层一份子文档（仅通过 `read()` 显式拉取，不进 catalogue）：
  - [write/workspace-memory-writing.md](../apps/server/src/prompt/skills/memory/write/workspace-memory-writing.md)
  - [write/canvas-memory-writing.md](../apps/server/src/prompt/skills/memory/write/canvas-memory-writing.md)
  - [write/skills-writing.md](../apps/server/src/prompt/skills/memory/write/skills-writing.md)

Curator AGENT.md 和 chat AGENT.md 都指向同一份子文档，避免规则两处漂移。

---

## 5. 关键文件位置

```
apps/server/src/
├── modules/
│   ├── agent/
│   │   ├── agent.route.ts                 # 首轮注入 workspace memory
│   │   └── memory/
│   │       ├── index.ts                   # enqueue(canvasId) 对外入口
│   │       ├── trigger.ts                 # op counter + state.json
│   │       ├── op-counter-hook.ts         # 全局 Fastify hook
│   │       ├── worker.ts                  # per-canvas single-flight
│   │       ├── analyzer.ts                # 拼 context → runAgent → 收 WriteResult
│   │       ├── writers.ts                 # 三个 writer 实现
│   │       ├── sandbox.ts                 # 双根路径校验
│   │       └── read.ts                    # readWorkspaceMemory / readCanvasMemory
│   ├── storage/
│   │   ├── paths.ts                       # settingDir / canvasMemoryPath / ...
│   │   └── migrate-memory.ts              # 旧 <canvas>/memory/preferences.md 一次性迁移
│   └── agent/tools/
│       ├── definitions.ts                 # 三个 memory_*_write tool 定义
│       └── handlers/
│           ├── memory-write.ts            # tool → writer 适配
│           └── fs-read.ts                 # read("memory/*.md") 分支
└── prompt/
    ├── agents/
    │   ├── memory/AGENT.md                # 后台 curator 的 system prompt
    │   ├── ask/AGENT.md                   # 含三个 write tool + memory section
    │   └── operate/AGENT.md               # 同上
    └── skills/
        ├── loader.ts                      # system / user 双源 + mtime-aware cache
        └── memory/
            ├── SKILL.md                   # 写入策略 hub
            └── write/
                ├── workspace-memory-writing.md
                ├── canvas-memory-writing.md
                └── skills-writing.md
```

---

## 6. 与现有系统的关系

- `events.jsonl` / chat thread 文件不动，curator 复用同一份数据。
- `<canvas>/.memory/` 进了 `ALWAYS_SKIP`（[fs-sandbox.ts](../apps/server/src/modules/agent/tools/handlers/fs-sandbox.ts)），grep / find / ls 都看不到；只能通过 `read("memory/canvas.md")` 这一条受控路径访问。
- 旧 `<canvas>/memory/preferences.md` 启动时由 `migrateLegacyMemory()` 一次性 mv 到 `.memory/canvas.md`。
- Skill loader 用 mtime + 2s TTL + `invalidateUserSkill(id)` 三层做到"写完即用"。System skill 缓存 once-and-done。

---

## 7. 安全 / 一致性边界

- 三个 writer 路径全部走 `MemorySandboxError` 校验。
- 单 Node 进程内 per-canvas single-flight 保证 curator 不并发写同一 canvas；workspace memory 没有跨进程 mutex（多进程部署需另行设计，目前 single-process 假设成立）。
- `markAnalyzed` 会推进 `lastSeenThreadCursor`，下一轮 chat digest 只看新 turn，不会重复扫历史。
- 个别 writer reject（rationale 太短、cap 超、appliesTo 缺自身）→ `WriteResult.ok=false`，worker 把它一起记进总结日志，下一次 trigger 重新尝试。

# Memory Module Design

> Status: Plan
> Last updated: 2026-05-27
> Related: [agent-architecture.md](./agent-architecture.md) · [canvas-storage.md](./canvas-storage.md) · [action-log.md](./action-log.md)

## 0. 目标

让 agent 在跨会话、跨画布的尺度上记住"用户是谁、画布在做什么、可复用做法是什么"，且：

- **非阻塞**：任何 chat / operate / sketch 流程的延迟为 0；记忆维护在主链路结束后静默跑。
- **可读 / 可改**：用户可见的两类（user preference、skills）落在 workspace 内的可编辑 markdown，AI 私有的工作记忆落在画布的隐藏目录。
- **谨慎写入**：尤其是 skills，必须先读、能更新就不新增，避免抽屉化。

非目标：thread 级记忆（已经在 chat-store 里），跨 workspace 的全局记忆。

---

## 1. 三层记忆

| 层                          | 范围   | 路径                                       | 用户可见                 | 用途                                          |
| --------------------------- | ------ | ------------------------------------------ | ------------------------ | --------------------------------------------- |
| Long-term (user preference) | 跨画布 | `<workspace>/setting/.huabu.md`            | ✅ 可读可改              | 用户画像、风格偏好、回答长短、配色 / 布局倾向 |
| Short-term (canvas memory)  | 单画布 | `<workspace>/<canvas>/.memory/canvas.md`   | ❌ 隐藏（同 `.history`） | 这张画布当前在做什么、目的、已确认的小决定    |
| Skill memory                | 跨画布 | `<workspace>/setting/skills/<id>/SKILL.md` | ✅ 可读可改              | 可复用的做法 / recipe                         |

**单文件约束**：workspace memory 和 canvas memory 都是单 markdown 文件，硬上限 4 KB body / 80 行。超限触发自压缩。Skill 没有体积上限，但新增门槛极高（见 §3.3）。

**与 system skills 的关系**：系统自带的 `skills/canvas/`、`skills/sketch-gestures/` 仍在 server 仓库里随程序发布，**用户不可改**。用户记忆产出的 skill 落在 workspace 的 `setting/skills/`。同名时主动拼接，详见 [memory-module-implementation.md §1](./memory-module-implementation.md#1-skills-双源)。

---

## 2. 触发与运行模型

### 2.1 触发条件

后端在 `POST /api/canvases/:canvasId/events` 已经计 ops（参考 [canvas.route.ts](../apps/server/src/modules/canvas/canvas.route.ts) 的 events 端点）。在 `appendEvents` 落盘成功后维护一个**画布级 op counter**：

- counter ≥ 100 → 触发一轮 memory analysis（按 canvas 排队，single-flight）
- 触发后 counter 清零
- counter 跨进程持久化在 `<canvas>/.memory/state.json`（小 JSON：`{ counter, lastAnalyzedAt, lastSeenThreadCursor }`）

### 2.2 运行模型

Memory 模块是 agent 模块下的 **sub-agent**，对外只暴露 `enqueue(canvasId)`。

- **完全后台**：用 `setImmediate` 派发，**不**走 SSE，**不**影响任何 chat thread。
- **Per-canvas single-flight**：同一画布若已有任务在跑，新触发只更新 pending 标志，不排队叠加。
- **失败静默**：异常只进日志（`logger.warn`），不回写任何用户可见状态。
- **可中断**：进程退出前不强制 flush；下一次启动靠 op counter 自然续跑。

### 2.3 输入 / 处理 / 输出

**输入打包**（一次性塞给 memory sub-agent，不让它再去查工具）：

1. Canvas snapshot — `canvas.json` 解出来的轻量结构（节点 `id / type / label / position`、edges 拓扑），**不**包含任何 `nodes/*.md` 全文，控制在 ~3 KB。
2. Chat session — 从上次 `lastSeenThreadCursor` 到现在所有 thread 的关键 turn（user message + assistant final text + tool 名字列表，不含 tool 大块结果）。
3. Recent ops — 最近 100 条 events.jsonl 记录。
4. 当前三层 memory 内容（preference / canvas.md / skills 目录索引）。

**LLM 一次推理**（用便宜模型，独立 `getMemoryModel()`）：

输出严格 JSON：

```json
{
  "longterm": null | { "op": "patch", "diff": "..." },
  "shortterm": null | { "op": "replace", "body": "..." },
  "skill": null | {
      "op": "create" | "update",
      "id": "...",
      "title": "...",
      "body": "...",
      "rationale": "..."
   }
}
```

三个字段都允许 `null`（这一轮不需要写）。**至多写一个 skill**（一轮分析不允许批量造 skill）。

**校验 + 写入**：分别走三个 memory tool，由 sub-agent 调用：

- `memory_workspace_write` — 合并到 `setting/.huabu.md`，去重 + 行数压缩。
- `memory_canvas_write` — 整体覆盖 `<canvas>/.memory/canvas.md`，超长触发同 LLM 自压缩。
- `memory_skill_write` — 必须先 `read("skills/")` 看现有，op=create 时拒绝同名（除非用户层面冲突，转 merge），op=update 时合并 body。

### 2.4 使用流程

读路径在 [agent.route.ts](../apps/server/src/modules/agent/agent.route.ts) 现有的 preamble push 旁边再加一条 `memoryPreamble`：

```
[SYSTEM Memory]
[Long-term preferences]
{{longterm}}
[Working memory — this canvas]
{{shortterm}}
```

- 已经在 `buildHistoryItems` 的 `[SYSTEM` 剔除规则里，free 隐身。
- Skills 不走 preamble，沿用现有 `read("skills/<id>/SKILL.md")` 的 on-demand 加载，只是 catalogue 现在合并了 system + user skills（见实现文档 §1）。
- 前端零改动，零渲染。

---

## 3. 设计约束

### 3.1 短小精炼

- Long-term：bullet list 为主，每条 ≤ 80 字符，整体 ≤ 4 KB。
- Short-term：自由 markdown，但同样 ≤ 4 KB / 80 行。
- 超限：触发一次 LLM consolidate（同 sub-agent 复用），压缩回 ≤ 2 KB。

### 3.2 增量 vs 覆盖

- Long-term：增量 patch（diff 风格），避免覆盖人工编辑。
- Short-term：整体 replace，因为它就是 AI 的草稿本，人工编辑预期较少。
- Skills：update 时 body 合并 (人工段落保留)，create 时整文件写入。

### 3.3 Skill 写入门槛

LLM 想造新 skill 必须满足：

1. 已读完 `setting/skills/` 全部现有 SKILL.md 的 frontmatter description。
2. 给出 `rationale` 说明为什么现有 skill 无法 update 覆盖。
3. 内容必须是**可复用的做法**（recipe / pattern），不是单次操作日志。

这三条由 memory sub-agent 的 system prompt + `memory_skill_write` handler 联合校验，handler 看到 op=create 但 rationale 为空直接 reject。

### 3.4 安全

- 三个 memory write tool 都用现有 `safeResolve` 同款 sandbox 思路，但根目录换成 workspace（workspace memory / skills）或 `<canvas>/.memory/`（canvas memory）。新建 `memorySandbox` 模块，禁止 `..` 逃逸。
- Memory sub-agent **不持有** read / grep / find / ls / canvas_commands / web_search，工具白名单只有三个 memory write + `read`（且 `read` 只放行 `skills/` 和 `memory/` 前缀，便于自查）。

---

## 4. 文件落点

```
apps/server/src/modules/agent/memory/
  index.ts                ← 对外暴露 enqueue(canvasId)
  trigger.ts              ← op counter + state.json 持久化
  worker.ts               ← single-flight 队列 + setImmediate dispatch
  analyzer.ts             ← 拼输入 → memory sub-agent → 解析输出
  writers/
    longterm.ts           ← setting/.huabu.md 读 / 合并 / 写
    shortterm.ts          ← <canvas>/.memory/canvas.md 读 / 写
    skill.ts              ← setting/skills/<id>/SKILL.md 读 / 合并 / 写
  sandbox.ts              ← workspace + canvas 双根 safeResolve
  tools.ts                ← 三个 memory write tool 定义（pi-ai Tool shape）

apps/server/src/prompt/agents/memory/
  AGENT.md                ← memory sub-agent 的 system prompt
```

存储路径常量加进 [paths.ts](../apps/server/src/modules/storage/paths.ts)：

```ts
export function settingDir(): string; // <workspace>/setting/
export function workspaceMemoryPath(): string; // <workspace>/setting/.huabu.md
export function userSkillsDir(): string; // <workspace>/setting/skills/
export function canvasMemoryDir(canvasId): string; // <canvas>/.memory/
export function canvasMemoryPath(canvasId): string; // <canvas>/.memory/canvas.md
export function memoryStatePath(canvasId): string; // <canvas>/.memory/state.json
```

> 现有的 `memoryDir()` / `prefsPath()`（`<canvas>/memory/preferences.md`）废弃迁移：内容若非空，启动期一次性 mv 到 `<canvas>/.memory/canvas.md`。

---

## 5. 与现有系统的交接

| 现有                                                                                                 | 变更                                                                 |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| [`CanvasStore.readPreferences/writePreferences`](../apps/server/src/modules/storage/canvas-store.ts) | 删除（被 canvas-memory writer 取代）                                 |
| `<canvas>/memory/` 目录                                                                              | 启动迁移到 `<canvas>/.memory/`，前缀加 `.` 让它进 `ALWAYS_SKIP` 一类 |
| `events.jsonl`                                                                                       | 不变，memory trigger 复用同一份数据                                  |
| `skills/canvas/`、`skills/sketch-gestures/`                                                          | 不变，归类为 **system**（见实现文档 §1）                             |
| skill-loader                                                                                         | 重写为多源 loader，system + user merged（见实现文档 §1）             |
| prompt 目录                                                                                          | 重排，loader 下沉到对应子目录（见实现文档 §2）                       |

---

## 6. 上线顺序

1. **PR-A**：prompt 目录重排 + skill-loader 多源化（实现文档 §1、§2），不引入任何 memory 逻辑，纯重构。
2. **PR-B**：storage paths + 迁移脚本 + `<canvas>/.memory/` 切换。
3. **PR-C**：memory sub-agent 骨架（worker + trigger + stub analyzer，写入路径走 dry-run 只打日志）。
4. **PR-D**：接 LLM analyzer + 三个 writer 真实写入。
5. **PR-E**：preamble 注入到 ask / operate AGENT.md，做端到端联调。

每个 PR 独立可回滚，PR-A/B 落地后即使 memory 模块 (C-E) 不开启，整套 prompt / skill 体系也比现在更整洁。
