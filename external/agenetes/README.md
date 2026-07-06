# Agenetes

**Agent-as-a-Local-Service — an agent control plane.**

Agenetes is the reusable runtime layer that turns "an agent" into a managed local service. It sits above a per-node agent relay (`agentlet`) and below a host application (e.g. a canvas UI): the host defines and @-mentions agents; Agenetes guarantees that a session exists to receive queries and return a stream of agent messages, tracks each workload's lifecycle, routes its stream, and persists its log.

> **Status.** This README is the current design source of truth for Agenetes. It captures the consensus reached while extracting Agenetes out of its first host (Huabu / Sediment). It will later be refined into the project's internal docs; for now it is authoritative. Downstream design documents should reference this file rather than restating these decisions.

## The one guarantee / 唯一保证

**G — The single guarantee / 唯一保证.**
Agenetes succeeds or fails on a single guarantee, not on any feature: **once an agent is defined (e.g. via an agent template), then when it is @-mentioned a session exists to receive user queries and return a stream of agent messages.** It is deliberately incurious about *what* the agent does or *how* the host UI looks — it owns the contract in between.
Agenetes 的成败只取决于一条保证，而非任何具体功能：**一旦某个 agent 被定义（例如通过 agent 模板），那么当它被 @-mention 时，就一定存在一个 session 来接收用户查询并返回一串 agent 消息。** 它刻意不关心 agent *做什么*、宿主 UI *长什么样*——它只拥有两者之间的契约。

## The name

`agentlet` : kubelet :: **Agenetes** : Kubernetes. `agentlet` is the per-node relay that spawns and babysits *one* runtime; Agenetes is the layer above it that dispatches a session to its agentlet, tracks its lifecycle, routes its stream, and persists its log.

The name is formed like its model: Ancient Greek κυβερνήτης (*kubernḗtēs*, "helmsman/governor") = the root *kubern-* + the agentive suffix **-ήτης (*-ētēs*)**, "the one who —". We attach that true agentive suffix to the root **ag-** (shared by Greek ἄγω "to lead/drive" and Latin *agō* → *agent*, both from PIE \*h₂eǵ- "to drive"): **Agen-** (keeps "agent" legible) + **-ētēs** (exactly as in *kubernḗtēs*) → "the one who drives / sets in motion" — precisely a control plane's job. It scans like its model: Ku-ber-NÉ-tēs ⟷ A-ge-NÉ-tēs. (Not "Agentnetes": that bolts the whole word *agent* onto the mis-cut fragment "-netes", preserving a false morpheme.)

## The four orthogonal dimensions / 四个正交维度

Agenetes decomposes into four dimensions that must stay decoupled so they compose freely — any point in one dimension works with any point in the others:
Agenetes 分解为四个必须保持解耦的维度，以便它们能自由组合——任一维度上的任意取值，都能与其它维度上的任意取值配合工作：

**D1 · Definition · Registry · Discover — *what agents exist* / 定义 · 注册 · 发现——*有哪些 agent*.**
An agent template is a pure definition (e.g. `{ agentletId, cmd, cwd }` or a built-in profile); adding one registers it but creates no session. Owns the registry, agent profiles, and team manifests; answers "what can I @-mention?". *(K8s: the API server + declarative specs.)*
agent 模板是一份纯定义（例如 `{ agentletId, cmd, cwd }` 或一个内置 profile）；添加它只是注册，不会创建 session。该维度拥有注册表、agent profile 与 team manifest，回答"我能 @-mention 谁"。*(对应 K8s：API server + 声明式 spec。)*

**D2 · Lifecycle — *the workload state machine* / 生命周期——*工作负载状态机*.**
`spawn` (lazily, on first @-mention) → `resume` (from idle-suspend) → `close` (explicit, idle-timeout, or task completion). Owns only a workload's existence and state — nothing about how bytes move or what the agent is. *(K8s: the controller reconcile loop — but Agenetes has **no scheduler**, see I1.)*
`spawn`（惰性，在首次 @-mention 时）→ `resume`（从 idle 挂起中恢复）→ `close`（显式关闭、idle 超时或任务完成）。它只拥有工作负载的存在与状态——不涉及字节如何流动、agent 是什么。*(对应 K8s：controller 的 reconcile 循环——但 Agenetes **没有调度器**，见 I1。)*

**D3 · Communication (transport-pluggable) — *how queries in / messages out move* / 通信（传输可插拔）——*查询进、消息出如何流动*.**
User query in → stream of agent messages out, over a pluggable transport. Transport is a separate axis from lifecycle and definition; the same `spawn → stream → close` shape must work across every transport. *(K8s: the CRI — the runtime interface behind which any runtime plugs in.)* This uniform contract is Agenetes' **Agent Runtime Interface (ARI)**.
用户查询进 → agent 消息流出，跑在可插拔的传输之上。传输是独立于生命周期与定义的一根轴；同一套 `spawn → stream → close` 形态必须适用于每一种传输。*(对应 K8s：CRI——任何运行时都可插入其后的运行时接口。)* 这套统一契约就是 Agenetes 的 **Agent Runtime Interface（ARI，Agent 运行时接口）**。

**D4 · Persistence · Replay · Subscribe — *the durable message log* / 持久化 · 回放 · 订阅——*持久的消息日志*.**
Every turn is appended to a per-thread log so a conversation survives restarts and idle-out. Consumers can replay history and subscribe to the live tail. Orthogonal to transport. *(K8s: etcd + the watch API.)*
每一轮都追加进 per-thread 的日志，使会话能挺过重启与 idle 挂起。消费者可回放历史，也可订阅实时尾流。与传输正交。*(对应 K8s：etcd + watch API。)*

## Core invariants (the design consensus) / 核心不变量（设计共识）

The numbered invariants below (I1–I9, with sub-clauses I*n*.*m*) are the design consensus, meant to be cited by reference id. Each is stated in English then Chinese; code blocks and tables are not duplicated.
下列带编号的不变量（I1–I9，含子条款 I*n*.*m*）即设计共识，供按编号引用。每条先英文后中文；代码块与表格不做双语重复。

### I1. Agenetes is not a scheduler — it is an executor / 不是调度器，而是执行器

Working the Kubernetes analogy to its breaking point is the fastest way to record what Agenetes deliberately is **not**. A scheduler *chooses* a placement among interchangeable candidates (scoring, bin-packing, preemption, rescheduling). Agenetes has no such choice.
把 Kubernetes 类比推到它的断裂点，是记录 Agenetes 刻意**不是**什么的最快方式。调度器会在可互换的候选之间*挑选*一个放置位置（打分、装箱、抢占、重新调度）。Agenetes 没有这种选择权。

**I1.1 Drivers are not fungible — each *is* its resource / Driver 不可互换——每个 driver 就是它绑定的资源.**
The K8s scheduler assumes interchangeable Nodes with state externalised to a PV; Agenetes drivers are the opposite. An ACP driver is bound to a specific agentlet daemon + that machine's filesystem (the session's files and live process live *there*); a built-in driver is bound to this process + the capability ports injected at registration. Neither can move.
K8s 调度器假设 Node 可互换、状态被外置到 PV；Agenetes 的 driver 恰好相反。ACP driver 绑定到某个特定的 agentlet daemon + 那台机器的文件系统（session 的文件与活进程就*在那里*）；built-in driver 绑定到本进程 + 注册时注入的能力端口。两者都不可迁移。

**I1.2 Routing has two dimensions with opposite mutability / 路由有两个可变性相反的维度.**
The **class** (`kind → driver type`) is static wiring Agenetes owns and may re-point. The **instance** (which daemon / which live session) is *pinned by the spec's resource reference* (a profile id, a persisted session id) and is **not** relocatable.
**类**（`kind → driver 类型`）是 Agenetes 拥有、可重新指向的静态接线。**实例**（哪个 daemon / 哪个活 session）由 *spec 的资源引用*（profile id、已持久化的 session id）钉死，**不可**迁移。

**I1.3 Failure is rebuild-or-fail, never reschedule / 失败即重建或失败，绝不重新调度.**
If the bound resource is gone, the workload is rebuilt from durable state (the turn log / persisted session) or it fails. There is no K8s-style "pod drifts to another node".
如果被绑定的资源没了，工作负载要么从持久状态（轮次日志 / 已持久化的 session）重建，要么失败。不存在 K8s 那种"pod 漂移到另一个 node"。

So the control-plane roles Agenetes fills are:
因此 Agenetes 承担的控制面角色是：

| K8s control-plane role | In Agenetes? |
| ---------------------- | ------------ |
| Scheduler (choose placement among candidates) | **No** — placement is declared in the spec, pinned by affinity |
| Admission (gate: requested capabilities ⊆ advertised) | Yes |
| kubelet / CRI (execute + reconcile a *given* workload) | Yes — `create` + pipe + lifecycle |
| Service / DNS (resolve a name → a fixed endpoint) | Yes — deterministic `kind → driver` |

Agenetes is therefore closer to a **service-mesh sidecar / reverse proxy**: resolve by declared identity, admit, and pipe. Cross-resource scheduling (fleet bin-packing, autoscaling across machines) is an explicit **non-goal** — were it ever needed it would be a *new* layer above Agenetes, not a widening of this one. (The daemon's lazy-spawn / idle-suspend / resume is lifecycle *reconcile* of one already-bound resource — a kubelet job — not placement selection.)
因此 Agenetes 更接近一个 **service-mesh sidecar / 反向代理**：按声明的身份解析、准入、然后转接。跨资源调度（机队装箱、跨机自动扩缩）是明确的**非目标**——真要用到，那也是 Agenetes 之上的一个*新层*，而不是把这一层撑大。（daemon 的惰性 spawn / idle 挂起 / resume 是对*一个已绑定资源*的生命周期 *reconcile*——一件 kubelet 的活——而非放置选择。）

### I2. Drivers: the ARI runtimes — standard vs custom, and today's object-injection interface / Driver：ARI 运行时——标准 vs 自定义，及当前的对象注入接口

A **driver** teaches Agenetes how to run one *kind* of agent — the direct analogue of a CRI runtime (containerd, CRI-O). It is invisible to whoever *defines* the agent: the definition dimension names a semantic offering, and Agenetes resolves that to a driver behind the scenes. Two drivers exist today: an in-process **built-in** driver (a native SDK loop) and an **ACP** driver (an agentlet daemon speaking ACP over stdio / a WS bridge).
一个 **driver** 教会 Agenetes 如何运行*一类* agent——它正是 CRI 运行时（containerd、CRI-O）的对应物。它对*定义* agent 的人不可见：定义维度只命名一个语义化的"供给项（offering）"，Agenetes 在幕后把它解析到某个 driver。今天存在两个 driver：一个进程内的 **built-in** driver（原生 SDK 循环），和一个 **ACP** driver（一个通过 stdio / WS 桥说 ACP 的 agentlet daemon）。

**I2.1 Standard vs custom — who ships the driver / 标准 vs 自定义——谁来交付这个 driver.**
A **standard** driver (the ACP driver) is generic and ships *inside* Agenetes: the mounted instance pre-mounts it, the analogue of a container runtime built into the platform. A **custom** driver is business-coupled and **host-owned**: the host's own native agents (canvas-coupled tools, host capability ports) that only make sense in that host, always **registered by the host at bootstrap**, never shipped in the framework. Note the naming: the driver the code calls `builtin` is *built into the host* (its in-process native agents) — from Agenetes' point of view that is a **custom** driver, distinct from a *standard* driver built into *Agenetes*.
**标准（standard）** driver（即 ACP driver）是通用的，随 Agenetes *内部*一起交付：被挂载的实例会预挂载它，相当于平台自带的容器运行时。**自定义（custom）** driver 则与业务耦合、由**宿主拥有**：宿主自己的原生 agent（与画布耦合的工具、宿主能力端口），只在那个宿主里才有意义，总是**由宿主在 bootstrap 时注册**，绝不随框架交付。注意命名：代码里叫 `builtin` 的那个 driver 是*内建于宿主*的（宿主的进程内原生 agent）——从 Agenetes 的视角看，它是一个 **custom** driver，区别于内建于 *Agenetes* 的 *standard* driver。

**I2.2 The runtime framework (`AgentRuntime`) has two orthogonal faces / 运行时框架 `AgentRuntime` 有两个正交面.**
`AgentRuntime` is the runtime framework; drivers are the runtimes it dispatches to. Its two faces are: (a) *driver dispatch* — `register(driver)` / `resolve(kind)` / `has(kind)` / `kinds`: map a driver *kind* to the object that knows how to create its handles; (b) *handle lifecycle* — `get(threadId)` / `create(threadId, factory)` / `close(threadId)`: hold the one live Deployment handle for a `threadId` (get-or-create by identity; **reuse-ignores-spec**, i.e. no desired-state reconcile — changing a spec is an explicit `close()` + `create()` the caller decides, never a hidden reconcile). A one-shot Job never enters this lifecycle registry — its handle lives only for its single run.
`AgentRuntime` 是运行时框架；driver 是它分发的目标运行时。它的两个面是：(a) *驱动分发*——`register(driver)` / `resolve(kind)` / `has(kind)` / `kinds`：把 driver 的 *kind* 映射到知道如何创建其 handle 的对象；(b) *handle 生命周期*——`get(threadId)` / `create(threadId, factory)` / `close(threadId)`：为一个 `threadId` 持有那唯一的活 Deployment handle（按身份 get-or-create；**复用即忽略 spec**，即不做期望状态 reconcile——改 spec 是调用方显式的 `close()` + `create()`，绝非隐式 reconcile）。一次性的 Job 从不进入这个生命周期注册表——它的 handle 只在那单次运行期间存在。

**I2.3 Registration advertises candidacy; Agenetes decides the binding / 注册即声明候选资格；绑定由 Agenetes 决定.**
Only a driver knows what it implements, so at registration it *advertises* the binding kinds it serves and the capabilities (tools, control verbs) it carries — an *input* to routing, not routing itself. Agenetes stays the authority over the **route** (which registered driver actually backs a `kind`) and the **admission** check (the tool names in a spec ⊆ what the driver advertises).
只有 driver 才知道自己实现了什么，因此在注册时它会*声明*自己服务哪些 binding kind、携带哪些能力（工具、控制动作）——这是路由的*输入*，而非路由本身。Agenetes 始终是**路由**（哪个已注册 driver 实际支撑某个 `kind`）与**准入**检查（spec 中的工具名 ⊆ driver 声明的能力）的权威。

**I2.4 The driver interface (`AgentDriver`) / driver 接口 `AgentDriver`.**
A driver is its metadata (`AgentDriverInfo` — a `kind` dispatch key + the `AgentCapabilities` every one of its handles advertises) plus a single factory method:
一个 driver = 它的元数据（`AgentDriverInfo`——一个 `kind` 分发键 + 它每个 handle 都声明的 `AgentCapabilities`）+ 一个工厂方法：

```ts
interface AgentDriver<TInput = unknown, …> extends AgentDriverInfo {
  readonly kind: string;                     // the dispatch key: 'builtin', 'acp'
  readonly capabilities: AgentCapabilities;  // what every handle from this driver advertises
  create(input: TInput): AgentHandle;        // wrap a backing object into a handle
}
```

**I2.5 Object-injection — today's stand-in for the clean `create(spec)` factory / 对象注入——当前对干净的 `create(spec)` 工厂的过渡替代.**
The end-state factory is *spec in, no host objects*: `driver.create(spec)`, the driver resolving its own backing state from a serializable `WorkloadSpec`. Until the package boundaries make a driver's host resources injectable, the host still constructs each backing runtime object (it owns the host singletons and host coupling) and hands it in via `create(input)`, where `TInput` is a **host-shaped construction bundle** kept fully generic so the framework never names a host type.
终态工厂是*传入 spec、不传宿主对象*：`driver.create(spec)`，由 driver 从一个可序列化的 `WorkloadSpec` 自行解析出它的后端状态。在包边界尚未让 driver 的宿主资源变得可注入之前，宿主仍然自己构造每个后端运行时对象（它拥有宿主单例与宿主耦合），并经 `create(input)` 递入；其中 `TInput` 是一个**宿主形状的构造包**，保持完全泛型，使框架永不指名任何宿主类型。

**I2.5.1 The built-in (custom) driver / built-in（自定义）driver.**
A **Job**, cancel-only control — takes the whole backing agent as its input: `create: ({ agent }) => new BuiltinAgentHandle(agent)`. The SDK `Agent` is a fresh instance per invocation, so it *is* the construction input; per-turn context flows through the handle's `run(...)`.
一个 **Job**，只支持 cancel 控制——把整个后端 agent 作为输入：`create: ({ agent }) => new BuiltinAgentHandle(agent)`。SDK 的 `Agent` 每次调用都是全新实例，所以它*就是*构造输入；每轮上下文经 handle 的 `run(...)` 流入。

**I2.5.2 The ACP (standard) driver / ACP（标准）driver.**
A **Deployment**, full control + session-load — takes only the addressable id: `create: ({ threadId }) => new AcpAgentHandle(threadId)`. The handle is long-lived and holds only its `threadId`; the live session entry and per-turn context arrive on each `run(...)`, so reuse-ignores-spec holds trivially.
一个 **Deployment**，完整控制 + session-load——只取可寻址的 id：`create: ({ threadId }) => new AcpAgentHandle(threadId)`。该 handle 长期存活，只持有它的 `threadId`；活 session entry 与每轮上下文在每次 `run(...)` 时到达，因此"复用即忽略 spec"天然成立。

This object-injection form is the pragmatic bridge; collapsing it into the clean `create(spec)` factory (moved *inside* the mounted instance, so the host never calls `create` itself) is the target end-state.
这种对象注入形态是务实的过渡桥；把它收拢进干净的 `create(spec)` 工厂（挪到被挂载实例*内部*，从而宿主永不自己调用 `create`）才是目标终态。

### I3. Workload kinds: Job vs Deployment / 工作负载种类：Job vs Deployment

Callers do not choose a reconcile strategy (declarative vs imperative — that is an internal detail); they choose a **workload kind**, which differs only in **completion semantics**:
调用方不选择 reconcile 策略（声明式 vs 命令式——那是内部细节）；他们选择一个**工作负载种类（workload kind）**，二者只在**完成语义**上不同：

| Kind | Desired state | Completion | K8s analogue |
| ---- | ------------- | ---------- | ------------ |
| **Deployment** | "while the thread is live, a conversational session exists" | never (idle-suspend / resume) | Deployment |
| **Job** | "run this prompt once, stream the result, then close" | terminal (Complete / Failed) | Job / CronJob |

**I3.1 Both kinds are owned by Agenetes / 两种 kind 都由 Agenetes 拥有.**
Both are built-in, first-class kinds owned by Agenetes — completion semantics *are* the control plane's core responsibility; a host only fills in a workload spec, never defines a kind's reconcile logic.
两者都是 Agenetes 拥有的内建一等 kind——完成语义*正是*控制面的核心职责；宿主只填写工作负载 spec，绝不定义某个 kind 的 reconcile 逻辑。

**I3.2 Realizability constraint (kind × driver) / 可实现性约束（kind × driver）.**
A **Job** runs on a stateless SDK driver *or* an ACP session; a **Deployment** (live conversation with in-process state, slash commands, mode/config switching) requires a stateful runtime — the ACP driver only.
一个 **Job** 可跑在无状态的 SDK driver *或*一个 ACP session 上；一个 **Deployment**（带进程内状态、斜杠命令、模式/配置切换的活会话）需要有状态运行时——只有 ACP driver。

**I3.3 The initiator need not be human / 发起者不必是人.**
A program, a workflow step, or another agent can start a workload (especially a Job); "who triggered it" is not a layering discriminant.
一个程序、一个工作流步骤或另一个 agent 都能发起工作负载（尤其是 Job）；"谁触发的"不是分层的判据。

**I3.4 Reserved terms — `Service` and `sessionId` / 保留术语——`Service` 与 `sessionId`.**
The word **`Service`** is reserved for a *different*, future concept — a capability/endpoint exposed *into* Agenetes for other agents to consume (agent-as-a-service, MCP, the reachback surface) — matching the K8s meaning of a stable endpoint, orthogonal to a workload. The lower-level **`sessionId`** (the concrete execution instance — the "pod") stays a distinct term.
**`Service`** 一词保留给一个*不同的*、未来的概念——一个*暴露进* Agenetes、供其它 agent 消费的能力/端点（agent-as-a-service、MCP、回连面）——对应 K8s 中"稳定端点"之意，与工作负载正交。更底层的 **`sessionId`**（具体执行实例——那个"pod"）保持为一个独立术语。

### I4. Identity model: namespace → threadId → sessionId / 身份模型：namespace → threadId → sessionId

A three-level identity model, each level opaque to Agenetes (pure data it persists/routes on but never interprets):
一个三层身份模型，每一层对 Agenetes 都是不透明的（它据以持久化/路由、但从不解释的纯数据）：

**I4.1 `namespace` — the storage / metadata scope, *above* the thread / 存储/元数据作用域，位于 thread *之上*.**
A group-of-threads tenant/isolation boundary with its own storage (`{ name, storagePath? }`), the K8s namespace / Virtual Cluster. A thread belongs to exactly one namespace. The host gives it meaning (the canvas id is the host's de-facto namespace key). It rides the `WorkloadSpec`, so a workload owns its persistence scope without a bootstrap path root.
一个"多 thread 成组"的租户/隔离边界，带自己的存储（`{ name, storagePath? }`），对应 K8s 的 namespace / Virtual Cluster。一个 thread 恰好属于一个 namespace。含义由宿主赋予（canvas id 是宿主事实上的 namespace 键）。它搭乘 `WorkloadSpec`，因此工作负载无需一个 bootstrap 路径根就拥有自己的持久化作用域。

**I4.2 `threadId` — the caller-side *slot* identity, host-minted / 调用侧的*槽位*身份，由宿主铸造.**
Agenetes routes on it, caches the live handle on it, and keys the durable log on it; it never interprets its structure. Everything the slot *represents* (which canvas, node, user) is held by the host, indexed by `threadId`, and never enters the Agenetes contract.
Agenetes 据它路由、据它缓存活 handle、据它作为持久日志的键；但从不解释它的结构。这个槽位所*代表*的一切（哪个画布、节点、用户）由宿主持有、按 `threadId` 索引，绝不进入 Agenetes 契约。

**I4.3 `sessionId` — the concrete execution instance (pod-level) / 具体执行实例（pod 级）.**
The instance backing a workload; the unit `session/load` recovery keys on.
支撑一个工作负载的实例；也是 `session/load` 恢复所依据的单元。

### I5. Dispatch is on a caller-set `kind` discriminant / 分发基于调用方设定的 `kind` 判别式

**I5.1 The caller names its driver, in the contract namespace / 调用方点名它要的 driver，且用契约命名空间.**
Unlike a fungible K8s PodSpec, the Agenetes caller **knows exactly which driver it wants and names it** — because the drivers are not interchangeable. So the `WorkloadSpec` is a tagged union keyed on a required, top-level, public `kind` field (`internal` / `external`, …), each member carrying only the fields its driver consumes. Crucially `kind` is a value in the **contract** namespace, never Agenetes' *implementation* identifier (`acp` / `sdk`): the alias `kind → driver` is what lets a driver be renamed, split, or merged without breaking every spec (including persisted ones).
不同于可互换的 K8s PodSpec，Agenetes 的调用方**明确知道自己要哪个 driver 并点名它**——因为 driver 不可互换。因此 `WorkloadSpec` 是一个以必填、顶层、公开的 `kind` 字段（`internal` / `external`……）为键的 tagged union，每个成员只携带其 driver 消费的字段。关键在于：`kind` 是**契约**命名空间里的值，绝非 Agenetes 的*实现*标识符（`acp` / `sdk`）：正是 `kind → driver` 这层别名，才让一个 driver 可以被重命名、拆分或合并，而不破坏每一份 spec（包括已持久化的）。

**I5.2 Two orthogonal top-level discriminants coexist / 两个正交的顶层判别式共存.**
The driver route (`kind`) and the workload kind (`Job` / `Deployment`) are independent top-level axes.
驱动路由（`kind`）与工作负载种类（`Job` / `Deployment`）是两根独立的顶层轴。

### I6. The request is driver-agnostic and polymorphic / request 与 driver 无关且多态

The per-turn `request` is *not* owned by the driver: it is a separate, driver-agnostic union keyed on its own `type` (a canvas selection, a dictionary, …), the same shared union in every spec member. The axis of variation is the request *variant*, not the driver — the same driver's next turn may receive a completely different variant with completely different rendering. A request is plain, JSON-serializable data; the durable log persists it verbatim as the source of truth for replay. **Rendering** a request into the uniform input fed to the agent is a separate, host-owned concern: each variant declares its own `render`, the host composes them, and a driver invokes the injected renderer at the last moment — **the driver never owns rendering.**
每轮的 `request` *不*归 driver 拥有：它是一个独立的、与 driver 无关的 union，以自己的 `type`（一次画布选择、一个字典……）为键，且在每个 spec 成员里都是同一个共享 union。变化的轴是 request 的*变体*，而非 driver——同一个 driver 的下一轮，可能收到一个渲染方式完全不同的变体。request 是普通、可 JSON 序列化的数据；持久日志原样保存它，作为回放的真相之源。把一个 request **渲染**成喂给 agent 的统一输入，是一个独立的、由宿主拥有的关注点：每个变体声明自己的 `render`，宿主把它们组合起来，driver 在最后一刻调用被注入的渲染器——**driver 从不拥有渲染。**

### I7. L1 ↔ Agenetes is an in-process ARI; Agenetes never talks to the browser / L1 ↔ Agenetes 是进程内 ARI；Agenetes 从不直接对浏览器说话

The host mounts Agenetes *in-process*. The path is always `UI → host server → Agenetes`; Agenetes only ever speaks the full-duplex ARI (calls / callbacks / async-iter). Any half-duplex transport artefact (HTTP + SSE to a browser) is confined to the host's own UI hop and bridged *inside the host server* — it must never leak into, or contaminate the design of, the L1↔Agenetes interface. The reverse permission call is the tell: one duplex method at host↔Agenetes, split into two correlated halves only across the browser wire.
宿主以*进程内*方式挂载 Agenetes。路径永远是 `UI → 宿主 server → Agenetes`；Agenetes 只说全双工的 ARI（调用 / 回调 / async-iter）。任何半双工的传输产物（到浏览器的 HTTP + SSE）都被限制在宿主自己的 UI 这一跳，并*在宿主 server 内部*桥接——它绝不能泄漏进、也不能污染 L1↔Agenetes 接口的设计。反向的权限调用就是明证：在宿主↔Agenetes 处是一个全双工方法，只有跨越浏览器线路时才被拆成两个相关联的半边。

### I8. The host addresses one mounted instance; the core surface stays minimal / 宿主面对一个被挂载的实例；核心表面保持最小

**I8.1 One mounted instance, like one cluster / 一个被挂载的实例，就像一个集群.**
The host talks to **one mounted Agenetes instance** — the way a user talks to *one* Kubernetes cluster / API server, never to a kubelet or a container runtime directly — not to scattered driver internals. The instance owns the runtime, pre-mounts the standard (ACP) driver, and accepts host-injected **custom** drivers (business-coupled, host-owned) plus transport wiring.
宿主面对**一个被挂载的 Agenetes 实例**——就像用户面对*一个* Kubernetes 集群 / API server，绝不直接面对某个 kubelet 或容器运行时——而不是面对散落的 driver 内部件。该实例拥有 runtime、预挂载标准（ACP）driver，并接收宿主注入的 **custom** driver（与业务耦合、宿主拥有）以及传输接线。

**I8.2 The core surface stays narrow; host-data / host-UX concerns stay in the host / 核心表面保持狭窄；依赖宿主数据/宿主 UX 的关注点留在宿主.**
The core L2 surface stays deliberately narrow — session lookup / lifecycle (`get` / `close`), the duplex `control(threadId, msg)` channel, and a `notifications()` stream of metadata changes. Concerns that depend on host data or host UX stay **host responsibilities**, not core surface: get-or-create-with-spec (spawn orchestration), profile/schema caching, and cold-start UX (painting a toolbar before the agent's authoritative state arrives — a host cache fed by subscribing to `notifications()`).
核心 L2 表面刻意保持狭窄——session 查找 / 生命周期（`get` / `close`）、全双工的 `control(threadId, msg)` 通道，以及一条元数据变化的 `notifications()` 流。凡依赖宿主数据或宿主 UX 的关注点，都留作**宿主职责**、不进核心表面：带 spec 的 get-or-create（spawn 编排）、profile/schema 缓存、以及冷启动 UX（在 agent 的权威状态到达前先画好工具栏——一个通过订阅 `notifications()` 喂养的宿主缓存）。

### I9. The spec carries its own env; Agenetes never assembles host URLs / spec 自带 env；Agenetes 从不拼装宿主 URL

Everything host-specific a workload needs at spawn — including any agent reachback env the host arranges (e.g. a host callback URL + thread id) — is **assembled in full by the host and carried on the `WorkloadSpec`** (as opaque `spec.env`). Agenetes passes `spec.env` straight through to the spawn call: it does not merge, add, or interpret any entry, and never composes a host URL or reads a host port. What the reachback env points at, and how the agent uses it, is entirely a host concern Agenetes never sees.
一个工作负载在 spawn 时所需的一切宿主相关内容——包括宿主安排的任何 agent 回连 env（例如一个宿主回调 URL + thread id）——都由**宿主完整拼装好并搭载在 `WorkloadSpec` 上**（作为不透明的 `spec.env`）。Agenetes 把 `spec.env` 原样传给 spawn 调用：它不合并、不添加、不解释任何条目，也从不拼装宿主 URL 或读取宿主端口。回连 env 指向什么、agent 如何使用它，完全是宿主的关注点，Agenetes 从不接触。

## Packages

```
external/agenetes/packages/
  @agenetes/protocol       [BASE · contracts]        deps: zod, acp-sdk
  @agenetes/runtime        [BASE · empty framework]  deps: protocol
  @agenetes/agentlet-host  [TRANSPORT · ACP-private] deps: protocol, @agentlet/server, fastify
  @agenetes/acp-driver     [DRIVER · standard]       deps: protocol, runtime, agentlet-host
```

- **`@agenetes/protocol`** — the L1↔L2 wire/control contracts: `WorkloadSpec` building blocks (`defineBinding` / `composeWorkloadSpec`, `defineRequest` / `composeRequest`), `AgentStreamEvent`, `ControlMsg` / `ControlAck`, `AgentCapabilities`, the `Namespace` scope, and the branded `threadId` / `sessionId` ids. Host-agnostic (zod + ACP SDK only).
- **`@agenetes/runtime`** — the driver registry + live-handle lifecycle owner (the `AgentRuntime`): `register` / `resolve` a driver by kind, and `get` / `create` / `close` a long-lived handle by `threadId`. Depends only on `@agenetes/protocol`.
- **`@agenetes/agentlet-host`** — the ACP transport host: mounts the agentlet WebSocket server and supervises the agentlet daemon. ACP-private (not shared base).
- **`@agenetes/acp-driver`** — the standard ACP driver and all its ACP-specific session state/logic: the handle, the client, the `session/update → AgentStreamEvent` translator, the in-memory session registry, the session store (session-id persistence for `session/load` recovery), the `ensureAcpSession` orchestration, and the ACP session-meta handling.
