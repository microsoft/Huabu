# Agenetes - The Kubernetes-Like Aggregating Control Plane for Agents Across Environments

Agenetes is a control plane for agent workloads. Just as Kubernetes' key capability is to guarantee that a declared pod (e.g., a docker container) exists and is reachable, Agenetes guarantees that **given an agent workload declaration, a process running that agent exists and is reachable**. According to the declaration, that process may run **in the current process** (the agent invoked directly as a library, with no cross-process communication), **on the current machine** (spawned as a local subprocess), or **on a remote server reached through Agenetes**. With its pluggable agent runtimes, various supported transports, a two-tier persistent logging system, and (soon) an agent service gateway, Agenetes lets you run any kind of agent behind a single runtime contract, connect it wherever its execution environment lives, keep every conversation durable and replayable, and let agents and external tools discover and call one another as services. So you can focus on your agent's logic and not on the plumbing.

Agenetes 是一个面向 agent workload 的控制平面。正如 Kubernetes 的关键能力在于保证一个已声明的 pod（例如一个 docker 容器）**存在且可达**，Agenetes 保证的是：**给定一份 agent workload 声明，就存在一个跑着该 agent 的进程，且它是可达的**。根据声明的不同，这个进程可以**就在当前进程内**运行（agent 作为库被直接调用，没有任何跨进程通信）、**在当前机器上**运行（作为本机子进程被拉起）、或**在一台通过 Agenetes 连接的远程服务器上**运行。凭借**可插拔的 agent runtime**、**多种受支持的 transport**、一套**两级持久化日志系统**，以及（即将支持的）**agent service gateway**，Agenetes 让你可以用同一套运行时契约运行任意类型的 agent、连接它所在的执行环境、让每段对话都可持久化并可回放，并让 agent 与外部工具彼此发现、作为服务相互调用。于是你可以专注于 agent 自身的逻辑，而不必操心底层管道。

Note that Agenetes is not a full agent-hosting platform like [Microsoft Azure AI Foundry](https://azure.microsoft.com/en-us/products/ai-foundry) or [Agent Substrate](https://github.com/agent-substrate/substrate). It does not promise sandboxing, multi-tenant isolation, fleet orchestration, or managed runtime hosting. Instead, it is an aggregating control plane for agent execution points across environments — local processes, agentlet-managed subprocesses, remote daemons, cloud servers, local-network machines, and host-builtin agents — so the host application can declare, invoke, interact with, and persist agent conversations through one uniform contract.

注意，Agenetes 不是像 [Microsoft Azure AI Foundry](https://azure.microsoft.com/en-us/products/ai-foundry) 或 [Agent Substrate](https://github.com/agent-substrate/substrate) 那样的完整 agent 托管平台。它不承诺 sandbox、多租户隔离、fleet orchestration 或托管 runtime。它更像一个聚合控制面，把分散在不同环境中的 agent execution points——本地进程、由 agentlet 管理的子进程、远程 daemon、云服务器、本地网络机器、以及 host-builtin agents——接到同一套契约之下，让 host application 可以统一声明、调用、交互并持久化 agent 对话。

## Core Concepts / 核心概念

Agenetes follows the same outer shape that makes Kubernetes easy to reason about: a declarative spec is bound to a runtime, the runtime materializes an execution instance, and the caller receives a live handle for continued interaction.

![Agenetes interface and framework at a glance](docs/assets/interface-framework-at-a-glance.svg)

The same concepts can be read as a compact vocabulary map:

| Kubernetes                                                | Agenetes                                                       | Meaning                                                                                                          |
| --------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| user / kubectl                                            | host application                                               | Declares and invokes workloads.                                                                                  |
| Pod spec                                                  | `WorkloadSpec`                                                 | The declarative workload description.                                                                            |
| Job / long-running workload                               | Workload lifecycle type (`workloadType`: `Job` / `Deployment`) | Lifecycle semantics: a `Job` mints a fresh handle for a run; a `Deployment` keeps one live handle by `threadId`. |
| scheduler                                                 | dispatcher                                                     | Kubernetes chooses a node; Agenetes resolves `WorkloadSpec.kind` to a driver.                                    |
| container runtime, such as containerd (previously Docker) | Agent Driver                                                   | The pluggable runtime implementation that materializes the workload.                                             |
| Pod                                                       | Agent Process                                                  | The execution instance that actually runs the declared workload.                                                 |
| Pod handle / pod subresources                             | Agent Handle                                                   | The live per-workload surface for running turns, sending controls, receiving streams, and closing the workload.  |
| Service / DNS                                             | agent service gateway _(planned)_                              | The stable discovery and invocation surface for agents and external tools.                                       |

From the host application's point of view, the flow is straightforward: declare a `WorkloadSpec`, invoke it, let Agenetes resolve the spec to an Agent Driver, and then drive the returned Agent Handle. The driver materializes the Agent Process at the placement already declared by the spec — in the current process, on the local machine, or on a remote server — and the handle is the live per-workload surface exposed through the uniform runtime contract. This is dispatching rather than scheduling because Agenetes resources are not fungible: an in-process runtime is tied to the current process and its injected capabilities, while a local or remote runtime may be tied to a particular filesystem, credential set, daemon, or execution environment. Treating those environments as interchangeable nodes would create the wrong abstraction.

从 host application 的视角看，流程很直接：声明一份 `WorkloadSpec`，调用它，让 Agenetes 把这份 spec 解析到某个 Agent Driver，然后继续驱动返回的 Agent Handle。driver 会在 spec 已经声明好的位置物化 Agent Process——当前进程、本机、或远程服务器——而 handle 则是通过统一运行时契约暴露出来的、每工作负载一个的 live surface。这是分发而不是调度，因为 Agenetes 面对的资源并不是可互换的：进程内 runtime 绑定在当前进程及其注入能力上，本机或远程 runtime 则可能绑定在某个特定文件系统、凭据集合、daemon 或执行环境上。把这些环境当作可互换 node 来选择，会制造错误的抽象。

## User-facing API surface / 面向用户的 API 表面

The user-facing API surface separates four concerns:

面向用户的 API 表面分为四类关注点：

| Surface             | Responsibility                                                                                                                |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Instance            | Top-level workload entrypoint: accept a `WorkloadSpec`, dispatch it to a driver, and return or locate the Agent Handle.       |
| Agent Handle        | Per-workload live interaction surface: run turns, stream output, send controls, inspect capabilities, and close.              |
| Persistent Querying | Durable read surface: inspect persisted thread records, replay folded history, and follow live state/event tails.             |
| Configuration       | Embedding-time setup surface: mount Agenetes, provide persistence backends, register driver factories, and bind driver kinds. |

Each surface has an in-process programmatic form today, used when Agenetes is mounted directly into a host application. The API-shaped forms below are suggested projections for a future process or network boundary; they describe the expected REST/SSE shape, not a finalized HTTP contract.

每个 surface 当前都有一种进程内的程序调用形态，用于 Agenetes 被直接 mount 进 host application 的场景。下表中的 API-shaped forms 是未来跨进程或网络边界时的投影建议；它们描述的是预期的 REST/SSE 形态，而不是最终 HTTP contract。

| Surface             | Current in-process API                                                          | Suggested API-shaped form _(planned)_                           | Meaning                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Instance            | `Agenetes.create(spec) -> AgentHandle`                                          | `POST /workloads`                                               | Realize a `WorkloadSpec`: Jobs mint a fresh handle; Deployments get-or-create the live handle by `threadId`. |
| Instance            | `Agenetes.get(threadId) -> AgentHandle \| undefined`                            | `GET /workloads/:threadId/live`                                 | Return the live Deployment handle when one is already running; never spawns.                                 |
| Instance            | `Agenetes.close(threadId) -> void`                                              | `DELETE /workloads/:threadId/live`                              | Close and evict the live handle for a thread.                                                                |
| Agent Handle        | `AgentHandle.run(submission, ctx) -> AsyncGenerator<AgentStreamEvent, TResult>` | `POST /workloads/:threadId/runs` + stream                       | Run one turn, stream `AgentStreamEvent`s, and return the driver's per-turn result.                           |
| Agent Handle        | `AgentHandle.control(msg) -> Promise<ControlAck>`                               | `POST /workloads/:threadId/control`                             | Send an out-of-turn `ControlMsg` and receive a `ControlAck`.                                                 |
| Agent Handle        | `AgentHandle.close() -> void`                                                   | `DELETE /workloads/:threadId/live`                              | Release this workload through the handle surface.                                                            |
| Agent Handle        | `AgentHandle.capabilities -> AgentCapabilities`                                 | `GET /workloads/:threadId/capabilities`                         | Read the operations and features this handle advertises.                                                     |
| Persistent Querying | `Agenetes.record(namespace, threadId) -> ThreadRecord \| undefined`             | `GET /namespaces/:namespace/workloads/:threadId`                | Read one durable thread record independent of handle liveness.                                               |
| Persistent Querying | `Agenetes.records(namespace) -> ThreadRecord[]`                                 | `GET /namespaces/:namespace/workloads`                          | Enumerate persisted thread records in one namespace.                                                         |
| Persistent Querying | `Agenetes.notifications(threadId) -> AsyncIterable<AgentMetadata>`              | `GET /workloads/:threadId/notifications`                        | Subscribe to persisted AgentMetadata updates.                                                                |
| Persistent Querying | `Agenetes.logMetadata(namespace, threadId) -> ThreadLogMetadata`                | `GET /namespaces/:namespace/workloads/:threadId/log-metadata`   | Read Tier-1 event and Tier-2 folded-turn counts without loading either log.                                  |
| Persistent Querying | `Agenetes.history(namespace, threadId, { withTail? }) -> ThreadHistory`         | `GET /namespaces/:namespace/workloads/:threadId/history?tail=1` | Read folded turns, optionally projecting the current Tier-1 tail as an incomplete turn snapshot.             |
| Persistent Querying | `Agenetes.tail(namespace, threadId) -> AsyncIterable<AgentStreamEvent>`         | `GET /namespaces/:namespace/workloads/:threadId/events`         | Follow the live Tier-1 event tail after the latest folded turn.                                              |
| Configuration       | `mountAgenetes(options) -> AgenetesBuilder`                                     | deployment / configuration API                                  | Create a builder and inject persistence backends such as thread, event, and turn stores.                     |
| Configuration       | `AgenetesBuilder.addFactory(factoryName, factory) -> AgenetesBuilder`           | deployment / configuration API                                  | Add a driver factory to the embedding's factory dictionary.                                                  |
| Configuration       | `AgenetesBuilder.register(driverName, factoryName, args?) -> AgenetesBuilder`   | deployment / configuration API                                  | Bind a workload `kind` (`driverName`) to a named driver factory and its configuration.                       |
| Configuration       | `AgenetesBuilder.build() -> Agenetes`                                           | deployment / configuration API                                  | Materialize the configured `Agenetes` instance.                                                              |

## The Name: Agenetes / 名称：Agenetes

The name is coined in the shape of its model, Kubernetes. Ancient Greek κυβερνήτης (_kubernḗtēs_, "helmsman/governor") is built from the root _kubern-_ plus the agentive suffix **-ήτης (_-ētēs_)**, "the one who does." Agenetes keeps **ag- / agen-** legible as "agent" while pointing back to the older "act / drive / lead" family behind Greek ἄγω and Latin _agō_ → _agent_; it then mirrors the same **-ētēs** agentive ending. The result suggests "the one who drives agents / sets agent workloads in motion" — precisely a control plane's job. It scans like its model: Ku-ber-NÉ-tēs ⟷ A-ge-NÉ-tēs.

这个名字是按 Kubernetes 的构词方式造出的。古希腊语 κυβερνήτης（_kubernḗtēs_，“舵手 / 治理者”）由词根 _kubern-_ 加施事后缀 **-ήτης (_-ētēs_)** 构成，意为“那个去做……的人”。Agenetes 中的 **ag- / agen-** 既保留了 “agent” 的可辨识性，也指向希腊语 ἄγω 与拉丁语 _agō_ → _agent_ 背后的“行动 / 驱动 / 引导”语义；结尾则对应同一个 **-ētēs** 施事后缀。因此它表达的不是简单的 `agen + netes` 切分，而是“驱动 agent / 使 agent workload 运转起来的人”——这正是 control plane 的工作。它的重音节奏也与其模型对应：Ku-ber-NÉ-tēs ⟷ A-ge-NÉ-tēs。

## Core invariants (the design consensus) / 核心不变量（设计共识）

The numbered invariants below (I1–I10, with sub-clauses I*n*._m_) are the design consensus, meant to be cited by reference id. Each is stated in English then Chinese; code blocks and tables are not duplicated.

下列带编号的不变量（I1–I10，含子条款 I*n*._m_）即设计共识，供按编号引用。每条先英文后中文；代码块与表格不做双语重复。

### I1. Agenetes is not a scheduler — it is an executor / 不是调度器，而是执行器

Working the Kubernetes analogy to its breaking point is the fastest way to record what Agenetes deliberately is **not**. A scheduler _chooses_ a placement among interchangeable candidates (scoring, bin-packing, preemption, rescheduling). Agenetes has no such choice.

把 Kubernetes 类比推到它的断裂点，是记录 Agenetes 刻意**不是**什么的最快方式。调度器会在可互换的候选之间*挑选*一个放置位置（打分、装箱、抢占、重新调度）。Agenetes 没有这种选择权。

**I1.1 Drivers are not fungible — each _is_ its resource / Driver 不可互换——每个 driver 就是它绑定的资源.**
The K8s scheduler assumes interchangeable Nodes with state externalised to a PV; Agenetes drivers are the opposite. An ACP driver is bound to a specific agentlet daemon + that machine's filesystem (the session's files and live process live _there_); a host-builtin driver is bound to this process + the capability ports injected at registration. Neither can move.

K8s 调度器假设 Node 可互换、状态被外置到 PV；Agenetes 的 driver 恰好相反。ACP driver 绑定到某个特定的 agentlet daemon + 那台机器的文件系统（session 的文件与活进程就*在那里*）；host-builtin driver 绑定到本进程 + 注册时注入的能力端口。两者都不可迁移。

**I1.2 Routing has two dimensions with opposite mutability / 路由有两个可变性相反的维度.**
The **class** (`kind → driver type`) is static wiring Agenetes owns and may re-point. The **instance** (which daemon / which live session) is _pinned by the spec's resource reference_ (a profile id, a persisted session id) and is **not** relocatable.

**类**（`kind → driver 类型`）是 Agenetes 拥有、可重新指向的静态接线。**实例**（哪个 daemon / 哪个活 session）由 _spec 的资源引用_（profile id、已持久化的 session id）钉死，**不可**迁移。

**I1.3 Failure is rebuild-or-fail, never reschedule / 失败即重建或失败，绝不重新调度.**
If the bound resource is gone, the workload is rebuilt from durable state (the turn log / persisted session) or it fails. There is no K8s-style "pod drifts to another node".

如果被绑定的资源没了，工作负载要么从持久状态（轮次日志 / 已持久化的 session）重建，要么失败。不存在 K8s 那种"pod 漂移到另一个 node"。

So the control-plane roles Agenetes fills are:

因此 Agenetes 承担的控制面角色是：

| K8s control-plane role                                 | In Agenetes?                                                   |
| ------------------------------------------------------ | -------------------------------------------------------------- |
| Scheduler (choose placement among candidates)          | **No** — placement is declared in the spec, pinned by affinity |
| Admission (gate: requested capabilities ⊆ advertised)  | **No** — capabilities describe a realized handle, not routing  |
| kubelet / CRI (execute + reconcile a _given_ workload) | Yes — `create` + pipe + lifecycle                              |
| Service / DNS (resolve a name → a fixed endpoint)      | Yes — deterministic `kind → driver`                            |

Agenetes is therefore closer to a **service-mesh sidecar / reverse proxy**: resolve by declared identity, admit, and pipe. Cross-resource scheduling (fleet bin-packing, autoscaling across machines) is an explicit **non-goal** — were it ever needed it would be a _new_ layer above Agenetes, not a widening of this one. (The daemon's lazy-spawn / idle-suspend / resume is lifecycle _reconcile_ of one already-bound resource — a kubelet job — not placement selection.)

因此 Agenetes 更接近一个 **service-mesh sidecar / 反向代理**：按声明的身份解析、准入、然后转接。跨资源调度（机队装箱、跨机自动扩缩）是明确的**非目标**——真要用到，那也是 Agenetes 之上的一个*新层*，而不是把这一层撑大。（daemon 的惰性 spawn / idle 挂起 / resume 是对*一个已绑定资源*的生命周期 _reconcile_——一件 kubelet 的活——而非放置选择。）

### I2. Drivers are registered workload-realization implementations / Driver 是注册后负责 workload realization 的实现

A **driver** teaches Agenetes how to realize one supported class of agent workload and exposes the result as an `AgentHandle` — the direct analogue of a container runtime such as containerd or CRI-O. The host application explicitly selects a registered driver through the public `WorkloadSpec.kind` route (I5); Agenetes does not infer a driver from an agent definition or choose among interchangeable candidates. The current standard drivers are ACP, which realizes ACP-connected agents, and pi, which realizes in-process pi-agent-core workloads.

一个 **driver** 教会 Agenetes 如何物化一类受支持的 agent workload，并将结果暴露为 `AgentHandle`——它直接对应 containerd、CRI-O 这样的容器运行时。host application 通过公开的 `WorkloadSpec.kind` route（I5）显式选择已注册 driver；Agenetes 不从 agent definition 推断 driver，也不在可互换候选项之间进行选择。当前的 standard drivers 是 ACP 与 pi：前者物化 ACP-connected agents，后者物化 in-process pi-agent-core workloads。

Each concrete driver fixes one supported combination of three mostly independent dimensions: **binding schema** — the create-time declaration under `WorkloadSpec.spec` that the driver understands; **runtime protocol** — the backend interaction semantics that the driver normalizes into `AgentHandle`; and **transport** — how that protocol is carried, such as in-process calls, stdio, WebSocket, or an agentlet relay. Agenetes does not require a complete Cartesian product across these dimensions. Workload lifecycle (`Job` / `Deployment`, I3) is an orthogonal control-plane axis, while agent templates and profiles remain an upper-layer catalog/content concern rather than another driver category.

每个具体 driver 固定三根基本独立维度的一种受支持组合：**binding schema**——driver 所理解的、位于 `WorkloadSpec.spec` 下的 create-time declaration；**runtime protocol**——driver 归一化为 `AgentHandle` 的 backend interaction semantics；以及 **transport**——该 protocol 的承载方式，例如 in-process calls、stdio、WebSocket 或 agentlet relay。Agenetes 不要求这些维度形成完整笛卡尔积。workload lifecycle（`Job` / `Deployment`，I3）是正交的 control-plane axis；agent templates 与 profiles 则属于上层 catalog/content concern，而不是另一种 driver category。

For the deeper driver model and representative combinations, see [`docs/concepts/driver_cn.md`](docs/concepts/driver_cn.md).

关于更完整的 driver 模型与代表性组合，见 [`docs/concepts/driver_cn.md`](docs/concepts/driver_cn.md)。

**I2.1 Drivers are built by factories; standard vs custom identifies who provides the factory / Driver 由 factory 构造；standard 与 custom 区分 factory 的提供方.**
Agenetes owns a driver factory dictionary named `factories`, initially populated with the standard factories maintained and supported by the Agenetes project; ACP and pi are the current standard examples. While mounting, a host application may append custom factories with `AgenetesBuilder.addFactory(factoryName, factory)`. Through the mounting builder, the host application explicitly registers each driver with `AgenetesBuilder.register(driverName, factoryName, factoryArgs)`, conceptually `drivers[driverName] = factories[factoryName](factoryArgs)`; the registration is materialized when `AgenetesBuilder.build()` runs. `driverName` is the public contract route carried by `WorkloadSpec.kind`; `factoryName` is the implementation identity and one factory may instantiate multiple named drivers with different arguments. Standard and custom drivers are structurally identical after construction: the distinction records who provides and supports the factory, not how the resulting `AgentDriver` behaves. Configuring or wrapping a standard factory with host-owned ports does not by itself make the driver custom. Factory extension through `AgenetesBuilder.addFactory(...)` and driver registration through `AgenetesBuilder.register(...)` are static mount-time wiring; the built instance exposes no dynamic registration surface.

Agenetes 持有一个名为 `factories` 的 driver factory dictionary，初始包含由 Agenetes 项目维护并提供支持的 standard factories；当前的 standard 例子是 ACP 与 pi。mounting 期间，host application 可以通过 `AgenetesBuilder.addFactory(factoryName, factory)` 追加 custom factories。host application 通过 mounting builder，以 `AgenetesBuilder.register(driverName, factoryName, factoryArgs)` 显式注册每个 driver；其概念上等价于 `drivers[driverName] = factories[factoryName](factoryArgs)`，该注册在 `AgenetesBuilder.build()` 时物化。`driverName` 是由 `WorkloadSpec.kind` 携带的公开契约 route；`factoryName` 是实现身份，同一个 factory 可以用不同参数实例化多个具名 driver。standard 与 custom driver 在构造后结构完全相同：该区分记录的是谁提供并支持 factory，而不是生成的 `AgentDriver` 如何运行。用 host-owned ports 配置或包装 standard factory，本身不会让该 driver 变成 custom。通过 `AgenetesBuilder.addFactory(...)` 扩展 factory、通过 `AgenetesBuilder.register(...)` 注册 driver，二者都是静态的 mount-time wiring；构建完成的 instance 不暴露动态注册接口。

**I2.2 Agenetes dispatches create calls by `kind` and routes handle lifecycle by `workloadType` / Agenetes 按 `kind` 分发 create call，并按 `workloadType` 路由 handle 生命周期.**
When a host calls `Agenetes.create(spec: WorkloadSpec)` (I9.3), Agenetes selects `drivers[spec.kind]`, where `spec.kind` is the registered `driverName` (I5.1). If `spec.workloadType === 'Job'` (I3), Agenetes creates a fresh `AgentHandle` (I8) through `AgentDriver.create(spec, createContext)` and returns it without retaining it in the live-handle table. If `spec.workloadType === 'Deployment'`, Agenetes first looks up the globally unique `spec.threadId` (I4.2) in the live-handle table: when a live handle exists, Agenetes returns it directly; otherwise Agenetes creates one through the same `AgentDriver.create(spec, createContext)` path, stores it under `spec.threadId`, and returns it. The Deployment-side live-handle lookup and storage are implemented internally by `AgentRuntime`. How Agenetes derives the spec and `AgentCreateContext` supplied to this flow for fresh creation, recovery, and fork is defined separately.

当 host 调用 `Agenetes.create(spec: WorkloadSpec)`（I9.3）时，Agenetes 选择 `drivers[spec.kind]`，其中 `spec.kind` 就是注册时的 `driverName`（I5.1）。如果 `spec.workloadType === 'Job'`（I3），Agenetes 通过 `AgentDriver.create(spec, createContext)` 创建一个 fresh `AgentHandle`（I8）并直接返回，不将其保留在 live-handle table 中。如果 `spec.workloadType === 'Deployment'`，Agenetes 首先使用全局唯一的 `spec.threadId`（I4.2）查询 live-handle table：如果已有 live handle，Agenetes 直接返回；否则 Agenetes 通过同一条 `AgentDriver.create(spec, createContext)` 路径创建 handle，将其以 `spec.threadId` 为键存入表中，再返回该 handle。Deployment 一侧的 live-handle 查询与存储由内部的 `AgentRuntime` 实现。对于 fresh creation、recovery 与 fork，Agenetes 如何推导传入这一流程的 spec 与 `AgentCreateContext`，将在其他段落单独定义。

**I2.3 Absorbed into I2.1 and I2.2 / 已合并至 I2.1 与 I2.2.**
The former candidacy and capability-based routing model has been retired. Factory registration is defined by I2.1; exact `kind` dispatch and lifecycle routing are defined by I2.2.

原先的 candidacy 与 capability-based routing 模型已经废弃。factory registration 由 I2.1 定义；精确的 `kind` dispatch 与 lifecycle routing 由 I2.2 定义。

**I2.4 `AgentDriver` realizes workloads; it does not route them / `AgentDriver` 物化 workload，但不负责路由.**
Routing and workload realization are separate responsibilities. Agenetes owns routing: `AgenetesBuilder.register(...)` binds a public `driverName` to a constructed `AgentDriver` (I2.1), and `Agenetes.create(...)` selects that driver through `WorkloadSpec.kind` (I2.2). Once selected, the `AgentDriver` owns only realization: `AgentDriver.create(spec, createContext)` turns the workload's serializable spec and creation context into an `AgentHandle` (I8). An `AgentDriver` therefore carries no dispatch `kind`, does not advertise candidate routes, and does not select or fall back to another driver.

Routing 与 workload realization 是两项分离的职责。Agenetes 拥有 routing：`AgenetesBuilder.register(...)` 将公开的 `driverName` 绑定到一个构造完成的 `AgentDriver`（I2.1），`Agenetes.create(...)` 再通过 `WorkloadSpec.kind` 选择该 driver（I2.2）。driver 被选中后，`AgentDriver` 只负责 realization：`AgentDriver.create(spec, createContext)` 将 workload 的可序列化 spec 与 creation context 物化为 `AgentHandle`（I8）。因此，`AgentDriver` 不携带 dispatch `kind`，不声明候选 route，也不选择或 fallback 到其他 driver。

```ts
interface AgentDriver<TSpec = unknown, …> {
  create(
    spec: TSpec,
    createContext: AgentCreateContext<TSpec>,
  ): AgentHandle;
}
```

**I2.5 Standard driver factories expose typed ports for host customization / Standard driver factory 通过 typed ports 暴露 host customization.**
Besides adding a custom driver factory, a host application can customize a standard driver by implementing the typed ports exposed through that standard factory's `factoryArgs`. These ports connect host-owned models, credentials, tools, transports, and policy services to the standard driver while preserving its workload realization model. Per-workload `WorkloadSpec` data may carry symbolic references and opaque host context that the driver passes to those ports. The ports are bootstrap-time dependencies supplied through `AgenetesBuilder.register(...)`; they are not backing agent or session objects injected into each `AgentDriver.create(...)` call.

除了添加 custom driver factory，host application 还可以通过实现 standard factory 在 `factoryArgs` 中暴露的 typed ports，来定制 standard driver。这些 ports 将 host-owned models、credentials、tools、transports 与 policy services 接入 standard driver，同时保持该 driver 的 workload realization model。per-workload `WorkloadSpec` data 可以携带 symbolic references 与 opaque host context，由 driver 将其传递给这些 ports。这些 ports 是通过 `AgenetesBuilder.register(...)` 提供的 bootstrap-time dependencies，而不是在每次 `AgentDriver.create(...)` call 中注入的 backing agent 或 session objects。

For example, Huabu configures the standard pi driver with `PiDriverPorts`: `PiDriverPorts.resolveModel(...)` resolves the host's active model, `PiDriverPorts.getApiKey(...)` supplies its current credential, and `PiDriverPorts.resolveTools(...)` turns symbolic `PiToolRef`s into Huabu's concrete canvas-aware tools. The driver registration supplies those ports once, while each `PiWorkloadSpec` carries only serializable model/tool references and opaque canvas context:

例如，Huabu 通过 `PiDriverPorts` 配置 standard pi driver：`PiDriverPorts.resolveModel(...)` 解析 host 的 active model，`PiDriverPorts.getApiKey(...)` 提供当前 credential，`PiDriverPorts.resolveTools(...)` 将 symbolic `PiToolRef` 转换为 Huabu 具体的、canvas-aware tools。driver registration 只注入一次这些 ports，而每个 `PiWorkloadSpec` 只携带可序列化的 model/tool references 与 opaque canvas context：

```ts
const agenetes = mountAgenetes()
  .register('internal', 'pi', { ports: huabuPiDriverPorts })
  .build();
```

**I2.5.1 Absorbed into I2.5 / 已合并至 I2.5.**
The former host-builtin object-injection example has been retired; Huabu now configures the standard pi driver through typed ports.

原先的 host-builtin object-injection 示例已经废弃；Huabu 现在通过 typed ports 配置 standard pi driver。

**I2.5.2 Absorbed into I2.2 and I2.4 / 已合并至 I2.2 与 I2.4.**
The former ACP-specific creation example has been retired. Driver dispatch and lifecycle routing are defined by I2.2; workload realization is defined by I2.4.

原先的 ACP-specific creation 示例已经废弃。driver dispatch 与 lifecycle routing 由 I2.2 定义；workload realization 由 I2.4 定义。

**I2.6 `AgentDriver.create(...)` is a staged realization process for durable workloads / 对于 durable workload，`AgentDriver.create(...)` 是一个分级 realization 过程.**
For a Deployment, `AgentDriver.create(spec, createContext)` is reached only after Agenetes finds no live handle for the globally unique `spec.threadId` (I2.2, I4.2). Agenetes supplies every durable input needed by realization through `AgentCreateContext`: the source identity, its durable `ThreadRecord` (`spec` plus `AgentStateSnapshot`), its folded `AgentTurn`s, and the recovery-policy service. The driver never reads Agenetes stores directly. A threaded Job can receive the same durable input through the same interface, but its newly created handle is not retained in the live-handle table (I2.2, I3).

对于 Deployment，只有在 Agenetes 没有找到全局唯一 `spec.threadId` 所对应的 live handle 后，才会进入 `AgentDriver.create(spec, createContext)`（I2.2、I4.2）。realization 所需的所有 durable input 都由 Agenetes 通过 `AgentCreateContext` 提供：source identity、其 durable `ThreadRecord`（`spec` 加 `AgentStateSnapshot`）、其 folded `AgentTurn`s，以及 recovery-policy service。driver 绝不直接读取 Agenetes stores。threaded Job 也可以通过同一接口接收相同的 durable input，但其新建 handle 不会保留在 live-handle table 中（I2.2、I3）。

Conceptually, the handle created by `AgentDriver.create(...)` realizes its backend through the following conditional flow. A driver may perform these stages eagerly during creation or lazily when the handle is first used, according to what its harness supports:

概念上，由 `AgentDriver.create(...)` 创建的 handle 按以下条件流物化其 backend。driver 可以根据 harness 所支持的机制，在 creation 期间 eager 执行这些阶段，或延迟到 handle 首次使用时 lazy 执行：

```text
if createContext.durableInput is absent:
  create a fresh backend from spec
else if durableInput.source identity equals spec target identity:
  if the backend can use durableInput.record.state for native recovery:
    try native session resume or snapshot restoration
    if recovery succeeds:
      use the recovered backend
    if recovery fails for any reason other than structured "resume unavailable":
      fail
  authorize history loading through createContext.recovery
  create a new backend and load durableInput.turns using the strongest mechanism the harness provides
```

History loading is driver-owned: a harness may absorb turns while constructing native state, initialize from a native transcript, defer loading until first use, or combine history with the first real turn. Agenetes standardizes the durable inputs and authorization service, not a mandatory sequence of driver recovery methods.

history loading 由 driver 拥有：harness 可以在构造 native state 时吸收 turns、从 native transcript 初始化、延迟到首次使用时加载，或将 history 与第一个真实 turn 合并。Agenetes 标准化的是 durable inputs 与 authorization service，而不是一套强制的 driver recovery methods 序列。

Fork uses the same realization interface. `Agenetes.fork(sourceIdentity, targetSpec)` supplies an `AgentCreateContext` whose materialized input comes from the source thread, while `targetSpec` contains the new target thread identity and complete target configuration. The target starts with empty driver-native state, so the driver creates a new backend and realizes it from the source turns—including an optional incomplete tail projection—rather than inheriting the source `sessionId`; source turns seed the target driver's native context and are not copied into the target's Tier-2 log.

fork 使用同一个 realization interface。`Agenetes.fork(sourceIdentity, targetSpec)` 提供的 `AgentCreateContext` 中，durable input 来自 source thread，而 `targetSpec` 包含新的 target thread identity 与完整 target configuration。target 从空的 driver-native state 开始，因此 driver 创建新的 backend，并根据 source turns 物化它，而不继承 source `sessionId`；Agenetes 同时将这些 folded turns 复制到 target 的 durable turn log。

**I2.6.1 History loading is gated by the instance auto-recovery policy / History loading 受 instance auto-recovery policy 约束.**
The policy gates folded-history loading only; successful backend-native recovery does not consume this uncertainty budget. Before loading turns for recovery or fork, a driver calls `AgentRecoveryContext.authorizeHistoryLoad(...)`. Agenetes estimates the load as `ceil(serialized AgentTurn UTF-8 bytes / 4.5)` and applies the mount-time `AutoRecoverPolicy`:

该 policy 只约束 folded-history loading；成功的 backend-native recovery 不消耗这份 uncertainty budget。在为 recovery 或 fork 加载 turns 前，driver 调用 `AgentRecoveryContext.authorizeHistoryLoad(...)`。Agenetes 以 `ceil(serialized AgentTurn UTF-8 bytes / 4.5)` 估算 load，并应用 mount-time `AutoRecoverPolicy`：

```text
if mode is "recover" and policy.enabled is false:
  deny with "auto_recover_disabled"
else if estimated size <= policy.safeHistoryLoadLimit:
  allow
else if policy.onThresholdExceeded is "deny":
  deny with "safe_limit_exceeded"
else if no policy.confirm handler is installed:
  deny with "confirmation_unavailable"
else if policy.confirm(...) returns false:
  deny with "confirmation_declined"
else:
  allow
```

The default policy is `{ enabled: true, safeHistoryLoadLimit: 10_000, onThresholdExceeded: 'deny' }`. Explicit fork is not disabled by `policy.enabled`, because fork is already an explicit host action, but it remains subject to the same size limit and confirm-or-deny behavior.

默认 policy 是 `{ enabled: true, safeHistoryLoadLimit: 10_000, onThresholdExceeded: 'deny' }`。显式 fork 不受 `policy.enabled` 禁用，因为 fork 本身已经是 host 的显式操作；但它仍受同一 size limit 与 confirm-or-deny behavior 约束。

### I3. Workload lifecycle types: Job vs Deployment / 工作负载生命周期类型：Job vs Deployment

Callers do not choose a reconcile strategy (declarative vs imperative — that is an internal detail); they choose a **workload lifecycle type** (`workloadType`), which differs only in **completion semantics**:

调用方不选择 reconcile 策略（声明式 vs 命令式——那是内部细节）；他们选择一个**工作负载生命周期类型（workload lifecycle type）**，也就是 `workloadType`，二者只在**完成语义**上不同：

| Lifecycle type | Desired state                                               | Completion                    | K8s analogue  |
| -------------- | ----------------------------------------------------------- | ----------------------------- | ------------- |
| **Deployment** | "while the thread is live, a conversational session exists" | never (idle-suspend / resume) | Deployment    |
| **Job**        | "run this prompt once, stream the result, then close"       | terminal (Complete / Failed)  | Job / CronJob |

**I3.1 Both lifecycle types are owned by Agenetes / 两种生命周期类型都由 Agenetes 拥有.**
Both are built-in, first-class lifecycle types owned by Agenetes — completion semantics _are_ the control plane's core responsibility; a host only fills in a workload spec, never defines a type's reconcile logic.

两者都是 Agenetes 拥有的内建一等 kind——完成语义*正是*控制面的核心职责；宿主只填写工作负载 spec，绝不定义某个 kind 的 reconcile 逻辑。

**I3.2 Realizability constraint (kind × driver) / 可实现性约束（kind × driver）.**
A **Job** runs on a stateless SDK driver _or_ an ACP session; a **Deployment** (live conversation with in-process state, slash commands, mode/config switching) requires a stateful runtime — the ACP driver only.

一个 **Job** 可跑在无状态的 SDK driver *或*一个 ACP session 上；一个 **Deployment**（带进程内状态、斜杠命令、模式/配置切换的活会话）需要有状态运行时——只有 ACP driver。

**I3.3 The initiator need not be human / 发起者不必是人.**
A program, a workflow step, or another agent can start a workload (especially a Job); "who triggered it" is not a layering discriminant.

一个程序、一个工作流步骤或另一个 agent 都能发起工作负载（尤其是 Job）；"谁触发的"不是分层的判据。

**I3.4 Reserved terms — `Service` and `sessionId` / 保留术语——`Service` 与 `sessionId`.**
The word **`Service`** is reserved for a _different_, future concept — a capability/endpoint exposed _into_ Agenetes for other agents to consume (agent-as-a-service, MCP, the reachback surface) — matching the K8s meaning of a stable endpoint, orthogonal to a workload. The lower-level **`sessionId`** (the concrete execution instance — the "pod") stays a distinct term.

**`Service`** 一词保留给一个*不同的*、未来的概念——一个*暴露进* Agenetes、供其它 agent 消费的能力/端点（agent-as-a-service、MCP、回连面）——对应 K8s 中"稳定端点"之意，与工作负载正交。更底层的 **`sessionId`**（具体执行实例——那个"pod"）保持为一个独立术语。

### I4. Identity model: namespace → threadId → sessionId / 身份模型：namespace → threadId → sessionId

A three-level identity model, each level opaque to Agenetes (pure data it persists/routes on but never interprets):

一个三层身份模型，每一层对 Agenetes 都是不透明的（它据以持久化/路由、但从不解释的纯数据）：

**I4.1 `namespace` — the storage / metadata scope, _above_ the thread / 存储/元数据作用域，位于 thread _之上_.**
A group-of-threads tenant/**isolation** boundary with its own `storage` scope (`{ name, storage? }`, where `storage` is plain, serializable data `{ root }` — a location root, **not** a method-bearing resolver, since the namespace rides the serializable `WorkloadSpec`, I8.5). Each internal Agenetes consumer derives its own sub-path below `root`, so _thread history_ and the _persistent thread table_ share one namespace root but differ in sub-path. The K8s namespace / Virtual Cluster. A thread belongs to exactly one namespace. Because the namespace **is** the isolation boundary, Agenetes partitions its durable state per namespace — the **persistent thread table is one-per-namespace** — which is exactly why the **query surface (I9.4) is namespace-scoped**, addressed by `(namespace, threadId)`, while the _live_ handle table (I9.3) stays global and `threadId`-keyed (I4.2). The host gives the namespace meaning. `root` is optional: omitted, Agenetes derives a default under its own data root; and `storage` may later grow typed per-purpose entries or non-filesystem persistence services without breaking the contract.

一个"多 thread 成组"的租户/**隔离**边界，带自己的 `storage` 作用域（`{ name, storage? }`，其中 `storage` 是纯粹、可序列化的数据 `{ root }`——一个位置根，**而非**带方法的解析器，因为 namespace 搭乘可序列化的 `WorkloadSpec`，见 I8.5）。每个 Agenetes 内部消费者在 `root` 之下派生自己的子路径，因此*thread 历史*与*持久 thread table*共用同一个 namespace 根、但子路径不同。对应 K8s 的 namespace / Virtual Cluster。一个 thread 恰好属于一个 namespace。因为 namespace **就是**隔离边界，Agenetes 按 namespace 分片其持久状态——**持久 thread table 每个 namespace 一张**——这正是**查询表面（I9.4）按 namespace 作用域寻址**（按 `(namespace, threadId)`）、而*活* handle 表（I9.3）保持全局、按 `threadId` 键（I4.2）的原因。含义由宿主赋予。`root` 可选：省略时 Agenetes 在自有数据根下派生默认位置；`storage` 日后可长出 typed 的 per-purpose 条目或非文件系统的持久化服务，而不破坏契约。

**I4.2 `threadId` — the caller-side _slot_ identity, host-minted / 调用侧的*槽位*身份，由宿主铸造.**
Agenetes routes on it, caches the live handle on it, and keys the durable log on it; it never interprets its structure. Everything the slot _represents_ (which canvas, node, user) is held by the host, indexed by `threadId`, and never enters the Agenetes contract. `threadId` is **globally unique** (a host guarantee), so the live handle table and `get(threadId)` (I9.3) need no namespace; the durable thread table is nonetheless namespace-partitioned for isolation (I4.1), addressed by `(namespace, threadId)`.

Agenetes 据它路由、据它缓存活 handle、据它作为持久日志的键；但从不解释它的结构。这个槽位所*代表*的一切（哪个画布、节点、用户）由宿主持有、按 `threadId` 索引，绝不进入 Agenetes 契约。`threadId` **全局唯一**（宿主保证），因此活 handle 表与 `get(threadId)`（I9.3）无需 namespace；而持久 thread table 出于隔离仍按 namespace 分片（I4.1），按 `(namespace, threadId)` 寻址。

**I4.3 `sessionId` — the concrete execution instance (pod-level) / 具体执行实例（pod 级）.**
The instance backing a workload; the unit `session/load` recovery keys on.

支撑一个工作负载的实例；也是 `session/load` 恢复所依据的单元。

### I5. Dispatch is on a caller-set `kind` discriminant / 分发基于调用方设定的 `kind` 判别式

**I5.1 The caller names its driver, in the contract namespace / 调用方点名它要的 driver，且用契约命名空间.**
Unlike a fungible K8s PodSpec, the Agenetes caller **knows exactly which driver it wants and names it** — because the drivers are not interchangeable. So the `WorkloadSpec` is a tagged union keyed on a required, top-level, public `kind` field (`internal` / `external`, …), each member carrying only the fields its driver consumes. Crucially `kind` is a value in the **contract** namespace, never Agenetes' _implementation_ identifier (`acp` / `sdk`): the alias `kind → driver` is what lets a driver be renamed, split, or merged without breaking every spec (including persisted ones).

不同于可互换的 K8s PodSpec，Agenetes 的调用方**明确知道自己要哪个 driver 并点名它**——因为 driver 不可互换。因此 `WorkloadSpec` 是一个以必填、顶层、公开的 `kind` 字段（`internal` / `external`……）为键的 tagged union，每个成员只携带其 driver 消费的字段。关键在于：`kind` 是**契约**命名空间里的值，绝非 Agenetes 的*实现*标识符（`acp` / `sdk`）：正是 `kind → driver` 这层别名，才让一个 driver 可以被重命名、拆分或合并，而不破坏每一份 spec（包括已持久化的）。

**I5.2 Two orthogonal top-level discriminants coexist / 两个正交的顶层判别式共存.**
The driver route (`kind`) and the workload lifecycle type (`workloadType`: `Job` / `Deployment`) are independent top-level axes.

驱动路由（`kind`）与工作负载生命周期类型（`workloadType`：`Job` / `Deployment`）是两根独立的顶层轴。

### I6. A submission preserves host source and canonical agent input / submission 同时保留宿主 source 与 canonical agent input

The per-turn `AgentSubmission<TSource>` is plain serializable data: `{ type, content, rendered? }`. `type` and `content` preserve the host application's source model for history and projections; optional `rendered: AgentInput[]` preserves the ordered canonical input produced by host rendering. The host completes rendering **before** `run()` and passes no renderer closure across the seam. If `rendered` is absent, Agenetes resolves string content verbatim or JSON-stringifies structured content into one text input; an explicit empty array means zero inputs. The complete submission is persisted in the historical `AgentTurn.request` field so recovery and fork consume the original canonical input without calling host rendering again.

每轮的 `AgentSubmission<TSource>` 都是普通、可序列化的数据：`{ type, content, rendered? }`。`type` 与 `content` 保留 host application 的 source model，供历史与投影使用；可选的 `rendered: AgentInput[]` 保留 host rendering 生成的有序 canonical input。host 在调用 `run()` **之前**完成 rendering，接缝上不再传 renderer closure。缺少 `rendered` 时，Agenetes 把 string content 原样转成一条 text input，或把结构化 content JSON stringify成一条 text input；显式空数组表示零输入。完整 submission 持久化在沿用历史命名的 `AgentTurn.request` 字段中，因此 recovery 与 fork 可直接消费原始 canonical input，无需重新调用 host rendering。

`AgentInput[]` guarantees member order and one enclosing turn, not one backend message per member. A driver preserves member boundaries only when its harness accepts multiple messages atomically in one turn; otherwise it flattens them in order into one backend input. It must never create multiple backend turns merely to preserve member boundaries. A command is explicit and exclusive: if `rendered` contains an `AgentCommandInput`, it is the sole top-level member and all related material rides `command.context`.

`AgentInput[]` 保证成员顺序与一个外层 turn，而不保证每个成员都成为一条 backend message。只有当 harness 能在一个 turn 中原子接收多条消息时，driver 才保留成员边界；否则就按序 flatten 成一个 backend input。driver 绝不能仅为保留成员边界而制造多个 backend turns。command 是显式且独占的：若 `rendered` 含 `AgentCommandInput`，它必须是唯一的顶层成员，相关材料全部搭乘 `command.context`。

### I7. Host application↔Agenetes is a full-duplex in-process seam; Agenetes never talks to the browser / host application↔Agenetes 是进程内全双工接缝；Agenetes 从不直接对浏览器说话

The host application mounts Agenetes _in-process_. The path is always `UI → host application server → Agenetes`; across that in-process seam Agenetes only ever speaks one **full-duplex channel** (calls / callbacks / async-iter). Any half-duplex transport artefact (HTTP + SSE to a browser) is confined to the host application's own UI hop and bridged _inside the host application server_ — it must never leak into, or contaminate the design of, the host application↔Agenetes interface. The reverse permission call is the tell: one duplex method at host application↔Agenetes, split into two correlated halves only across the browser wire.

host application 以*进程内*方式挂载 Agenetes。路径永远是 `UI → host application server → Agenetes`；在这条进程内接缝上，Agenetes 只说一条**全双工通道**（调用 / 回调 / async-iter）。任何半双工的传输产物（到浏览器的 HTTP + SSE）都被限制在 host application 自己的 UI 这一跳，并*在 host application server 内部*桥接——它绝不能泄漏进、也不能污染 host application↔Agenetes 接口的设计。反向的权限调用就是明证：在 host application↔Agenetes 处是一个全双工方法，只有跨越浏览器线路时才被拆成两个相关联的半边。

### I8. `AgentHandle` — the per-workload runtime contract, and the host application↔Agenetes binding / `AgentHandle`——每工作负载的运行时契约，也是 host application↔Agenetes 的绑定

`AgentHandle` is Agenetes' transport-agnostic per-workload runtime contract. Two roles meet at the handle: a **driver** implements it from below by creating one handle for a workload (I2), while the host application consumes it from above by driving `run`, `control`, and `close`. The handle is therefore the live surface of one workload, not a separate third concept: a driver's `create` produces it, and the host application drives the running workload only through it. Because its I/O is serializable messages, the same handle contract admits a direct in-memory binding (host-builtin fast path, zero serialization) or a remote binding (over agentlet) with no change upward — in-process is a transport optimisation of one serializable contract.

`AgentHandle` 是 Agenetes 面向每个 workload 的、与 transport 无关的运行时契约。有两个角色在 handle 这里相遇：**driver** 从下方通过为一个 workload 创建 handle 来实现它（见 I2），而 host application 从上方通过 `run`、`control`、`close` 来消费它。因此 handle 就是一个 live workload 的操作表面，而不是额外的第三个概念：driver 的 `create` 生产它，host application 只通过它驱动运行中的 workload。因为它的 I/O 是可序列化消息，同一 handle 契约既可承载进程内绑定（host-builtin 快路径，零序列化），也可承载远程绑定（经 agentlet），对上层无变化——进程内只是同一份可序列化契约的 transport 优化。

```ts
interface AgentHandle {
  // core — every driver implements this
  run(
    submission: AgentSubmission | null, // null = "no new input"; meaning is driver-defined
    ctx: TurnCtx, // per-turn overlay / abort signal / logger / live backing object
  ): AsyncGenerator<AgentStreamEvent, Message[]>; // yields the turn's events; returns its transcript delta
  control(msg: ControlMsg): Promise<ControlAck>; // control-plane, capability-gated; usable out-of-turn
  close(): void; // Deployment: teardown; Job: no-op
  readonly capabilities: AgentCapabilities; // runtime descriptor
}
interface Cancellable {
  cancel(): Promise<void>;
} // opt-in facets — a Job carries no
interface ModeSwitchable {
  setMode(id: string): Promise<void>;
} // NotImplemented stubs
interface ModelSelectable {
  setModel(id: string): Promise<void>;
}
// Behavioural capabilities add NO method: reverse permission is an injected
// onPermissionRequest port; slash commands arrive as availableCommandsUpdate in the run stream.
```

**I8.1 It is an anti-corruption wrapper over the ACP _client role_, not a re-export of the ACP SDK / 它是对 ACP _客户端角色_ 的防腐包装，而非 ACP SDK 的再导出.**
The interface is modelled on the ACP client role (a complete, well-worn duplex vocabulary), but Agenetes owns it and surfaces only the subset it needs. ACP is _one downward driver_, never the upward contract: `AcpAgentHandle` wraps the ACP SDK, `BuiltinAgentHandle` wraps the in-process harness, and both satisfy the same `AgentHandle`. Replacing ACP later never reaches the host application.

该接口以 ACP 客户端角色为原型（一套完整、久经考验的全双工词汇），但由 Agenetes 拥有，只暴露它需要的子集。ACP 只是*一个向下的 driver*，绝非面向上层的契约：`AcpAgentHandle` 包装 ACP SDK，`BuiltinAgentHandle` 包装进程内 harness，二者满足同一个 `AgentHandle`。日后替换 ACP，绝不波及 host application。

**I8.2 One `run` is the shared unit; data plane vs control plane stay logically distinct / 一次 `run` 是共享的单元；数据面与控制面在逻辑上仍不同.**
A single **run/turn** — `run(submission, ctx)` — is the unit both workload lifecycle types share. A **Job** _is_ exactly one run then terminal; a **Deployment** hosts many runs plus `control` / notifications / liveness. The driver resolves canonical inputs, performs exactly one backend turn, and yields content updates as `AgentStreamEvent`s. A run additionally returns a generator `TResult`, but Agenetes never reads it: the durable transcript is folded from yielded events (I9.8), so `TResult` remains driver-native or `void`. `run(null, ctx)` remains the driver-defined resume-without-input form. Host application→agent control remains the capability-gated `control(msg)` surface; agent→host application affordance updates remain run events.

一次**run/轮次**——`run(submission, ctx)`——是两种 workload 生命周期类型共享的单元。**Job** 恰好一次 run 后终止；**Deployment** 承载多次 run，并拥有 `control` / 通知 / 存活性。driver 解析 canonical inputs、执行恰好一个 backend turn，并把内容更新 yield 为 `AgentStreamEvent`。run 还会返回 generator `TResult`，但 Agenetes 从不读取它：持久 transcript 从 yielded events 折叠（I9.8），所以 `TResult` 可保持 driver-native 或 `void`。`run(null, ctx)` 仍是 driver 自行定义的无新输入 resume 形式。host application→agent control 仍走 capability-gated 的 `control(msg)`；agent→host application affordance updates 仍走 run events。

**I8.3 `WorkloadSpec.initialPreamble` carries portable data; the driver chooses the backend realization / `WorkloadSpec.initialPreamble` 只携带可移植数据；driver 选择 backend realization.**
`initialPreamble?: string[]` carries ordered host-authored instruction fragments in the serializable workload spec. The protocol does not assign a backend role, join strategy, or delivery point. A driver should prefer the harness-native instruction mechanism: the pi driver maps it to pi-agent-core's native `systemPrompt`, including later native `set_context` updates. A driver whose harness lacks such a channel may join the fragments and prefix the first ordinary backend input; ACP uses this fallback because one `session/prompt` always elicits a turn. Command-only input never consumes the pending prefix. A one-shot driver persists `AgentStateSnapshot.initialPreambleDelivered` after successful delivery and restores that field on native resume; `sessionId` alone never implies delivery.

`initialPreamble?: string[]` 在可序列化 workload spec 中携带 host 编写的有序 instruction fragments。protocol 不指定 backend role、拼接策略或 delivery point。driver 应优先使用 harness-native instruction机制：pi driver 把它映射到 pi-agent-core 原生 `systemPrompt`，后续动态更新继续使用 native `set_context`。若 harness 没有这种 channel，driver 可以 join fragments并前缀到第一条普通 backend input；ACP 因为每次 `session/prompt` 都必然触发一个 turn，所以采用这种 fallback。command-only input不消费 pending prefix。采用 one-shot delivery 的 driver 在成功后持久化 `AgentStateSnapshot.initialPreambleDelivered`，并在 native resume时恢复该字段；仅有 `sessionId` 绝不代表已经 delivered。

**I8.4 It is an in-process duplex peer — no sidecar / 它是进程内全双工对等体——没有 sidecar.**
Because the seam lives inside the host application process, host application→agent and agent→host application calls share one logical channel (JSON-RPC-style `id` correlation). A reverse call (permission request) is a **method the host application implements** — an injected `onPermissionRequest` port Agenetes awaits — not a second channel. The browser's SSE-down / POST-up split is the host application bridging this duplex onto a half-duplex wire; it is _not_ part of the host application↔Agenetes contract.

因为接缝在 host application 进程之内，host application→agent 与 agent→host application 的调用共用一条逻辑通道（类 JSON-RPC 的 `id` 关联）。反向调用（权限请求）是 **host application 实现的一个方法**——一个 Agenetes 去 await 的注入端口 `onPermissionRequest`——而非第二条通道。浏览器的 SSE 下行 / POST 上行拆分，是 host application 把这条全双工桥接到半双工线路上；它*不*属于 host application↔Agenetes 契约。

**I8.5 Messages, not closures — "data customizes, code extends" / 传消息，不传闭包——"数据做定制，代码做扩展".**
Handle I/O is serializable messages, never method calls carrying live objects or closures across the seam (a closure crossing is the welding smell). A control op is a message (`control({ type: 'set_mode', … })`). Injecting _new behaviour_ (a tool impl, a new harness) is a registration act (code, below the seam); a serializable spec only _parameterises_ pre-registered capabilities.

handle 的 I/O 是可序列化消息，绝不用携带活对象或闭包的方法调用跨越接缝（闭包跨越就是把两层焊死的坏味道）。控制操作是一条消息（`control({ type: 'set_mode', … })`）。注入*新行为*（一个工具实现、一个新 harness）是注册行为（代码，在接缝之下）；可序列化的 spec 只*参数化*已注册的能力。

**I8.6 Capabilities belong to the realized `AgentHandle` and describe the surface it actually honours / Capabilities 属于 realization 后的 `AgentHandle`，描述它实际兑现的 surface.**

`AgentHandle.capabilities` is a serializable runtime descriptor of one realized workload, not a routing input, driver-candidacy advertisement, or separate opt-in method-facet hierarchy. Its primary callable field, `AgentCapabilities.supportedControlMessages`, lists the exact subset of the closed `ControlMsg` vocabulary that `AgentHandle.control(...)` accepts; an operation outside that set resolves to `{ ok: false, code: 'unsupported' }`. Non-callable behavioural facts such as `turnInput` and `loadSession` remain explicit descriptor fields rather than pretending to be methods.

`AgentHandle.capabilities` 是某个 realization 后 workload 的可序列化 runtime descriptor，不是 routing input、driver candidacy advertisement，也不是另一套 opt-in method facet hierarchy。它的主要 callable 字段 `AgentCapabilities.supportedControlMessages` 精确列出 `AgentHandle.control(...)` 所接受的封闭 `ControlMsg` 词汇子集；集合之外的操作解析为 `{ ok: false, code: 'unsupported' }`。`turnInput`、`loadSession` 等不可调用的行为事实继续作为显式 descriptor fields，而不伪装成 methods。

Capabilities are determined while realizing the handle because they may depend on the complete `WorkloadSpec`, especially its lifecycle. The same registered pi driver, for example, realizes a Job handle supporting only `cancel`, but a Deployment handle supporting `cancel` and `set_context`; an ACP Deployment advertises its own larger control subset plus `loadSession`. A factory or driver may reuse constants or helper functions to construct these descriptors, but `AgentDriver` itself does not promise a candidate capability set: only the returned `AgentHandle` is authoritative.

Capabilities 在 realization handle 时确定，因为它们可能依赖完整的 `WorkloadSpec`，尤其是其中的 lifecycle。例如，同一个已注册 pi driver realization 出的 Job handle 只支持 `cancel`，而 Deployment handle 支持 `cancel` 与 `set_context`；ACP Deployment 则声明自己的更大 control 子集以及 `loadSession`。factory 或 driver 可以复用 constants 或 helper functions 来构造这些 descriptors，但 `AgentDriver` 本身不承诺 candidate capability set；只有返回的 `AgentHandle` 才是权威来源。

**Expected state.** An ACP driver knows the protocol-level capabilities it may expose, but the realized handle can determine its authoritative descriptor only after inspecting the concrete agent's `initialize` or session-bootstrap result. Two agents created through the same ACP driver may therefore expose different control operations or session features. (**Not aligned with the status quo:** `AcpAgentHandle` currently returns a fixed `ACP_CAPABILITIES` descriptor; the next implementation step is to derive and update `AgentHandle.capabilities` from the initialized ACP session.)

**预期状态。** ACP driver 知道协议层可能暴露的 capabilities，但 realization 后的 handle 只有检查具体 agent 的 `initialize` 或 session-bootstrap result，才能确定其权威 descriptor。因此，由同一个 ACP driver 创建的两个 agent 可能暴露不同的 control operations 或 session features。（**与当前实现尚未对齐：** `AcpAgentHandle` 当前仍返回固定的 `ACP_CAPABILITIES` descriptor；下一步实现工作是根据已初始化的 ACP session 派生并更新 `AgentHandle.capabilities`。）

### I9. The host addresses one mounted instance; the core surface stays minimal / 宿主面对一个被挂载的实例；核心表面保持最小

**I9.1 One mounted instance, like one cluster / 一个被挂载的实例，就像一个集群.**
The host talks to **one mounted Agenetes instance** — the way a user talks to _one_ Kubernetes cluster / API server, never to a kubelet or a container runtime directly — not to scattered driver internals. The instance owns the runtime, pre-mounts the standard (ACP) driver, and accepts host-injected **custom** drivers (business-coupled, host-owned) plus transport wiring.

宿主面对**一个被挂载的 Agenetes 实例**——就像用户面对*一个* Kubernetes 集群 / API server，绝不直接面对某个 kubelet 或容器运行时——而不是面对散落的 driver 内部件。该实例拥有 runtime、预挂载标准（ACP）driver，并接收宿主注入的 **custom** driver（与业务耦合、宿主拥有）以及传输接线。

**I9.2 The core surface stays narrow; upper-layer sugar is the upper layer's own / 核心表面保持狭窄；上层的语法糖归上层自己.**
The instance's surface stays deliberately narrow and identity-addressed: the host drives a workload through its **`AgentHandle`** (I8) — the one operational object it faces — obtained by `threadId` (I4.2), never touching the underlying `sessionId` (I4.3, the pod-level execution instance, an Agenetes-internal concept the host does not see); and whatever host→agent control the instance exposes ultimately delegates to that handle's `control(msg)` (I8.2, the shipped contract) — the closed vocabulary, capability gating, and `ControlAck` do not change by being reached through the instance. Equally deliberate is what the surface **excludes**: any convenience tied to the upper layer's own business flow or data is solved **by the upper layer itself**, never folded into Agenetes — the core does not care about, or model, that sugar.

实例的表面刻意保持**狭窄**且**按身份寻址**——宿主透过工作负载的 **`AgentHandle`**（I8，它面对的那个操作对象）来驱动，按 `threadId`（I4.2）取得它，而绝不触碰底层的 `sessionId`（I4.3，pod 级执行实例，一个宿主看不到的 Agenetes 内部概念）；实例对外暴露的任何 host→agent 控制，最终都委托给该 handle 的 `control(msg)`（I8.2，已落地的契约）——封闭词汇、能力门控、`ControlAck` 不因经由实例而改变。同样刻意的是这个表面**排除**什么：任何与上层自身业务流程或数据相关的便利/语法糖，都**由上层自己解决**，绝不塞进 Agenetes——核心既不关心、也不建模那些语法糖。

**I9.3 The runtime surface is exactly three methods / 运行期表面恰好三个方法.**

The instance is a **handle factory/registry addressed by `threadId`** (I9.1) — the host application obtains an `AgentHandle` and drives the workload _through that handle_ (I8). The runtime surface is exactly three methods:

实例是一个**按 `threadId` 寻址、发放 handle 的工厂/注册表**（I9.1）——host application 取得一个 `AgentHandle`，_透过该 handle_ 驱动工作负载（I8）。运行期表面恰好三个方法：

| Method                                     | Contract                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create(spec) → AgentHandle`               | Get-or-create by `spec.threadId`, dispatching on `spec.kind`. **Reuse-ignores-spec**: an existing live handle is returned as-is, no reconcile (changing a spec is an explicit `close()` + `create()` the caller decides). A **Deployment** enters the live registry; a one-shot **Job** gets a transient handle that never registers. |
| `get(threadId) → AgentHandle \| undefined` | Pure lookup — **never spawns**. A missing handle is a precondition failure (e.g. a control write on a dead thread), not a lazy spawn.                                                                                                                                                                                                 |
| `close(threadId)`                          | Tear the handle down and evict it from the registry.                                                                                                                                                                                                                                                                                  |

`run` / `control` / `capabilities` live on the **`AgentHandle`** (I8), not on the instance, so the host composes them:

`run` / `control` / `capabilities` 在 **`AgentHandle`**（I8）上，不在实例上，宿主据此组合：

```ts
// drive a turn
for await (const event of instance.create(spec).run(submission, ctx)) { … }
// issue a control op (never spawns)
await instance.get(threadId)?.control(msg);
// open a session with no turn — create and discard the handle
instance.create(spec);
```

`create` performs the `kind → driver` dispatch (`resolve(spec.kind).create(spec)`) internally. **Out of the instance:** `getMeta` / cached-meta (it mixes the host application's profile-schema-cache — cold-start UX is host application sugar, I9.2); the push stream itself is the `notifications()` surface (I9.7).

`create` 在内部完成 `kind → driver` 分发（`resolve(spec.kind).create(spec)`）。**不进实例：** `getMeta` / cached-meta（掺了 host application 的 profile-schema-cache——冷启动 UX 是 host application 语法糖，I9.2）；推送流本身即 `notifications()` 表面（I9.7）。

**I9.4 A query surface reads durable records, orthogonal to the runtime surface / 查询表面读取持久记录，与运行期表面正交.**

Alongside the imperative _runtime surface_ (I9.3, which owns _live_ handles) the instance exposes a distinct **query surface** over the **durable records** Agenetes owns, addressed by `namespace` / `threadId` (I4). It is deliberately orthogonal: it operates on persisted state, **independent of whether a handle is live** — so a control write does not lazily spawn a session (I9.3 `get`), and a persisted-record read does not require one either. The confirmed durable instance today is the framework's own `FileThreadStore`, which persists `(namespace, threadId) → record` as `<namespace.storage.root>/threads.json`, one file per namespace (I4.1); enumerating a namespace's persisted threads is a native query over this per-namespace **persistent thread table**. Each record is `{ spec, state }`, where `state` is a driver-agnostic **`AgentStateSnapshot { sessionId?, metadata? }`** (I9.7) — the opaque low-level driver `sessionId` (I4.3) plus a folded `AgentMetadata` snapshot (M5.5). A driver supplies a translator from its native meta, but the persistence itself is unified and driver-neutral. The surface stays host-agnostic like `run`'s `TResult`: it returns Agenetes-owned, driver-agnostic records, never a canvas-shaped projection — any host-shaped view (e.g. the chat transcript) is the host's own projection over what it reads (the folded `AgentTurn` history is likewise an Agenetes-owned record read through the I9.8 log surface, from which a host derives its own message-shaped `Context`). `create(spec)` upserts a record only when the workload has a durable thread identity: a Deployment always does (its `threadId` is also the live-table key), and so does a Job with a non-empty `threadId`; a **transient Job** — a stateless one-shot invoked with an empty `threadId` — writes no record, since an empty key would collide across every transient Job in the namespace and accumulate junk records nobody reads.

在命令式的*运行期表面*（I9.3，拥有*活* handle）之外，实例还暴露一个独立的**查询表面**，面向 Agenetes 所拥有的**持久记录**，按 `namespace` / `threadId`（I4）寻址。它刻意与运行期表面正交：它操作已持久化的状态，**与是否有活 handle 无关**——所以一次控制写不会惰性拉起 session（I9.3 的 `get`），一次持久记录读同样不需要活 session。今天已确认的持久实例是框架自带的 `FileThreadStore`，它把 `(namespace, threadId) → 记录` 持久化为 `<namespace.storage.root>/threads.json`、每个 namespace 一个文件（I4.1）；枚举某个 namespace 已持久化的 thread 就是在这张 per-namespace **持久 thread table** 上的一次原生查询。每条记录是 `{ spec, state }`，其中 `state` 是 driver-agnostic 的 **`AgentStateSnapshot { sessionId?, metadata? }`**（I9.7）——不透明的底层 driver `sessionId`（I4.3）加上一个折叠后的 `AgentMetadata` 快照（M5.5）。driver 只提供一个从其原生 meta 到该形状的翻译器，而持久化本身是统一且 driver 中立的。该表面像 `run` 的 `TResult` 一样保持宿主无关：它返回 Agenetes 拥有的、driver-agnostic 的记录，绝不返回 canvas 形状的投影——任何宿主形状的视图（例如聊天记录）都是宿主基于所读内容的自有投影。`create(spec)` 只有在工作负载具备持久 thread 身份时才 upsert 记录：Deployment 总是有（其 `threadId` 同时是活表的键），带非空 `threadId` 的 Job 也有；而**瞬时 Job**——以空 `threadId` 发起的无状态一次性调用——不写任何记录，因为空键会在同一 namespace 内的所有瞬时 Job 之间相互碰撞，堆积无人读取的垃圾记录。

**I9.5 Mounting assembles one statically wired Agenetes instance / Mounting 组装一个静态接线的 Agenetes instance.**

`mountAgenetes(options)` creates an `AgenetesBuilder` around instance-level configuration such as durable stores and the auto-recovery policy. The builder already contains the standard driver factories. During mounting, the host application may register standard drivers, append custom factories, and register drivers built from those factories; `AgenetesBuilder.build()` materializes that wiring and returns one `Agenetes` instance. The resulting instance is fixed: it exposes no dynamic factory-extension or driver-registration surface. Driver factory ownership and registration identity are defined by I2.1; typed-port customization is defined by I2.5.

`mountAgenetes(options)` 围绕 durable stores、auto-recovery policy 等 instance-level configuration 创建一个 `AgenetesBuilder`。builder 已包含 standard driver factories。mounting 期间，host application 可以注册 standard drivers、追加 custom factories，并注册由这些 factories 构造的 drivers；`AgenetesBuilder.build()` 物化这些 wiring，返回一个 `Agenetes` instance。生成的 instance 是固定的：它不暴露动态 factory extension 或 driver registration surface。driver factory ownership 与 registration identity 由 I2.1 定义；typed-port customization 由 I2.5 定义。

```ts
const agenetes = mountAgenetes({
  threadStore: new FileThreadStore(),
  eventLogStore: new FileEventLogStore(),
  turnStore: new FileTurnStore(),
  autoRecoverPolicy,
})
  // Standard factories are already present.
  .register('external', 'acp')
  .register('internal', 'pi', {
    ports: huabuPiDriverPorts,
  })
  // Host-provided factories use the same registration path.
  .addFactory('custom-harness', customHarnessDriverFactory)
  .register('specialized', 'custom-harness', customHarnessConfig)
  .build();
```

**I9.6 The `spec` / `submission` / `ctx` boundary / `spec`、`submission`、`ctx` 边界.**

A turn's inputs split across three layers by lifetime and ownership. Host rendering happens before this seam and its canonical result rides inside the submission (I6):

一次轮次的输入按生命周期与归属分为三层。host rendering 在这条接缝之前完成，其 canonical 结果搭乘 submission（I6）：

| Layer                                                       | Lifetime                                                                 | Carries                                                                                                                                                         |
| ----------------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`WorkloadSpec`** — _"which workload"_                     | baked by the host application at `create`; durable, serializable, opaque | `threadId` · `kind` · `binding {alias, profileId}` · `cwd` · `recipe` · `namespace {name, storage}` · `env` (I10) · portable `initialPreamble` fragments (I8.3) |
| **submission** — _"this turn's source and canonical input"_ | per `run`; persisted as the complete historical request                  | `{ type, content, rendered? }`, passed as `handle.run(submission, ctx)`'s first arg; `null` requests driver-defined resume behavior                             |
| **ctx** — _"this turn's host application injections"_       | per `run`; live and non-serializable                                     | `{ overlay, signal, onPrepared? }` — the abort, overlay, and debug hooks needed only while the turn executes                                                    |

The ACP handle **self-resolves its own live session per turn** (calling the in-package `ensureAcpSession`), but its _durable_ state rides the I9.7 channel, not the handle: it **rehydrates** `sessionId` / `metadata` from the down-fed `priorState` (never reading a store) and **up-reports** changes via `onState` (never writing one). So the `ctx` still carries neither the live session nor a persistence callback — the low-level session (I4.3) stays entirely below the instance, unseen by the host application. The spawn `recipe` is **not** part of this state channel: it rides the durable `WorkloadSpec`, baked by the host application, which owns keeping a returning thread's recipe stable — Agenetes forwards the spec's recipe verbatim and at most **warns** when it drifts from the persisted record.

ACP handle **每轮自解析自己的活 session**（调用包内的 `ensureAcpSession`），但其*持久*状态走 I9.7 的通道、不再挂在 handle 上：它从 down-fed 的 `priorState` **rehydrate** `sessionId` / `metadata`（绝不读 store），并经 `onState` **up-report** 变更（绝不写 store）。因此 `ctx` 仍既不携带活 session、也不携带持久化回调——底层 session（I4.3）完全留在实例之下，host application 看不到。spawn `recipe` **不**属于这条状态通道：它搭乘持久的 `WorkloadSpec`、由 host application 烘焙，host application 负责让回归 thread 的 recipe 保持稳定——Agenetes 原样转发 spec 的 recipe，至多在其与持久记录**漂移**时发一条 warning。

**I9.7 A notification surface pushes durable-state changes; the handle is the sole folder / 通知表面推送持久状态变更；handle 是唯一折叠点.**

The instance owns a **durable thread-state channel** around one `AgentStateSnapshot`, running in two directions. **Down-feed** (create-time, instance → handle): the instance walks the resolution ladder — live handle → durable `ThreadRecord` — and passes the prior snapshot to the driver as the optional second argument of `create(spec, priorState?)`; a handle _resumes_ from `priorState.sessionId`, _rehydrates_ from `priorState.metadata`, and independently restores `priorState.initialPreambleDelivered`, so it never reads a store to recover its own state. **Up-report** (out-of-turn, handle → instance) is the notification surface that follows.

在命令式的运行期表面（I9.3）与查询表面（I9.4）之外，实例围绕同一个 `AgentStateSnapshot` 拥有一条**持久 thread-state 通道**，双向运行。**Down-feed（create 时，实例 → handle）**：实例沿解析阶梯——live handle → 持久 `ThreadRecord`——把 prior 快照作为 `create(spec, priorState?)` 的可选第二参传给 driver；handle 据此从 `priorState.sessionId` _resume_、从 `priorState.metadata` _rehydrate_，并独立恢复 `priorState.initialPreambleDelivered`，因而绝不为恢复自身状态去读任何 store。**Up-report（turn 外，handle → instance）** 就是紧随其后的通知表面。

Beyond the imperative runtime surface (I9.3) and the query surface (I9.4), the instance exposes a **notification surface** — `notifications(threadId): AsyncIterable<AgentMetadata>` — the push stream reflecting an agent's observable control-plane state as it changes. It is the out-of-turn companion of the in-turn `*_update` frames that already ride a run's `AgentStreamEvent` stream (I8): the same selectable / usage surface, delivered whether or not a run is active. The flow has exactly one primitive and one derived read-side:

- **Up-report (primitive, handle → instance).** A handle folds its driver-native state into a single driver-agnostic **`AgentStateSnapshot { sessionId?, metadata?, initialPreambleDelivered? }`** and pushes the _whole current snapshot_ on every change — a **full snapshot, never a per-field delta**. `sessionId` is the opaque low-level driver resume token (I4.3); `metadata` is the folded `AgentMetadata` (M5.5); `initialPreambleDelivered` is an independent lifecycle fact and must never be inferred from `sessionId`. The handle is the **sole folder** and pushes via an internal emitter, so the instance registers **one listener per handle at `create`** — never a per-handle polling loop.
- **Persist-then-notify (instance).** The instance is the **sole writer** of the `ThreadStore`: on each up-report it replaces `record.state` wholesale, _then_ re-emits to the host application. The durable record is committed before any watcher sees the change, so a query-surface read after a notification always observes the latest state. The `ThreadStore` is thus **upstream** of `notifications()`, not a peer subscriber.
- **Read-side (instance → host application).** `notifications(threadId)` is an `AsyncIterable` view over the instance's per-thread stream carrying the driver-agnostic `metadata`; the host application consumes the part it needs (e.g. an SSE bridge repaints the mode / model / command selectors), and the opaque `sessionId` is simply never read by the host application. This channel **replaces the M3 `profileCachePort` stopgap** — the host application's profile-schema-cache becomes an ordinary subscriber, not a driver-injected sink.

There is exactly **one source of the durable snapshot** — the handle's fold — so in-turn meta never double-folds into the record: on an in-turn meta event the handle both _yields the raw frame to the run stream_ (the UI's live animation) and _pushes the folded snapshot up-report_ (persistence). The record and any cache read **solely** from `notifications()`, never from the run stream. The surface is a **Deployment** affordance (a long-lived session has out-of-turn state); a **Job** has no out-of-turn life, so its stream is empty.

在命令式的运行期表面（I9.3）与查询表面（I9.4）之外，实例还暴露一个**通知表面**——`notifications(threadId): AsyncIterable<AgentMetadata>`——推送 agent 可观察的控制平面状态随其变化的流。它是那些已经搭乘 run 的 `AgentStreamEvent` 流（I8）的 turn 内 `*_update` 帧的**turn 外**同伴：同一套可选/用量表面，无论是否有活跃 run 都能送达。该数据流恰好一个原语 + 一个派生读侧：

- **Up-report（原语，handle → instance）.** handle 把自己 driver 原生的 state 折叠成单一的、driver-agnostic 的 **`AgentStateSnapshot { sessionId?, metadata?, initialPreambleDelivered? }`**，每次变化都推送*当前完整快照*——**全量快照、绝非 per-field delta**。`sessionId` 是不透明的底层 driver 恢复令牌（I4.3）；`metadata` 是折叠后的 `AgentMetadata`（M5.5）；`initialPreambleDelivered` 是独立的生命周期事实，绝不能从 `sessionId` 推断。handle 是**唯一折叠点**、经内部 emitter 推送，因此实例在 `create` 时**每个 handle 注册一个 listener**——绝不为每个 handle 起一条轮询循环。
- **先落盘再通知（instance）.** 实例是 `ThreadStore` 的**唯一 writer**：每次 up-report 都整块替换 `record.state`，*然后*才向 host application 再广播。持久记录在任何 watcher 看到变更之前就已提交，因此在收到通知后读查询表面，总能观察到最新状态。故 `ThreadStore` 是 `notifications()` 的**上游**，而非平级订阅者。
- **读侧（instance → host application）.** `notifications(threadId)` 是实例 per-thread 流的一个 `AsyncIterable` 视图，携带 driver-agnostic 的 `metadata`；host application 只消费自己需要的部分（例如 SSE 桥重绘模式/模型/命令选择器），而不透明的 `sessionId` 根本不被 host application 读取。这条通道**取代 M3 的 `profileCachePort` stopgap**——host application 的 profile-schema-cache 变成一个普通订阅者，而非被 driver 注入的 sink。

持久快照**只有一个来源**——handle 的折叠——因此 turn 内 meta 绝不会二次折进记录：收到 turn 内 meta 事件时，handle 既*把原始帧 yield 到 run 流*（UI 的实时动画）、又*把折叠后的快照 up-report*（持久化）。记录与任何缓存**只**从 `notifications()` 读，绝不从 run 流读。该表面是 **Deployment** 的能力（长命 session 才有 turn 外状态）；**Job** 没有 turn 外生命，其流为空。

**I9.8 A two-tier conversation log; the host application reads it, Agenetes alone writes it / 两级会话日志；host application 只读，唯 Agenetes 写.**

Alongside the runtime (I9.3), query (I9.4) and notification (I9.7) surfaces, the instance owns the durable **conversation log** per `(namespace, threadId)` — so "an agent's history" is framework infrastructure every driver writes and the host application only _reads_. The log is **two-tier**, unifying what the host application historically solved with three redundant "in-flight turn survival" mechanisms (an in-memory event buffer, a rewrite-heavy draft sidecar, and the transport's own per-session replay store):

- **Tier 1 — the fine turn/event log (write-ahead / streaming).** Append-only, monotonically-sequenced internal records: `run(submission, ctx)` first appends a `turn_start` carrying the complete `AgentSubmission | null` in its legacy-named `request` field, then every yielded `AgentStreamEvent` is appended as it streams. Only event records enter the Agenetes-internal pub/sub for live subscribers; `turn_start` exists solely to establish the turn boundary and let read-time materialization recover the submission. Tier 1 is never rewritten, renamed or deleted, so it dissolves the fragile mutable draft slot and makes the live buffer durable.
- **Tier 2 — the folded turn log (compacted checkpoint).** Append-only `AgentTurn`s, one per completed run, produced when Agenetes **folds** a turn's Tier-1 event range (never the run's return value — I9.8). The fold is **Agenetes'**, invoked on `run()` return; **the host application never appends a turn** — the sole writer is this fold.

The two tiers are the WAL-plus-compaction pattern (LSM / Kafka log-plus-compacted-topic); the sequence number is the internal **fence** pinning a Tier-2 record to its Tier-1 range, so live-tail reconnect and crash-recovery are the same primitive. **All of this machinery — sequence numbers, pub/sub, fold, live-tail — is Agenetes-internal and never leaks to the host application.** The surface facing the host application is exactly:

- `Agenetes.logMetadata(namespace, threadId): { eventCount: number; turnCount: number }` — lightweight log metadata without loading either tier. Tier 1 derives `eventCount` from its monotonic record high-water mark (including internal `turn_start` records), while Tier 2 serves `turnCount` from store metadata cached after the first file scan; neither internal sequence numbers nor fences cross the surface.
- `history(namespace, threadId, { withTail? }): { turns: ObservedAgentTurn[] }` — without `withTail`, the folded Tier-2 history only; with `withTail`, Agenetes also reads the uncovered Tier-1 suffix and appends a read-time `{ ...AgentTurn, isIncomplete: true }` projection built from its `turn_start.request` and folded event prefix. The projection never writes either tier. This is a snapshot read, not a watch; `tail()` remains the independent live event surface.
- `tail(namespace, threadId): AsyncIterable<AgentStreamEvent>` — pure reconnect: replay the uncommitted Tier-1 tail (everything since the last fold) then follow live, taking **no** sequence argument. Serves "history already rendered, just resume the stream."

`AgentTurn` (in `@agenetes/protocol`) is the _folded_ twin of the _delta_ `AgentStreamEvent` — `{ request, transcript }`, the transcript a driver-agnostic folded form (**not** any one host application's message shape; a host application's own message array degrades to a host application projection it derives for its context assembly, as with `run`'s `TResult`, I9.4). The request comes from the Tier-1 `turn_start`; the transcript is fully derivable from the deltas a driver yields, so **Agenetes folds the Tier-1 event records** into Tier 2 with a single generic, driver-agnostic fold (`createTranscriptFolder`) and **never reads `AgentHandle.run(...)`'s return value**. A driver's `TResult` therefore stays **free** (ACP returns `void`; the built-in returns its native pi-ai messages; neither must equal `FoldedMessage[]`). This is the symmetric twin of how each driver already translates its backend's native stream (`session/update`) into `AgentStreamEvent`: once the deltas are on the shared vocabulary, the collapse into messages is generic and lives in Agenetes once. The fold carries each event's `data` **verbatim** (a shallow copy, never a strict schema parse) so host application extension fields ride through untouched — e.g. the built-in's `tool_call.data.internalToolName`, which the base schema does not declare but the host application reads back when rendering history. Any workload with a **durable `threadId`** is logged — a Deployment (its `threadId` is also the live-table key) or a **threaded Job**; only a **transient Job** (empty `threadId`) is unlogged, holding no durable transcript. Recovery and fork receive the same materialized source history, including its optional incomplete projection; drivers choose how to seed that history into their native context, while the projection itself is never appended to the target Tier-2 log.

在运行期（I9.3）、查询（I9.4）与通知（I9.7）表面之外，实例还按 `(namespace, threadId)` 拥有持久的**会话日志**——于是“一个 agent 的历史”成为框架基础设施：每个 driver 都写它，host application 只*读*。日志是**两级**的，统一了 host application 历史上用三套冗余的“在飞 turn 存活”机制（一个内存事件 buffer、一个频繁重写的草稿 sidecar、以及传输层自己的 per-session 重放 store）各自解决的同一问题：

- **Tier 1——细粒度 turn/event 日志（预写 / 流式）.** append-only、单调 seq 的内部 records：`run(submission, ctx)` 先在沿用旧命名的 `request` 字段中追加一条携带完整 `AgentSubmission | null` 的 `turn_start`，随后每 yield 一帧 `AgentStreamEvent` 就随流追加。只有 event records 会进入供实时订阅者使用的 Agenetes 内部 pub/sub；`turn_start` 只负责建立 turn boundary，并让读时 materialization 能恢复 submission。Tier 1 绝不重写、重命名或删除，因而溶解掉脆弱的可变草稿槽，并让实时 buffer 变得持久。
- **Tier 2——折叠 turn 日志（压实检查点）.** append-only 的 `AgentTurn`，每个完成的 run 一条，由 Agenetes 把该 turn 的 Tier-1 事件区间 **折叠**而成（绝不读取 run 的返回值——I9.8）。折叠归 **Agenetes**、在 `run()` return 时触发；**host application 永不 append turn**——唯一 writer 就是这次折叠。

两级即 WAL-加-压实模式（LSM / Kafka log-加-compacted-topic）；seq 是把 Tier-2 记录钉到其 Tier-1 区间的内部 **fence**，因此 live-tail 重连与崩溃恢复是同一个原语。**所有这些机制——seq、pub/sub、折叠、live-tail——都是 Agenetes 内部的，绝不泄漏给 host application。** 面向 host application 的表面恰好是：

- `Agenetes.logMetadata(namespace, threadId): { eventCount: number; turnCount: number }`——不加载任一 tier 即可读取轻量日志 metadata。Tier 1 从内部 record 的单调 high-water mark 推导 `eventCount`（包含内部 `turn_start`）；Tier 2 在首次文件扫描后通过 store metadata cache 提供 `turnCount`；内部 seq 与 fence 均不跨越该表面。
- `history(namespace, threadId, { withTail? }): { turns: ObservedAgentTurn[] }`——未置 `withTail` 时只返回折叠后的 Tier-2 历史；置位时，Agenetes 还读取未被覆盖的 Tier-1 后缀，根据 `turn_start.request` 与 folded event prefix 追加一条读时 `{ ...AgentTurn, isIncomplete: true }` projection。projection 不写任一 tier。这是 snapshot read，不是 watch；`tail()` 仍是独立的实时 event surface。
- `tail(namespace, threadId): AsyncIterable<AgentStreamEvent>`——纯重连：重放未提交的 Tier-1 尾巴（自上次折叠以来的一切）再跟直播，**不**接受 seq 参数。服务“历史已渲染、只想续流”。

`AgentTurn`（在 `@agenetes/protocol`）是 _delta_ 的 `AgentStreamEvent` 的 _折叠_ 孪生——`{ request, transcript }`，transcript 是 driver-agnostic 的折叠形态（**不是**任何单一 host application 的消息形状；某 host application 自己的消息数组降级为它为自身 context 组装派生的 host application 投影，正如 `run` 的 `TResult`，I9.4）。request 来自 Tier-1 `turn_start`；transcript 完全可从 driver yield 的 delta 推导，因此 **Agenetes 折叠的是 Tier-1 event records**——用一个泛型、driver-agnostic 的折叠器（`createTranscriptFolder`）collapse 成 Tier-2，并且**从不读取 `run()` 的返回值**。driver 的 `TResult` 因而保持**自由**（ACP 返回 `void`；内置返回其原生 pi-ai 消息；两者都无需等于 `FoldedMessage[]`）。这正是“每个 driver 已经在把后端原生流（`session/update`）翻译成 `AgentStreamEvent`”的对称孪生：一旦 delta 落在共享词汇上，把它们 collapse 成消息就是泛型的，在 Agenetes 里只写一份。折叠时逐条**原样**（浅拷贝，绝不做 strict schema parse）搬运每个事件的 `data`，使 host application 扩展字段无损透传——例如内置的 `tool_call.data.internalToolName`。任何带**持久 `threadId`** 的工作负载都会被记录——Deployment 或带 thread 的 Job；只有**瞬时 Job**（空 `threadId`）不被记录。recovery 与 fork 接收相同的 materialized source history，包括可选的 incomplete projection；driver 自行决定如何把该历史 seed 到其 native context，而 projection 本身永不 append 到 target Tier-2 log。

**I9.9 History with tail is a snapshot projection, not a watch / 带 tail 的 history 是 snapshot projection，而非 watch.**

`history(namespace, threadId, { withTail: true })` takes a call-time **snapshot**, projecting the uncovered Tier-1 `turn_start(request)` plus its event prefix into one final `ObservedAgentTurn { isIncomplete: true }`. It is not a watch or event pipe; continuous raw events remain the separate `tail()` surface (I9.8).

`history(namespace, threadId, { withTail: true })` 获取调用时刻的 **snapshot**，把未被覆盖的 Tier-1 `turn_start(request)` 与其 event prefix 投影成最后一条 `ObservedAgentTurn { isIncomplete: true }`。它不是 watch 或 event pipe；持续的 raw events 仍由独立的 `tail()` surface 提供（I9.8）。

### I10. Agenetes handles the spec by contract only — no upper-layer semantics / Agenetes 只按约定处理 spec——不做上层语义操作

Agenetes acts on each `WorkloadSpec` field solely as the contract mechanically prescribes — dispatch on `kind` (I5), identity and lifecycle by `threadId` (I4), the store scope resolved from `namespace` (M5.0) — and treats everything else as opaque data passed through verbatim: it never adds host or business semantics, and never derives anything from a host helper.

Agenetes 对 `WorkloadSpec` 的每个字段只按契约机械地处理——按 `kind` 分发（I5）、按 `threadId` 定身份与生命周期（I4）、存储作用域从 `namespace` 解析（M5.0）——其余一律当作不透明数据原样透传：它绝不注入宿主或业务语义，也绝不从宿主 helper 推导任何东西。

The sharpest case is `env`: everything host-specific a workload needs at spawn — including any agent reachback env the host arranges (e.g. a host callback URL + thread id) — is assembled in full by the host and carried as opaque `spec.env`. Agenetes passes it straight through to the spawn call: it does not merge, add, or interpret any entry, and never composes a host URL or reads a host port. What the reachback env points at, and how the agent uses it, is entirely a host concern Agenetes never sees. Likewise the binding `recipe` is persisted and forwarded verbatim (an opaque spawn blob), and the on-disk store location is derived only from `spec.namespace`, never from a host path helper.

最锋利的例子是 `env`：一个工作负载在 spawn 时所需的一切宿主相关内容——包括宿主安排的任何 agent 回连 env（例如宿主回调 URL + thread id）——都由宿主完整拼装好，作为不透明的 `spec.env` 搭载。Agenetes 把它原样传给 spawn 调用：不合并、不添加、不解释任何条目，也从不拼装宿主 URL 或读取宿主端口。回连 env 指向什么、agent 如何使用它，完全是宿主的关注点，Agenetes 从不接触。同理，binding `recipe` 被原样持久化与转发（一个不透明的 spawn blob），磁盘存储位置也仅由 `spec.namespace` 推出，绝不借助宿主路径 helper。

## Packages

```
external/agenetes/packages/
  @agenetes/protocol       [BASE · contracts]        deps: zod, acp-sdk
  @agenetes/runtime        [BASE · empty framework]  deps: protocol
  @agenetes/agent-team     [CONTROL · durable]       deps: @agentlet/protocol
  @agenetes/agentlet-gateway [TRANSPORT · stateless] deps: @agentlet/protocol, ws
  @agenetes/agentlet-host  [TRANSPORT · ACP-private] deps: protocol, agentlet-gateway, fastify
  @agenetes/acp-driver     [DRIVER · standard]       deps: protocol, runtime, agentlet-host
  @agenetes/agenetes       [INSTANCE · assembly]     deps: protocol, runtime, acp-driver, agentlet-host
```

- **`@agenetes/protocol`** — the host application↔Agenetes data/control contracts: `WorkloadSpec` building blocks (`defineBinding` / `composeWorkloadSpec`), `AgentSubmission` and canonical `AgentInput`, `AgentStreamEvent`, `AgentTurn` (`{ request, transcript }`, where the historical field name `request` now carries the complete submission), `ControlMsg` / `ControlAck`, `AgentCapabilities`, `AgentMetadata`, `AgentStateSnapshot` (`{ sessionId?, metadata?, initialPreambleDelivered? }`), `Namespace`, and the branded `threadId` / `sessionId` ids. Host-agnostic (zod + ACP SDK only).
- **`@agenetes/runtime`** — the driver registry + live-handle lifecycle owner (the `AgentRuntime`): `register` / `resolve` a driver by kind, and `get` / `create` / `close` a long-lived handle by `threadId`. Depends only on `@agenetes/protocol`.
- **`@agenetes/agent-team`** — the host-agnostic Agent Team control plane: owns collection-root, member, and deployment identities; discovery provenance reconciliation and missing-member retention; member-level non-secret Config persistence; secret-redacted Config views and runtime resolution through an injected managed-secret port; and schema-versioned atomic registry persistence below a host-provided local storage directory.
- **`@agenetes/agentlet-gateway`** — the durably stateless host-side relay: authenticates daemon/session WebSockets, routes control RPCs and ACP traffic, and owns bounded live reconnect/pre-attach buffers without durable session or event stores.
- **`@agenetes/agentlet-host`** — the ACP transport host: mounts the Agentlet Gateway and supervises the local agentlet daemon. ACP-private (not shared base).
- **`@agenetes/acp-driver`** — the standard ACP driver and all its ACP-specific session state/logic: the handle, the client, the `session/update → AgentStreamEvent` translator, the in-memory session registry, the `ensureAcpSession` orchestration, and the ACP session-meta handling. It keeps no on-disk store: the handle rehydrates from the down-fed `priorState` and up-reports via `onState` (I9.7), so durable persistence lives entirely behind the instance's `ThreadStore`.
- **`@agenetes/agenetes`** — the top **assembly** package: elevates `mountAgenetes`, constructs the runtime, pre-mounts the standard ACP driver, accepts the injected custom driver factory + instance-level `logger` + transport wiring, and returns the `Agenetes` instance (`create` / `get` / `close`). The only package the host application imports at the composition root. _(Surface defined in I9.3–I9.6.)_
