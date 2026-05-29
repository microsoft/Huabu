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
| Short-term (working memory) | 单画布 | `<workspace>/<canvas>/.memory/canvas.md`   | ❌ 隐藏（同 `.history`） | 这张画布当前在做什么、目的、已确认的小决定    |
| Skill memory                | 跨画布 | `<workspace>/setting/skills/<id>/SKILL.md` | ✅ 可读可改              | 可复用的做法 / recipe                         |

**单文件约束**：workspace memory 和 working memory 都是单 markdown 文件，硬上限 4 KB body / 80 行。超限触发自压缩。Skill 没有体积上限，但新增门槛极高（见 §3.3）。

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

- 三个 memory write tool 都用现有 `safeResolve` 同款 sandbox 思路，但根目录换成 workspace（workspace memory / skills）或 `<canvas>/.memory/`（working memory）。新建 `memorySandbox` 模块，禁止 `..` 逃逸。
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
export function workingMemoryDir(canvasId): string; // <canvas>/.memory/
export function workingMemoryPath(canvasId): string; // <canvas>/.memory/canvas.md
export function memoryStatePath(canvasId): string; // <canvas>/.memory/state.json
```

> 现有的 `memoryDir()` / `prefsPath()`（`<canvas>/memory/preferences.md`）废弃迁移：内容若非空，启动期一次性 mv 到 `<canvas>/.memory/canvas.md`。

---

## 5. 与现有系统的交接

| 现有                                                                                                 | 变更                                                                 |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| [`CanvasStore.readPreferences/writePreferences`](../apps/server/src/modules/storage/canvas-store.ts) | 删除（被 working-memory writer 取代）                                    |
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
