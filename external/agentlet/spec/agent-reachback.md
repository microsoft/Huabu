# Agent Reachback Interface

> The **fundamental, host-agnostic** layer of Agent Reachback: how the agentlet
> daemon distributes tool scripts to spawned agents and provisions the
> environment they need to reach back into their host application.
>
> For the wire-level control message that carries the distribution, see
> [`protocol.md` §9 — Resource Distribution](protocol.md#resource-distribution).
> For a concrete host implementation, see Huabu's
> [`docs/architecture/agent-reachback.md`](../../../docs/architecture/agent-reachback.md).

## 1. Concept

The **primary channel** between a host application and an external agent is the
ACP prompt→response flow relayed by agentlet: the host sends prompts, the agent
streams back messages.

**Agent Reachback** is a parallel, out-of-band channel: a spawned external agent
_reaches back_ into the host application that launched it to read and write
shared state (documents, a canvas, a workspace, …) independently of that
sequential prompt flow. The name is literal — the agent reaches back to its
host — and deliberately carries no networking connotation.

Reachback is **layered**, and the two layers have a clean separation of concerns:

| Layer                              | Owner                        | Responsibility                                                                                                                                              |
| ---------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Reachback Interface** (this doc) | **agentlet** (host-agnostic) | Transport & distribution: push tool scripts into each spawned agent's environment and inject the env vars they need. Knows nothing about what the tools do. |
| **Reachback Tool**                 | **host app** (e.g. Huabu)    | Provides the concrete tool script(s) and the server-side endpoints they call. Knows nothing about how the scripts were delivered.                           |

agentlet never parses, validates, or understands a tool's contents — it only
transports an opaque script to a well-known location and makes that location
discoverable to spawned agents. This keeps the daemon generic: any host app can
ship any Reachback tool without changing agentlet.

```mermaid
flowchart LR
    subgraph host_side["Host Side"]
        HostApp["Host Application<br/>(provides tool script<br/>+ server endpoints)"]
    end

    subgraph relay["Relay"]
        Server["Agentlet Gateway"]
    end

    subgraph agent_side["Agent Side"]
        Daemon["agentlet daemon<br/>(Reachback Interface)"]
        Tool["Reachback Tool<br/>(host-provided script)"]
        Agent["External Agent<br/>(spawned process)"]
    end

    HostApp -->|"1 server/sendResource<br/>(on connect)"| Server
    Server -->|"2 push over control WS"| Daemon
    Daemon -->|"3 save to ${AGENTLET_REACHBACK_DIR}"| Tool
    Daemon -->|"4 inject env into spawn"| Agent
    Agent -->|"5 invoke"| Tool
    Tool -->|"6 call back (auth: AGENTLET_TOKEN)"| HostApp
```

## 2. Environment Provisioning

The daemon accepts repeatable `--env-inject KEY=VALUE` or an equivalent programmatic `bootstrapEnv` map. Bootstrap defaults to empty, is copied and frozen at construction, and is forwarded unchanged to every spawn and restart. Values are opaque: the CLI splits only at the first equals sign and does not trim, expand, or resolve them. Portable environment keys are required; NUL, duplicates, and bootstrap declarations of daemon-owned `AGENTLET_SERVER` or `AGENTLET_TOKEN` fail without exposing values.

The final child environment combines ordinary inherited values and session overrides with authoritative bootstrap and daemon connection options. Any session declaration of a bootstrap key or a key in `DAEMON_ENV_KEYS` (`AGENTLET_SERVER`, `AGENTLET_TOKEN`) fails before spawning, including equal values. Historical host launch snapshots must discard these declarations. The current daemon supplies both its connection address and credential at the final merge. Windows matching is case-insensitive and removes inherited case variants; Unix is case-sensitive. Bootstrap does not change the daemon's own environment or sandbox running agents.

| Variable                        | Provided by                         | Description                                                                                                                                                                                                                                               |
| ------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENTLET_REACHBACK_DIR`        | explicit host bootstrap, if desired | Opaque host-defined location with no default, automatic path resolution, or ambient registry lookup.                                                                                                                                                      |
| `AGENTLET_SERVER`               | daemon `--server`                   | The daemon's current control-channel WebSocket URL (e.g. `ws://127.0.0.1:3001/api/bridge`), not overridable by a session or bootstrap. Tools may derive an HTTP base URL (`ws://`→`http://`, strip path); host-specific endpoints use separate variables. |
| `AGENTLET_TOKEN`                | daemon `--token`                    | Bearer token the tool attaches to every call back to the host. May double as user/session identity for per-token access scoping.                                                                                                                          |
| _host-specific bootstrap_       | `--env-inject` or `bootstrapEnv`    | Host-owned non-secret tool coordinates available to all spawned agents and resource interpolation.                                                                                                                                                        |
| _host-specific session context_ | `sessionSpec.env`                   | Workload context that may override ordinary inherited values, but cannot declare a bootstrap or daemon-owned key.                                                                                                                                         |

Explicit bootstrap is the only source of `${ENV_VAR}` interpolation in resource destinations (§3). Empty values are valid; missing keys, including inherited keys and object prototype names, produce a non-fatal `resource_save_failed` diagnostic. Hosts that used the former implicit reachback directory must now provide it explicitly. Agentlet supplies no host-specific SDK or SDK location; these belong to host bootstrap.

## 3. Tool Distribution

Tool scripts are delivered over the **already-authenticated agentlet control
WebSocket** using the protocol's `server/sendResource` notification — no
separate HTTP endpoint, no public download, no extra auth.

### When

The host app pushes its Reachback tool(s) through the Gateway **when the agentlet daemon connects**, and **re-pushes on reconnection** (the daemon's cache directory may have been cleared while it was suspended). Because delivery is idempotent — a plain overwrite at a fixed path — re-pushing is always safe and also keeps the script version in lock-step with the running host.

### How

`server/sendResource { destination, content }` is sent on the control channel.
The `destination` supports `${ENV_VAR}` interpolation against the daemon's
explicit bootstrap map, so the host references its configured dir without knowing its
absolute path on the remote machine:

```jsonc
// Server → Agentlet (control channel)
{
  "jsonrpc": "2.0",
  "method": "server/sendResource",
  "params": {
    "destination": "${AGENTLET_REACHBACK_DIR}/my-reachback-tool.mjs",
    "content": "#!/usr/bin/env node\n…",
  },
}
```

For this example, launch the daemon with `--env-inject AGENTLET_REACHBACK_DIR=/absolute/resource/path`. The daemon does not create or resolve a default directory.

The daemon resolves the destination, creates parent directories as needed,
writes the file, and logs `resource_saved`. An unknown `${ENV_VAR}` is rejected;
a write failure is logged as `resource_save_failed` (non-fatal). See
[`protocol.md` §9](protocol.md#resource-distribution) for the full wire
contract.

### Discovery

Because the script lands in `${AGENTLET_REACHBACK_DIR}` and that same variable
is injected into every spawned agent, the agent can invoke the tool by an
env-relative path without any per-host configuration:

```bash
node "${AGENTLET_REACHBACK_DIR}/<tool-script>" <command> [args...]
```

`server/sendResource` is **general-purpose** — it can place any
`${ENV_VAR}/filename` resource, not just Reachback tools — but Reachback is its
primary use today.

## 4. Transport Model (CLI-first)

The Reachback Interface supports optional CLI resource distribution without requiring it. A host may also expose language-independent HTTP access and let the agent choose its own client/runtime. Providing a script does not guarantee that the agent has the runtime required to execute it. The following comparison explains why a host might choose a CLI rather than an MCP server:

| Consideration | MCP                             | CLI script (Reachback)               |
| ------------- | ------------------------------- | ------------------------------------ |
| Setup         | Zero-install, JSON config       | Requires distribution — solved by §3 |
| Sync/Async    | Sync only (blocking tool calls) | Both sync & async, streaming         |
| Flexibility   | Fixed request/response          | Rich interaction patterns            |
| Agent support | Widely supported                | Universally supported (any shell)    |

The interface only mandates the _delivery + environment_ contract. The script's
commands, output conventions, and the server API it calls are entirely up to the
host app. Two transport properties are, however, recommended for any compliant
tool so that agent harnesses behave well:

- **Blocking, `curl`-like calls.** A command runs to completion, prints a
  machine-consumable result to stdout, diagnostics to stderr, and exits
  non-zero on failure. Harnesses already promote a slow command to a background
  task and collect its output later, so the tool needs no explicit async mode.
- **Streaming for long operations.** For potentially long calls (e.g. invoking
  another agent), stream incrementally (e.g. SSE) and emit an early stderr
  status line. Continuous output keeps both the HTTP connection and the harness
  alive, eliminating the timeout→retry→duplicate-execution problem without
  request-level idempotency.

## 5. Host Contract

To expose Reachback, a host application must:

1. **Provide a tool script** that authenticates with `AGENTLET_TOKEN`, resolves
   its server base URL from `AGENTLET_SERVER` (or a host-specific override), and
   exposes whatever commands its agents need.
2. **Configure a non-secret location explicitly** through `--env-inject` or `bootstrapEnv`, then optionally push the script on connect/reconnect via `server/sendResource` to `${AGENTLET_REACHBACK_DIR}/<tool-script>`.
3. **Serve the endpoints** the script calls, accepting `Authorization: Bearer
${AGENTLET_TOKEN}`.
4. **(Recommended) Inject usage into the agent's system prompt** at spawn time
   so the agent can use Reachback immediately, with no discovery round-trip.
5. **(Optional) Pass host context** to spawned agents via `sessionSpec.env`
   (e.g. a workspace ID the tool reads automatically).

agentlet provides items needed to make 1–5 work — distribution, the
`AGENTLET_*` environment, and `sessionSpec.env` forwarding — but never the tool
itself.

## 6. Type & Protocol References

| Concern                                           | Source                                                                                          |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `server/sendResource` params                      | [`SendResourceParams`](../packages/protocol/src/messages.ts)                                    |
| Wire contract & timing                            | [`protocol.md` §9 — Resource Distribution](protocol.md#resource-distribution)                   |
| Bootstrap validation, final merge & interpolation | [`packages/local/src/bootstrap-env.ts`](../packages/local/src/bootstrap-env.ts)                 |
| Spawn and resource transport                      | [`packages/local/src/agentlet.ts`](../packages/local/src/agentlet.ts)                           |
| Host integration (connection callbacks)           | Embedding Gateway implementation                                                                |
| Concrete host implementation                      | [Huabu — `docs/architecture/agent-reachback.md`](../../../docs/architecture/agent-reachback.md) |
