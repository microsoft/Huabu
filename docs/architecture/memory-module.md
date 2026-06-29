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

**Skill 双源**：系统自带 skill 在 `apps/server/src/prompt/skills/<id>/`（随程序发布、用户不可改）；用户 / curator 写的 skill 在 `<workspace>/setting/skills/<id>/`。同 id 时按"system 在前 + user 追加"合并，loader 在 [skills/loader.ts](../../apps/server/src/prompt/skills/loader.ts) 实现。

---

## 2. 触发 — 谁来写、什么时候写

写入有 **两条路径**，互不冲突：

### 2.1 后台 curator（自动）

- 每个 canvas 维护一个 op counter，落在 `<canvas>/.memory/state.json`。
- 任何 _mutating_ HTTP 请求（PUT / POST / PATCH / DELETE，对应 canvas 的）由 Fastify hook 统一计数，详见 [memory/op-counter-hook.ts](../../apps/server/src/modules/agent/memory/op-counter-hook.ts)。
  - `POST /api/canvas/<id>/events` 按 `events.length` 计权（一次 flush 五个动作 = +5）。
  - 其它请求一律 +1。
  - 失败响应（4xx / 5xx）不计。
- counter ≥ `OP_THRESHOLD = 50` → 触发一轮 memory 分析。trigger 内部立刻清零，避免重复触发。
- 触发后走 **per-canvas single-flight** 的 worker（[memory/worker.ts](../../apps/server/src/modules/agent/memory/worker.ts)）：已在跑的直接 set pending flag，不排队。
- `setImmediate` dispatch — 路由先 response 给客户端，curator 在下一 tick 才开始。
- 失败只 warn 不抛，下一次触发自然重试。
- curator 用 [agents/memory/AGENT.md](../../apps/server/src/prompt/agents/memory/AGENT.md)，最多 5 iterations，sequential 工具调用。

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

实现在 [tools/handlers/fs-read.ts](../../apps/server/src/modules/agent/tools/handlers/fs-read.ts)；未知 `memory/*.md` 路径直接报错给 agent 看。

**注入策略**：

- **首轮**：route 在第一条 message 前推一条 `[SYSTEM Workspace memory ...]`，把 `.huabu.md` 内容塞给 agent（保证 cross-canvas 偏好对首句生效）。见 [agent.route.ts](../../apps/server/src/modules/agent/agent.route.ts) 的 isFirstTurn 块。
- **后续轮**：不再主动注入。Skill catalogue 和 memory 入口在 system prompt 的"Available skills / memory"段里被列出来，agent 自己判断要不要 `read()`。
- `[SYSTEM` 开头的 user message 在 chat 历史渲染时被自动剔除，前端无感。

Canvas memory **永远是 pull-only** — 体积偏大、情境性强，由 agent 决定是否拉。

---

## 4. 写 — `fs_write` 单一入口

所有三层 memory 共用一个 tool：`fs_write({ path, mode, ... })`。Agent 通过虚拟 `path` 选择目标，通过 `mode` 选择写法。失败一律返回结构化 `WriteResult`（`{ ok, target, reason }`），不抛异常。

| `path`                 | 对应文件                                   | 备注                               |
| ---------------------- | ------------------------------------------ | ---------------------------------- |
| `memory/workspace.md`  | `<workspace>/setting/.huabu.md`            | 跨画布用户画像，纯 bullet markdown |
| `memory/canvas.md`     | `<canvas>/.memory/canvas.md`               | 单画布情境简报                     |
| `skills/<id>/SKILL.md` | `<workspace>/setting/skills/<id>/SKILL.md` | 用户 skill；新建需要 `rationale`   |

两种 mode 在每条 path 上都可用：

- `mode: "overwrite"` — `body` 整体覆盖。文件不存在时即创建。
- `mode: "replace_string"` — 找到唯一出现的 `oldString`，替换为 `newString`。文件必须存在；匹配 0 或 ≥2 次都 reject。

实现：路由 + 校验在 [tools/handlers/fs-write.ts](../../apps/server/src/modules/agent/tools/handlers/fs-write.ts)，磁盘原语在 [memory/writers.ts](../../apps/server/src/modules/agent/memory/writers.ts)，路径沙箱在 [memory/sandbox.ts](../../apps/server/src/modules/agent/memory/sandbox.ts)。

### 4.1 共同约束

- Workspace + canvas memory 都做 **4 KB / 80 行** cap，超限 reject（overwrite 和 replace_string 都校验合并后大小）。Skill 文件不做体积 cap。
- Sandbox 双根：workspace root 是 `<workspace>/setting/`，canvas root 是 `<canvas>/.memory/`。`..` 逃逸直接 reject。
- `replace_string` 的"恰好一次"规则是安全契约：歧义由 agent 通过补充更多上下文消除，不让 writer 猜。

### 4.2 Workspace memory 的纪律

不再有 writer 层的"只增不删"硬保护——overwrite 可以替换整文件。靠 prompt 纪律（`prompt/skills/memory/write/workspace-memory-writing.md`）顶住："默认用 `replace_string`，永远不通过 `overwrite` 删除用户手编 bullet"。Agent 必须先 `read("memory/workspace.md")`，明确知道当前内容，再决定改什么。

### 4.3 Skill 写入门槛

- **创建新 skill**（target 不存在 + `mode: "overwrite"`）：
  - 必须给 `rationale`，且 ≥ 20 字符（说明为什么不能 update 现有 skill）。Handler 在 `existsSync(absPath) === false` 时强校验。
  - `body` 必须包含完整 frontmatter fence（writer 不再代为渲染）。
  - **`appliesTo` 必须包含调用方自己的 surface**（operate 写的 skill 要含 `'operate'`），否则它下一次 turn 在自己的 catalogue 里看不到 = 自我封禁。这条由 prompt 纪律保证，loader 不做校验。
- **修改既有 skill**：`mode: "replace_string"`（推荐）或 `mode: "overwrite"`（结构性大改时）。两者都要求 agent 先 `read("skills/<id>/SKILL.md")`：replace_string 需要唯一 `oldString`，overwrite 需要完整旧 body。
- 写入成功立刻调 `invalidateUserSkill(id)`，下一次 `read("skills/<id>/SKILL.md")` 拿到新内容，不等 2s TTL。

### 4.4 写入策略（给 agent 看的）

工具描述里只写 mechanics（参数 / cap / 校验），**策略放在 write 子文档里**（仅通过 `read()` 显式拉取，不进 catalogue）：

- [write/workspace-memory-writing.md](../../apps/server/src/prompt/skills/memory/write/workspace-memory-writing.md)
- [write/canvas-memory-writing.md](../../apps/server/src/prompt/skills/memory/write/canvas-memory-writing.md)
- [write/skills-writing.md](../../apps/server/src/prompt/skills/memory/write/skills-writing.md)

Curator AGENT.md 和 chat AGENT.md 都指向同一份子文档，避免规则两处漂移。

---

## 5. 关键文件位置

| 主题                               | 文件                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 首轮注入 workspace memory          | [agent.route.ts](../../apps/server/src/modules/agent/agent.route.ts)                                                                                                                                                                                                                                                       |
| 对外入口 `enqueue(canvasId)`       | [memory/index.ts](../../apps/server/src/modules/agent/memory/index.ts)                                                                                                                                                                                                                                                     |
| op counter + state.json            | [memory/trigger.ts](../../apps/server/src/modules/agent/memory/trigger.ts)                                                                                                                                                                                                                                                 |
| 全局 Fastify hook                  | [memory/op-counter-hook.ts](../../apps/server/src/modules/agent/memory/op-counter-hook.ts)                                                                                                                                                                                                                                 |
| per-canvas single-flight           | [memory/worker.ts](../../apps/server/src/modules/agent/memory/worker.ts)                                                                                                                                                                                                                                                   |
| context → runAgent → WriteResult   | [memory/analyzer.ts](../../apps/server/src/modules/agent/memory/analyzer.ts)                                                                                                                                                                                                                                               |
| overwrite + replace_string 原语    | [memory/writers.ts](../../apps/server/src/modules/agent/memory/writers.ts)                                                                                                                                                                                                                                                 |
| 双根路径校验                       | [memory/sandbox.ts](../../apps/server/src/modules/agent/memory/sandbox.ts)                                                                                                                                                                                                                                                 |
| read 入口                          | [memory/read.ts](../../apps/server/src/modules/agent/memory/read.ts)                                                                                                                                                                                                                                                       |
| 路径助手                           | [storage/paths.ts](../../apps/server/src/modules/storage/paths.ts)                                                                                                                                                                                                                                                         |
| 旧 memory 迁移                     | [storage/migrate-memory.ts](../../apps/server/src/modules/storage/migrate-memory.ts)                                                                                                                                                                                                                                       |
| `fs_write` 工具定义                | [tools/definitions.ts](../../apps/server/src/modules/agent/tools/definitions.ts)                                                                                                                                                                                                                                           |
| fs_write handler                   | [tools/handlers/fs-write.ts](../../apps/server/src/modules/agent/tools/handlers/fs-write.ts)                                                                                                                                                                                                                               |
| fs_read handler                    | [tools/handlers/fs-read.ts](../../apps/server/src/modules/agent/tools/handlers/fs-read.ts)                                                                                                                                                                                                                                 |
| curator system prompt              | [agents/memory/AGENT.md](../../apps/server/src/prompt/agents/memory/AGENT.md)                                                                                                                                                                                                                                              |
| chat agents                        | [ask/AGENT.md](../../apps/server/src/prompt/agents/ask/AGENT.md) · [operate/AGENT.md](../../apps/server/src/prompt/agents/operate/AGENT.md)                                                                                                                                                                                |
| skill loader（双源 + mtime cache） | [skills/loader.ts](../../apps/server/src/prompt/skills/loader.ts)                                                                                                                                                                                                                                                          |
| 写入策略子文档                     | [memory/write/workspace-memory-writing.md](../../apps/server/src/prompt/skills/memory/write/workspace-memory-writing.md) · [canvas-memory-writing.md](../../apps/server/src/prompt/skills/memory/write/canvas-memory-writing.md) · [skills-writing.md](../../apps/server/src/prompt/skills/memory/write/skills-writing.md) |

---

## 6. 与现有系统的关系

- `events.jsonl` / chat thread 文件不动，curator 复用同一份数据。
- `<canvas>/.memory/` 进了 `ALWAYS_SKIP`（[fs-sandbox.ts](../../apps/server/src/modules/agent/tools/handlers/fs-sandbox.ts)），grep / find / ls 都看不到；只能通过 `read("memory/canvas.md")` 这一条受控路径访问。
- 旧 `<canvas>/memory/preferences.md` 启动时由 `migrateLegacyMemory()` 一次性 mv 到 `.memory/canvas.md`。
- Skill loader 用 mtime + 2s TTL + `invalidateUserSkill(id)` 三层做到"写完即用"。System skill 缓存 once-and-done。

---

## 7. 安全 / 一致性边界

- 所有写入路径都经过 `MemorySandboxError` 校验。
- 单 Node 进程内 per-canvas single-flight 保证 curator 不并发写同一 canvas；workspace memory 通过模块内 `workspaceMemoryLock` 串行化跨 canvas 的并发写。多进程部署需另行设计，目前 single-process 假设成立。
- `markAnalyzed` 会推进 `lastSeenThreadCursor`，下一轮 chat digest 只看新 turn，不会重复扫历史。
- 写入失败（rationale 太短、cap 超、`oldString` 不唯一等）→ `WriteResult.ok=false`，worker 把它一起记进总结日志，下一次 trigger 重新尝试。
