# pi-agent-core 迁移计划

## 背景

当前 `apps/server/src/modules/agent/` 下的 agent 循环是基于
`@earendil-works/pi-ai` 自研的：`runAgent`（[agent.service.ts](../apps/server/src/modules/agent/agent.service.ts)）
手写 `while` 循环、自己处理 `text_delta` / `toolUse` / 工具执行 / 上下文回填，
然后通过 `AsyncGenerator<StreamEvent>` 把事件喂给 `agent.route.ts` 的 SSE 通道。

`@earendil-works/pi-agent-core@0.74.0`（与 `pi-ai` 同版本一起发布）把这套循环
抽象成了 `Agent` 类 + `agentLoop()` 函数式 API，并且 `@earendil-works/pi-coding-agent`
基于它提供了一整套文件相关的 `AgentTool`（read / write / edit / bash / grep / find / ls），
每个工具都暴露 `*Operations` 接口可注入沙箱实现。

升级动机：

1. **铺路文件工具家族**：之后能直接 `createReadTool / createWriteTool / createEditTool`
2. 标准化的事件流（清晰的 turn / message / tool_execution 边界）
3. `before/afterToolCall` hooks，便于做权限、审计、审批
4. `parallel` / `sequential` 工具执行模式（operate 模式批量画布操作可加速）
5. `steer()` / `followUp()` 队列（用户中途插话不打断当前 tool 运行）
6. `terminate: true` 可让单个工具显式中止 loop

## 范围与非目标

| 项                                                             | 状态                  |
| -------------------------------------------------------------- | --------------------- |
| 替换 agent loop（`runAgent` 内部实现）                         | ✅ 已落地（Step 1）   |
| 引入 `pi-coding-agent` 的 read / write / edit 等工具           | ⏳ 后续（Step 2）     |
| 决定文件工具的沙箱边界（per-canvas / 全局工作区）              | ⏳ 后续（Step 3）     |
| 启用 steering / parallel / terminate 等高级特性                | ⏳ 后续（Step 4）     |
| 改造 `intent.service.ts`（仍用 `llmComplete`，不走 loop）      | ❌ 不动               |
| 改造 `preprocessing/provider-manager.ts`（仍用 `llmComplete`） | ❌ 不动               |
| Web 端代码                                                     | ❌ 零改动（详见下文） |

## Web 端影响：零改动

| 文件                                                                            | 现状                                                  | 升级后 |
| ------------------------------------------------------------------------------- | ----------------------------------------------------- | ------ |
| [apps/web/src/api/agent.ts](../apps/web/src/api/agent.ts)                       | 解析 `AgentStreamEvent` SSE                           | 不变   |
| [apps/web/src/hooks/useAgentStream.ts](../apps/web/src/hooks/useAgentStream.ts) | switch `text_delta` / `tool_start` / `tool_result` 等 | 不变   |
| 其他 web 文件                                                                   | 无 `pi-ai` / `pi-agent-core` 直接依赖                 | 不变   |

我们的 SSE 协议是「应用层自定义事件」（[packages/shared/src/types/agent/agent.ts](../packages/shared/src/types/agent/agent.ts)），
不是直接转发 pi-ai 的事件。只要服务端在迁移后仍 emit 同一组 `AgentStreamEvent`
（`meta` / `text_delta` / `thinking_delta` / `tool_start` / `tool_result` / `done` / `error` / `end`），UI 不需要任何改动。

## 历史会话兼容：天然兼容

`pi-agent-core` 的 `AgentMessage` 定义为：

```ts
type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];
```

是 pi-ai `Message` 的**超集**。所以 `.history/chat/<threadId>.json` 里旧的
`Context.messages` 数组可以直接喂给 `Agent` 的 `state.messages`，无需迁移脚本。
持久化时也按现有 schema 写回（`{ systemPrompt, messages }`），向后兼容。

## 事件映射

| pi-agent-core 事件                                                | 我们的 `AgentStreamEvent`                              |
| ----------------------------------------------------------------- | ------------------------------------------------------ |
| `message_update` 且 `assistantMessageEvent.type === 'text_delta'` | `text_delta`                                           |
| 同上，`'thinking_delta'`                                          | `thinking_delta`                                       |
| `tool_execution_start`                                            | `tool_start`（包含 toolName + 已验证的 args）          |
| `tool_execution_end`                                              | `tool_result`（取 `result.content` 中的 text 块拼接）  |
| `agent_end`                                                       | `done`（取最后一条 assistant message 的 text + usage） |
| 任何错误（含 stream error / tool throw）                          | `error`                                                |

注：相比当前实现，`tool_start` 现在会在工具**真正开始执行**时触发（参数已验证），
比原来 `toolcall_end`（仅模型完成 toolcall 序列化时触发）语义更准确，
但对 UI 表现一致（都是"工具准备执行"的提示）。

## 详细 Step 列表

### Step 1：替换 agent loop ✅ 已落地

#### 新增依赖

`apps/server/package.json`：

```jsonc
{
  "dependencies": {
    "@earendil-works/pi-agent-core": "^0.74.0", // 新增
    "@earendil-works/pi-ai": "^0.74.0", // 保留
  },
}
```

#### 实际改造点

1. **[apps/server/src/modules/agent/tools/definitions.ts](../apps/server/src/modules/agent/tools/definitions.ts)**
   每个 `Tool`（`webSearchTool`、`getNodeDetailTool`、`getCanvasStateTool`、
   `canvasCommandsTool`、`ingestContentTool`、`useSkillTool`）升级为带
   `label: string` 的 `ToolDefinition`（pi-ai `Tool` + UI label）。
   `execute` 不写在这里——保持纯 schema/description，便于复用。

2. **[apps/server/src/modules/agent/tools/index.ts](../apps/server/src/modules/agent/tools/index.ts)**
   导出工厂 `buildToolsForMode(mode, ctx: { canvasId? }) → AgentTool[]`，
   把 `canvasId` 注入到每个 tool 的 `execute` 闭包；`execute` 内部转调
   `executor.ts` 的 `executeTool(name, params, { canvasId })` 并把结果
   包成 `AgentToolResult<undefined>` 的 text content。
   工具抛错由 pi-agent-core 自动包成 `isError: true` 的 toolResult。

3. **[apps/server/src/modules/agent/agent.service.ts](../apps/server/src/modules/agent/agent.service.ts) 整体重写**：

   ```ts
   const agent = new Agent({
     initialState: {
       systemPrompt: context.systemPrompt,
       model: getLLMModel(),
       tools: buildToolsForMode(mode, { canvasId }),
       messages: context.messages,
     },
     convertToLlm: (msgs) => msgs as Message[],
     // pi-agent-core 在每次 LLM 调用前都会 await 这个 callback——长跑工具
     // 期间 OAuth token 该刷新就刷新。
     getApiKey: () => ensureApiKey(),
     toolExecution: 'parallel',
   });
   ```

   - 保留 `runAgent` 的 `AsyncGenerator<StreamEvent>` 签名，route 端零改动
   - **不传 `streamFn`**：pi-agent-core 默认走 pi-ai 的 `streamSimple`，已经
     是我们想要的行为；包一层只会多一层 OAuth 流程
   - 内部用一条 `agent.subscribe()` 同时做三件事：
     1. 收集 `agent_end` 用于桥接 generator 退出
     2. 计 `turn_end` 数实现 maxIterations 软上限
     3. 把事件 push 进队列供 generator `await` 取走
   - 退出条件：`agent_end` 事件 + `await runPromise` + `await agent.waitForIdle()`
   - **完成后必须把 `agent.state.messages` 同步回入参 `context.messages`**
     （route 层依赖 mutate 后的 context 做 saveContext）
     —— 用 `context.messages.length = 0; context.messages.push(...)` 保数组 identity

4. **[apps/server/src/modules/agent/agent.route.ts](../apps/server/src/modules/agent/agent.route.ts)** 几乎不动：
   - `runAgent({ mode, canvasId, context, signal, ... })` 签名保持
   - `cleanUpAbortedContext` 仍直接 mutate `context.messages` 数组
   - `saveContext` / `debouncedSave` / `flushSave` 全部保留
   - **删掉了 abort 时手动注入 `partialText` 的旧逻辑** —— pi-agent-core 在
     stream 被取消时会 `await response.result()` 拿到带 `stopReason: 'aborted'`
     的 final assistant message（包含中断前累计的文本），由 `runAgent` finally
     同步进 `context.messages`，刷新后 chat panel 仍能看到中断前的文本

5. **[apps/server/src/modules/agent/llm.ts](../apps/server/src/modules/agent/llm.ts) 不变**
   `llmStream` / `llmComplete` 仍然导出，供 `intent.service.ts` 使用。
   新增 `ensureApiKey()` 导出（`runAgent` 的 `getApiKey` callback 复用它）。

6. **[apps/server/src/modules/agent/intent.service.ts](../apps/server/src/modules/agent/intent.service.ts) 不变**
   它走 `llmComplete` + 自己处理 `validateToolCall`，不经过 agent loop。

7. **[apps/server/src/modules/preprocessing/provider-manager.ts](../apps/server/src/modules/preprocessing/provider-manager.ts) 不变**
   也是 `llmComplete` 单次调用。

#### 验收标准 ✅

- `pnpm typecheck` 通过 ✅
- `pnpm lint` 通过（0 errors，pre-existing warnings 无新增）✅
- `pnpm format` 通过 ✅
- 手动跑 ask 模式 + operate 模式各一条消息（待用户复测）：
  - SSE 事件序列与现状视觉一致
  - history 重放正确
  - stop（abort）后 cleanUpAbortedContext 仍能裁剪 orphan toolCall
  - reconnect 仍能拿到 buffered 事件

### Step 2（后续）：引入文件工具家族

新增依赖：`@earendil-works/pi-coding-agent@^0.74.0`

#### 推荐落地方案：facade + 整包依赖（短期）→ 上游协作（长期）

**短期（Step 2 当下落地）**：

1. `apps/server/package.json` 直接添加 `@earendil-works/pi-coding-agent@^0.74.0`
2. 新建 `apps/server/src/modules/agent/tools/file/index.ts` 作为唯一 facade，
   集中 re-import 所需工厂并注入 sandbox operations：

   ```ts
   import {
     createReadTool,
     createWriteTool,
     createEditTool,
     createGrepTool,
     createFindTool,
     createLsTool,
   } from '@earendil-works/pi-coding-agent';

   export function buildFileTools(opts: { cwd: string; ops: SandboxOps }) {
     return [
       createReadTool(opts.cwd, { operations: opts.ops.read }),
       createWriteTool(opts.cwd, { operations: opts.ops.write }),
       createEditTool(opts.cwd, { operations: opts.ops.edit }),
       createGrepTool(opts.cwd, { operations: opts.ops.grep }),
       createFindTool(opts.cwd, { operations: opts.ops.find }),
       createLsTool(opts.cwd, { operations: opts.ops.ls }),
     ];
   }
   ```

3. 业务层只 import 这一个 facade，不直接 `import '@earendil-works/pi-coding-agent'`。
   未来切换实现（上游拆 headless 包 / 自维护 fork / patch）只改这一个文件。

**中期（与 Step 2 并行推进）**：

去 [`@earendil-works/pi-coding-agent` 仓库](https://github.com/earendil-works) 提 issue/PR，
请求把 file tools 拆成 headless 子包（去掉 pi-tui hard dep），或者最低限度提供
subpath export `./tools/file/*`。论证点：

- server-side / non-TTY 场景下 pi-tui render 是 dead code
- file tools 的 execute 逻辑与 render 是清晰可分的（`wrapToolDefinition`
  本身就是把 schema/execute/render 三件套组合，render 完全可以是 optional）

**长期（基于上游响应）**：

- 上游接受拆包 → facade 里 swap 一行 import path 即可
- 上游不接受 → 评估在 monorepo 里通过 `pnpm patch` 改写 file tools 的 render
  imports 为 no-op stub。patch 范围可控，且我们的 facade 已经隔离了 blast radius

#### 行为上的副作用

> 💡 文件工具会通过 `throw` 抛错，pi-agent-core 会自动包成 `isError: true`。
> Step 1 已经在 `tool_execution_end` 分支预留了 `event.isError` 的 log
> breadcrumb，Step 2 不需要再补线。

### Step 3（后续）：决定 sandbox 边界

| 选项          | 说明                                                                               |
| ------------- | ---------------------------------------------------------------------------------- |
| A（推荐默认） | cwd 绑定 `getCanvasStore(canvasId).artifactsDir()`，AI 只能读写当前画布 artifacts/ |
| B             | mode 区分，operate 模式下解锁更广目录                                              |
| C             | 用 `beforeToolCall` hook 做白名单 / 黑名单                                         |

### Step 4：启用高级特性

- ✅ 用 `toolExecution: 'parallel'` 让同一批独立工具并发执行（已落地，见
  [agent.service.ts](../apps/server/src/modules/agent/agent.service.ts) 内
  `toolExecution` 字段附近的 audit 注释）。read-only 工具自然并行安全；
  `canvas_commands` 因为 server-side handler 共用 nodeTypeMap、client-side
  SSE 完成顺序 ≠ 声明顺序两条 race 路径，单独挂了
  `executionMode: 'sequential'`（见
  [definitions.ts](../apps/server/src/modules/agent/tools/definitions.ts)
  里 `canvasCommandsTool`）；`ingest_content` 走 atomicWrite，跨节点并发
  天然安全，同节点并发是 last-writer-wins，沿用 parallel。pi-agent-core
  的 batch 行为是"批里任一 sequential 工具就整批退化为串行"——所以混合
  `[read, canvas_commands]` 批次会回到串行，但实际 trace 里 agent 通常
  先读后写、读写分轮，混合批罕见，损失可接受。
- 接 `agent.steer()` 用于"边跑边插话"
- 让 `canvas_commands` 在用户取消后通过 `terminate: true` 立刻停 loop

## 风险与缓解

| 风险                                                                          | 缓解                                                                                                                    |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `Agent` 类的事件流是异步推送，要桥到 `AsyncGenerator`，可能漏事件             | 用 `subscribe()` 内部 push 到队列，generator 端 `await` 取队列；最后 `await agent.waitForIdle()` 保证全部 listener 收尾 |
| `cleanUpAbortedContext` 直接 mutate `assistant.content` 数组                  | 仍有效；Agent 的 setter 只对**整体重新赋值**做浅复制，元素 mutate 不受影响                                              |
| `validateToolCall` 在 service 层做；Agent 内部已自己做 schema 校验            | 统一 agent 走 pi-agent-core 内置校验；`intent.service.ts` 是独立的非 Agent 路径，仍保留自己的 `validateToolCall` 调用   |
| 未来想用 `streamProxy`（让 web 端直连 LLM proxy）                             | 本期不动；本期甚至连 `streamFn` 都不传，直接用 pi-agent-core 默认的 `streamSimple`                                      |
| `getApiKey` callback 与现在的"先 build model 后 await ensureApiKey"流程不一致 | 直接把 `getApiKey: () => ensureApiKey()` 传给 `Agent`，每次 LLM 调用前都会 await，OAuth token 长跑期可刷新              |

## 副作用清单（执行 Step 1 后实际改变的行为）

> 这是给 reviewer 看的"哪些行为变了"清单，不是文件清单。

1. **`tool_start` 触发时机**
   - **旧**：模型完成 toolcall 块的 stream 输出时（pi-ai `toolcall_end`）
   - **新**：工具被实际派发时（pi-agent-core `tool_execution_start`）
   - **影响**：UI 上"工具卡片"出现时间会**稍晚**几十毫秒；args 此时已通过 schema 校验
2. **工具参数校验**
   - **旧**：service 层调用 `validateToolCall(tools, call)`
   - **新**：pi-agent-core 内部统一做（同样基于 typebox + AJV）
   - **影响**：错误消息格式可能略有差异；本期保持错误仍以 `tool_result` 形式回给前端
3. **工具异常处理**
   - **旧**：service 层 try/catch，把 `Error.message` 作为 `tool_result` 内容
   - **新**：tool `execute` 直接 throw，pi-agent-core 自动包成 `isError: true` 的 toolResult
   - **影响**：今天所有 executor 仍把错误编码成 JSON `status: 'error'` payload，
     前端表现完全一致；`runAgent` 在 `tool_execution_end` 分支已经把
     `event.isError` 接到 `logger.info` 上做 breadcrumb，Step 2 引入会 throw 的
     文件工具时，错误会自动通过这条 log 出现，无需额外接线
4. **Context 同步**（这里的 `Context` 指 pi-ai 的 `{ systemPrompt, messages, tools? }` 对象，也是 `.history/<canvasId>/<threadId>.json` 持久化的形态）
   - **旧**：service 内每一轮直接 `context.messages.push(assistantMsg / toolResultMsg)`，route 端任何时候读到的都是最新值
   - **新**：`Agent` 在内部维护自己的 `state.messages`（构造时浅拷贝入参，之后不再回写）；`runAgent` 退出前显式 `context.messages.length = 0; context.messages.push(...agent.state.messages)` 把最终结果灌回入参
   - **影响**：route 端 `cleanUpAbortedContext` 与 `saveContext` 行为不变；入参 `context` 对象引用 + `messages` 数组引用都保持稳定（只是元素被原地替换）。**唯一可观察差异**：route 端的 `debouncedSave` 在中途事件触发时，磁盘上看到的可能仍是上一轮的 messages，直到 `runAgent` 退出后才一次性灌回；`flushSave()` 仍然保证最终一致
5. **abort 后的 partial assistant text 持久化**
   - **旧**：route 层 `partialText` 累加 `text_delta`，abort 时手动塞 assistant message
   - **新**：pi-agent-core 在 abort 时已经把 final assistant message
     （`stopReason: 'aborted'`，含中断前累计文本）写入 `state.messages`，由
     `runAgent` finally 同步回 `context.messages`
   - **本次实施**：route 层那段「abort 时手工注入 partial assistant」**已删除**
     （包括相关的 `partialText` 累加 / 重置逻辑），避免出现同一段文字写两次
     （一条 `aborted` + 一条 `stop`）的重复
6. **`maxIterations` 概念**
   - **旧**：`runAgent` 自己有 `maxIterations = 20` 计数，超过就 `break`
   - **新**：pi-agent-core `Agent` 类**没有** expose `shouldStopAfterTurn`
     （只有底层 `runAgentLoop` 函数才有），所以 service 层在 subscribe
     里 count `turn_end` 事件，到上限调用 `agent.abort()`
   - **副作用**：`agent.abort()` 触发的是 _agent 内部_ 的 AbortController，
     不是 route 的；所以 route 的 `cleanUpAbortedContext` 不会被牵连。
     pi-agent-core 在这种 abort 下会追加一条空的 `aborted` assistant
     占位，service 层在 `agent_end` 分支检测并 `messages.pop()` 掉它，
     再 emit `done`（最后一条有用 assistant 文本）+ `error`（cap-out 提示）
