# Canvas Action Log: Persistent User-Intent Trail

> Status: Plan (not yet executed)
> Last updated: 2026-05-09
> Related: [agent-context.md](./agent-context.md) · [canvas-storage-refactor.md](./canvas-storage-refactor.md)

## 0. 目标与非目标

**目标**

- 把目前只存在内存里、容量 10、无时间戳的 `actionHistory`(见
  [apps/web/src/store/canvasStore.ts](../apps/web/src/store/canvasStore.ts))
  持久化到 `<canvasId>/.history/events.jsonl`。
- 给 agent 一份**长期、可查询**的用户行为轨迹,用于推断意图。
- 在喂给 LLM 的那一刻把 JSONL 渲染成 Markdown 表格,最大化模型可读性。
- 不破坏现有的 autosave / undo / agent 上下文链路。

**非目标(留到后续 PR)**

- `memory/journal.md`(LLM 周期性总结的人类可读工作日记)。
- 跨 canvas 的全局意图索引。

---

## 1. 核心决策:JSONL 存事实,Markdown 当视图

| 角色         | 形式                                           | 理由                                                              |
| ------------ | ---------------------------------------------- | ----------------------------------------------------------------- |
| 持久化事实层 | **JSONL** (`<canvasId>/.history/events.jsonl`) | 追加 O(1)、崩溃局部化、滚动归档容易、与现有结构化 `.history` 一致 |
| LLM 消费视图 | **Markdown 表格**(注入 system message)         | 模型对 Markdown 表格理解度最高                                    |
| 长程人类日记 | (PR 5+) **`memory/journal.md`**                | LLM 周期性把 jsonl 总结成段落                                     |
| 工具结果     | **JSON**(`get_canvas_actions` 返回)            | 工具消费走结构化更稳;Markdown 留给 system context                 |

> **不要把日志直接写成 Markdown**。Markdown 在追加写、schema 演化、机器查询上
> 都有硬伤;模型对 Markdown 友好的是"自然语言段落",而非"高频固定 schema 事件"。

---

## 2. 存储层:JSON → JSONL (PR 1)

### 2.1 新增 IO 原语

[apps/server/src/modules/storage/io.ts](../apps/server/src/modules/storage/io.ts) 增加:

```ts
/** Append a single JSON object as one line. Atomic per-line on POSIX. */
export function appendJsonLine<T>(filePath: string, item: T): void {
  mkdirp(path.dirname(filePath));
  // Single fs.appendFileSync = one write(2). Crash-safe at line boundary.
  appendFileSync(filePath, JSON.stringify(item) + '\n', 'utf-8');
}

/** Read a JSONL file and parse each non-empty line. Skips malformed lines. */
export function readJsonLines<T>(filePath: string, limit?: number): T[] {
  if (!existsSync(filePath)) return [];
  const raw = readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n');
  const out: T[] = [];
  // Read tail when limit is set so "tail N" is O(N) over recent lines.
  const start = limit != null ? Math.max(0, lines.length - limit - 1) : 0;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      /* skip malformed */
    }
  }
  return out;
}
```

> 保留 `appendJsonArray` 不动,继续给 `intent.json` 等低频结构化数据使用。

### 2.2 路径切换

[apps/server/src/modules/storage/paths.ts](../apps/server/src/modules/storage/paths.ts):

```ts
// before:  events.json
// after:   events.jsonl
export function eventsPath(canvasId: string): string {
  return path.join(historyDir(canvasId), 'events.jsonl');
}
```

### 2.3 `CanvasStore` API 升级

[apps/server/src/modules/storage/canvas-store.ts](../apps/server/src/modules/storage/canvas-store.ts):

```ts
appendEvent(payload: RecentAction): void {
  appendJsonLine<CanvasEvent>(eventsPath(this.canvasId), {
    ts: Date.now(), payload,
  });
}

readEvents(limit?: number): CanvasEvent[] {
  return readJsonLines<CanvasEvent>(eventsPath(this.canvasId), limit);
}

/** Bulk append used by the batch endpoint. One write call for N events. */
appendEvents(events: Array<{ payload: RecentAction; ts?: number }>): void {
  // Build a single string with N lines, then one appendFileSync.
}
```

---

## 3. 事件 Schema (PR 1)

`packages/shared/src/types/agent/events.ts` 新增:

```ts
import type { RecentAction } from './context.js';

/** What we store on disk per line in events.jsonl. */
export interface CanvasEventRecord {
  ts: number; // Date.now() at capture time
  payload: RecentAction;
}
```

---

## 4. 上报通道:浏览器 → 服务端 (PR 2)

### 4.1 服务端路由

[apps/server/src/modules/canvas/canvas.route.ts](../apps/server/src/modules/canvas/canvas.route.ts) 新增:

```
POST /api/canvas/:canvasId/events    body: { events: CanvasEventRecord[] }
GET  /api/canvas/:canvasId/events    query: { limit?: number, since?: number }
```

- POST → `store.appendEvents(...)`,zod 校验,**单次 ≤ 200 条事件 / 总 64 KB**。
- GET → `store.readEvents(limit)` + 按 `since` 过滤,默认返回最近 100 条。

### 4.2 前端 API 客户端

新增 `apps/web/src/api/canvasEvents.ts`:

```ts
export function postCanvasEvents(
  canvasId: string,
  events: CanvasEventRecord[],
  opts?: { keepalive?: boolean },
): Promise<void> { ... }

export function getCanvasEvents(
  canvasId: string,
  params?: { limit?: number; since?: number },
): Promise<CanvasEventRecord[]> { ... }
```

`apps/web/src/api/_routes.ts` 加:

```ts
canvasEvents: (id: string) => `/canvas/${enc(id)}/events`,
```

### 4.3 store 触发点

[apps/web/src/store/canvasStore.ts](../apps/web/src/store/canvasStore.ts) 新增 outgoing 缓冲:

```ts
const eventBuffer = new Map<string, CanvasEventRecord[]>(); // canvasId -> events
function recordEvent(canvasId: string, action: RecentAction) {
  const list = eventBuffer.get(canvasId) ?? [];
  list.push({ ts: Date.now(), kind: 'action', payload: action });
  eventBuffer.set(canvasId, list);
  scheduleEventFlush();
}
```

接入三处现有写点:

- `dispatchUiIntent` 的 `for (const action of execution.trace)` 循环(canvasStore.ts:582-591)
- `undo`(canvasStore.ts:1258)
- `redo`(canvasStore.ts:1277)

### 4.4 Flush 策略(三段式)

| 时机                               | 用途                                  |
| ---------------------------------- | ------------------------------------- |
| autosave 1s 防抖 piggy-back        | 常态批量上报,与画布保存同节奏         |
| agent 请求前 immediate             | 让服务端先落盘,context 才看到完整轨迹 |
| `beforeunload` + `keepalive: true` | 兜底,避免关 tab 丢最后一段            |

---

## 5. 喂给 Agent:JSONL → Markdown (PR 3)

### 5.1 Markdown 渲染器

`apps/server/src/modules/agent/recent-actions.ts`(新文件):

```ts
export function formatRecentActionsAsMarkdown(
  events: CanvasEventRecord[],
  now: number = Date.now(),
  maxTokens = 1500,
): string {
  if (events.length === 0) return '';
  const rows = events.map((e) => {
    const dt = relTime(now - e.ts); // e.g. "-3m12s", "-1h05m"
    const a = e.payload;
    return `| ${dt} | ${a.action} | ${describeTargets(a)} |`;
  });
  // Trim oldest lines until under maxTokens (use gpt-tokenizer).
  return [
    '## Recent canvas actions (oldest → newest)',
    '',
    '| time | action | targets |',
    '|------|--------|---------|',
    ...trimByTokens(rows, maxTokens),
  ].join('\n');
}
```

`describeTargets` 针对 16 种 `RecentAction` 各自抽出最有信息量的标签
(`label` 优先、退回 `id` 末 6 位)。

### 5.2 拼进 system message

[apps/server/src/modules/agent/agent.route.ts](../apps/server/src/modules/agent/agent.route.ts) 接到请求后:

```ts
const events = getCanvasStore(canvasId).readEvents(40); // long window
const md = formatRecentActionsAsMarkdown(events);
if (md) {
  systemMessages.push({
    role: 'system',
    content: `[SYSTEM Context]\n[Recent Canvas Actions]\n${md}`,
  });
}
```

### 5.3 与现有 `recentActions` 的关系

PR 3 期间**双轨保留**:

- `canvasContext.recentActions` 仍带前端短窗口 10 条(无时间戳),
  对应"未及上报但已发生的最新动作"。
- 服务端 jsonl 提供"近期意图节奏"(40 条 + 时间戳)。

待 PR 4 验稳后再考虑去掉前端那一份(由前端在请求即将发出时强制 flush 即可对齐)。

### 5.4 Token 预算

- 默认上限 **1500 tokens**(约 80–120 条)。
- 用 `gpt-tokenizer` 估算,从最旧的开始裁。

---

## 6. 让 Agent 主动查 (PR 4)

### 6.1 工具定义

[apps/server/src/modules/agent/tools/definitions.ts](../apps/server/src/modules/agent/tools/definitions.ts) 加:

```ts
export const getCanvasActionsParamsSchema = Type.Object({
  ...OptionalCanvasIdField,
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 500 })),
  since: Type.Optional(
    Type.Number({
      description: 'Unix ms; only return events with ts >= since',
    }),
  ),
  kinds: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Filter by action kind, e.g. ["node_created","node_edited"]',
    }),
  ),
});

export const getCanvasActionsTool: ToolDefinition = {
  name: 'get_canvas_actions',
  label: 'Get Canvas Actions',
  description:
    'Read the persisted action log of a canvas. Returns up to `limit` recent ' +
    'events (default 50). Use this when you need to understand what the user ' +
    'has been doing over a longer window than the system context provides.',
  parameters: getCanvasActionsParamsSchema,
};
```

注册到 `chatTools` 与 `operateTools`。

### 6.2 Handler

[apps/server/src/modules/agent/tools/handlers/canvas-read.ts](../apps/server/src/modules/agent/tools/handlers/canvas-read.ts) 加:

```ts
export async function handleGetCanvasActions(
  args: GetCanvasActionsArgs,
): Promise<string> {
  const events = getCanvasStore(args.canvasId).readEvents(args.limit ?? 50);
  const filtered = applyFilters(events, args);
  return JSON.stringify({
    canvasId: args.canvasId,
    count: filtered.length,
    events: filtered,
  });
}
```

> 工具结果默认返回 **JSON**(不在工具层 render Markdown):
> 工具结果会被塞回 `tool_result`,模型消化结构化数据更可控;
> Markdown 那一份留给 §5.2 的 system message 注入路径。

---

## 7. 边界与运维(贯穿所有 PR)

| 关注点                   | 处理                                                                                                                                     |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **写放大**               | autosave debounce (1s) + agent 请求前 immediate flush。压测目标:拖 60s ≤ 60 个 append                                                    |
| **崩溃半行**             | `readJsonLines` 跳过解析失败行;`console.warn` 上报但不抛                                                                                 |
| **文件体积**             | 单文件 ≥ **5 MB** 触发滚动:rename → `events.<YYYYMMDD-HHmm>.jsonl`,新文件继续 append。`readEvents` 只读当前活跃文件                      |
| **canvas 删除**          | `CanvasStore.destroy()` 已经 `rm -rf canvasRoot`,自然带走 `.history/`                                                                    |
| **canvas export**        | 现有 zip 流程默认 `includeHistory`,自动包进 jsonl                                                                                        |
| **多 tab 写同一 canvas** | `appendFileSync` POSIX 单 write 原子;行不会交错。`putCanvas` 的 version 检查保留                                                         |
| **PII / 隐私**           | payload 只存 `NodeRef`(id/type/label/origin),不含正文;与现有 `recentActions` 等价                                                        |
| **测试**                 | `io.test.ts` jsonl round-trip / 坏行跳过;`canvas-store.test.ts` `appendEvent + readEvents(limit)`;`recent-actions.test.ts` Markdown 渲染 |

---

## 8. PR 切分

| PR                        | 交付内容                                                                                                     | 风险                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------- |
| **PR 1** · storage 层     | `appendJsonLine` / `readJsonLines`、`eventsPath → .jsonl`、`appendEvent/readEvents/appendEvents`、迁移、单测 | 低(无外部行为变化)               |
| **PR 2** · 上报链路       | 路由 POST/GET、前端 `canvasEvents` API、store 三处接入 + flush 策略                                          | 中(动到 store 热路径,需性能验证) |
| **PR 3** · context 注入   | `formatRecentActionsAsMarkdown`、agent.route 拼接、token 预算裁剪                                            | 中(影响 prompt,需回归 chat 质量) |
| **PR 4** · agent 工具     | `get_canvas_actions` 工具定义 + handler + 注册到 chat/operate                                                | 低                               |
| **(可选) PR 5** · journal | `memory/journal.md` 周期性 LLM 摘要                                                                          | 单独立项                         |

---

## 9. 可观测性

- 后端:每次 `appendEvents` 落 `console.log` 记录条数与字节数(开发期)。
- 前端 dev build:`recordEvent` 后 `console.debug('[event]', action.action)`,
  便于交互调试。
- 长期:把单次上报的 `count / size / latency` 纳入既有 telemetry,如果将来要做。

---

## 10. 未决事项(实施前需要确认)

1. **flush 策略**:autosave piggy-back (1s 防抖) + agent 请求前 immediate +
   `beforeunload` keepalive。
2. **滚动阈值**:单文件 ≥ 5 MB 时归档为 `events.<YYYYMMDD-HHmm>.jsonl`。
3. **context 注入条数**:默认读 40 条 + 1500 tokens 上限裁剪。
4. **是否同时保留前端 `recentActions`**:PR 3 期间双轨,PR 4 后再决定。
5. **PR 顺序**:1 → 2 → 3 → 4。

---

## 11. 涉及文件速查

| 模块                   | 文件                                                                                                                          |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 存储 IO                | [apps/server/src/modules/storage/io.ts](../apps/server/src/modules/storage/io.ts)                                             |
| 路径                   | [apps/server/src/modules/storage/paths.ts](../apps/server/src/modules/storage/paths.ts)                                       |
| CanvasStore            | [apps/server/src/modules/storage/canvas-store.ts](../apps/server/src/modules/storage/canvas-store.ts)                         |
| 迁移                   | [apps/server/src/modules/storage/migrate.ts](../apps/server/src/modules/storage/migrate.ts)                                   |
| Canvas 路由            | [apps/server/src/modules/canvas/canvas.route.ts](../apps/server/src/modules/canvas/canvas.route.ts)                           |
| Agent 上下文           | [apps/server/src/modules/agent/agent.route.ts](../apps/server/src/modules/agent/agent.route.ts)                               |
| 工具定义               | [apps/server/src/modules/agent/tools/definitions.ts](../apps/server/src/modules/agent/tools/definitions.ts)                   |
| 工具 handler           | [apps/server/src/modules/agent/tools/handlers/canvas-read.ts](../apps/server/src/modules/agent/tools/handlers/canvas-read.ts) |
| 前端 store             | [apps/web/src/store/canvasStore.ts](../apps/web/src/store/canvasStore.ts)                                                     |
| 前端 API               | apps/web/src/api/canvasEvents.ts (新增)                                                                                       |
| Shared schema          | packages/shared/src/types/agent/events.ts (新增)                                                                              |
| 既有 RecentAction 类型 | [packages/shared/src/types/agent/context.ts](../packages/shared/src/types/agent/context.ts)                                   |
