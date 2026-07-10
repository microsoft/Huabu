# Driver 概念

Driver 是 Agenetes 的运行时实现单元：给定一份 `WorkloadSpec`，它负责把该声明物化为一个实际运行的 agent workload，并返回一个可被 host app 驱动的 `AgentHandle`。从 Kubernetes 类比看，driver 更接近 container runtime，而不是 scheduler、Pod spec、或某个具体 agent 定义。

理解 driver 最有用的坐标系不是单一分类，而是三个基本维度：

```text
Driver = binding schema × runtime protocol × transport
```

Agenetes 不要求这三个维度形成完整笛卡尔积；每个具体 driver 只固定其中一个被支持的组合。这个三维模型的目的，是帮助 host app 开发者理解一个 driver 如何被声明、如何运行、以及运行期通过什么通道交互。

## 1. Binding schema：声明如何绑定到 workload

Binding schema 回答的是：driver 向 `WorkloadSpec` 贡献的 create-time 声明长什么样？host app 要用什么声明来表达“运行这一类 agent workload”？在协议层，它落在 `WorkloadSpec` union member 的 `spec` 字段上。

在代码层面，driver 通过 `defineBinding({ kind, spec })` 向 `WorkloadSpec` union 贡献一个成员。其中 `kind` 是 driver route，`spec` 是该 driver 贡献的 create-time binding schema。host 再用 `composeWorkloadSpec(...)` 把所有 driver binding 与共享的 per-turn `request` union 合成最终的 `WorkloadSpec`。

需要注意的是，协议层的 driver-specific schema 落在嵌套的 `spec` 字段上，但具体 driver 实现不一定只接收这个字段。当前 instance 会把完整 host `WorkloadSpec` 传给 driver；driver 可以接收一个结构兼容的 create spec 投影，其中既包含公共字段（如 `kind`、`threadId`、`namespace`），也包含由 binding schema 定义的 driver-specific 部分。

Binding schema 可以形成两类常见的 driver style：

- **Agent Command Driver**：binding schema 是 command-shaped 的，例如 `{ command, args, env, cwd }`。这种 driver 不理解某个具体 harness 的配置语法，只描述如何启动一个 agent process，并假定启动后的进程会通过某个 runtime protocol 与 Agenetes 交互。
- **Agent Harness Driver**：binding schema 是 harness-shaped 的，例如模型、skill、instruction、tool policy、memory、profile option 等。它理解某个 agent harness 的配置语法，接收更语义化的 agent declaration，并把它编译或展开到底层启动、连接与运行参数。

这两类不是 transport 分类，也不是 runtime protocol 分类；它们的区别首先落在 binding schema 的形状上。一个重要例子是 `copilot --acp`。这个命令字符串本身并不决定 driver 是 command-shaped 还是 harness-shaped；决定因素是 driver 是否理解 Copilot 的上层语义。

如果 `copilot --acp` 只是 generic ACP command driver 中的 `command + args` 内容，例如 `{ command: "copilot", args: ["--acp", ...] }`，那么这个 driver 仍然是 Agent Command Driver：它不理解 Copilot，只负责启动一个会说 ACP 的进程。

只有当 driver 接收 Copilot 层的语义——prompt、skills、tools、permission policy、model 等——并把它们编译成 `copilot --acp` 的 argv/env/session options 时，它才是 Agent Harness Driver。从这个意义上说，Agent Harness Driver 可以建立在 Agent Command Driver 之上：先把更丰富的 harness-shaped declaration 降级为 command-shaped recipe，再复用同样的 ACP runtime protocol 与 stdio transport。

```text
Generic ACP command driver:
  binding schema    = command-shaped
  runtime protocol  = ACP
  transport         = stdio

Copilot-aware ACP driver:
  binding schema    = Copilot-shaped / harness-shaped → command-shaped recipe
  runtime protocol  = ACP
  transport         = stdio
```

Agent template / profile 不构成第三类 driver。它属于内容与默认值层：可以绑定 prompt 文件、skill 目录、默认 model/tool policy 等具体内容，再由 host/catalog 填充某个 binding schema 并编译成 `WorkloadSpec`。换句话说，driver 只应该关心 schema 与 runtime materialization；template/profile pool 负责 agent catalog、content、defaults 与版本。

因此，binding schema 是 declaration-time / create-time 的语义；它不等同于 runtime protocol，也不等同于 transport。

## 2. Runtime protocol：物化之后说什么语言

Runtime protocol 回答的是：agent workload 被物化之后，Agenetes 与它之间说什么运行期语言？

Runtime protocol 决定运行期语义能力，例如：如何提交一轮输入、如何流式返回输出、是否支持 `control`、是否支持 permission request、是否支持 mode/model/config 切换、是否支持 session load、是否产出结构化事件。

典型 runtime protocol 包括 ACP、某个 harness 的 SDK/native protocol、以及未来可能跨进程暴露的 Agenetes API-shaped protocol。即使是 in-process 调用，也不是“没有 protocol”；它只是通过函数调用承载同一套 `AgentHandle` 语义，免掉 serialization 与 IPC。

`AgentHandle` 是 Agenetes 当前的核心 per-workload runtime contract。driver 从下方实现它，host app 从上方消费它；无论底层是本进程对象、本机子进程、还是远程进程，向上都应收敛到同一类 handle surface。

## 3. Transport：protocol 如何被承载

Transport 回答的是：runtime protocol 通过什么通道传输？

常见 transport 包括 in-process function call、stdio、WebSocket、HTTP/SSE、以及 agentlet relay。Transport 只决定消息如何过去，不决定消息语义本身。

因此，ACP over stdio、ACP over WebSocket、以及未来 API-shaped protocol over HTTP/SSE 是不同 transport 组合；而 in-process SDK driver 与 remote ACP driver 的根本差异也不能只用 transport 描述，因为它们的 binding schema 与 runtime protocol 也不同。

## 4. 与 WorkloadSpec 的关系

`WorkloadSpec` 中有几根必须分清的轴：

| Field                    | Meaning                                                                                                                          |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `kind`                   | Driver route：决定 dispatch 到哪个 Agent Driver。                                                                                |
| `workloadType`           | Workload lifecycle type：`Job` 或 `Deployment`，决定完成语义。                                                                   |
| `namespace` / `threadId` | 持久化与 live-handle 寻址范围。                                                                                                  |
| `spec`                   | Driver-specific binding schema：由该 driver 的 binding definition 贡献；具体 driver 实现也可以接收包含公共字段的完整 spec 投影。 |
| `request`                | Per-turn input：共享的 request union，不属于 driver binding schema。                                                             |

其中 `kind` 与 `workloadType` 是正交的顶层字段。`kind` 决定“哪个 driver 运行它”，`workloadType` 决定“它是一次性完成还是长期持有 live handle”。Agent Command Driver / Agent Harness Driver 的差异主要体现在 `spec` 的 schema 形状，而不是 `kind` 或 `workloadType`。

## 5. 与 Agent Profile 的关系

可以用下面的代数帮助理解 profile 层：

```text
Agent Command Driver + harness schema = Agent Harness Driver

(Agent Command Driver | Agent Harness Driver) + Agent Definition = Agent Profile
```

这里的 schema 是语法，definition 是取值。Schema 描述某类 binding 可以表达哪些字段；definition 是某个具体 agent 的配置，例如模型、instructions、skills、tools、权限策略、命令参数、prompt 文件引用或 skill 目录引用。Agent Profile 则是 host app 可以呈现、选择或引用的具体 agent offering。

Profile 不等同于 driver。Driver 是 runtime implementation；profile 是面向 host app 和用户的 agent offering。一个 driver 可以支撑多个 profile，一个 profile 也应最终被编译成某个 `WorkloadSpec`。

## 6. 与 workload lifecycle type 的关系

Agent Command Driver / Agent Harness Driver 不是 `Job` / `Deployment`。前者描述 binding schema 的语义层级，后者是 `workloadType` 的两个取值，描述 lifecycle completion semantics。

一个 command-shaped driver 可以支持 `Job`，也可能支持长期 `Deployment`；一个 harness-shaped driver 同样可以支持两者。是否能支持 `Deployment` 取决于 driver/runtime 是否能维持或恢复长期 session、control、notifications 与 durable state，而不是取决于它是 Agent Command Driver 还是 Agent Harness Driver。

## 7. 与 persistence / querying 的关系

Persistence 不是 driver 的第四个维度。它属于 Agenetes instance 的 durable query/log surface：`record(...)` / `records(...)` / `history(...)` / `tail(...)` / `notifications(...)`。

但是 driver 必须与 persistence surface 正确对接。它需要把可观察事实产出到 `AgentStreamEvent`，让 Agenetes 折叠成 Tier-2 `AgentTurn`；如果它有 out-of-turn state，还需要通过 handle 的 up-report surface 产出 `AgentStateSnapshot`，让 instance 持久化并经 `notifications(threadId)` 重新发布。

换句话说，driver 不拥有持久化格式，也不直接给 host app 写历史；driver 只负责把运行期事实放到 Agenetes 统一的 stream/state surfaces 上。

## 8. 典型组合

| Binding schema                  | Runtime protocol                  | Transport                  | Example                                                                                                                                             |
| ------------------------------- | --------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| command-shaped                  | ACP                               | stdio                      | Generic ACP CLI agent；也包括把 `copilot --acp` 当成普通 `command + args` 内容的情况。                                                              |
| command-shaped                  | ACP                               | WebSocket / agentlet relay | Remote ACP agent。                                                                                                                                  |
| harness-shaped → command-shaped | ACP                               | stdio                      | Copilot-aware driver：先把 prompt / skills / tools / permission policy / model 等语义编译成 `copilot --acp ...argv`，再走 command-shaped ACP path。 |
| harness-shaped                  | SDK/native `AgentHandle` contract | in-process function call   | 进程内 SDK / harness driver。                                                                                                                       |
| workload-shaped                 | Agenetes API-shaped protocol      | HTTP/SSE                   | 未来跨进程或跨网络边界的 Agenetes facade。                                                                                                          |

这些组合只是示例，不是完整矩阵。Agenetes 只承诺每个已注册 driver 给出一个明确、可支持的组合；不承诺任意 binding schema、protocol、transport 都能自由互换。
