# Agentlet

Agentlet is an execution-plane daemon that makes local stdio-based ACP agents available to a remote control plane over outbound WebSocket connections.

It contains no AI or host-application logic. The daemon accepts authenticated control messages, launches ACP-compatible processes, performs ACP session bootstrap locally, and relays protocol messages between each process and the remote Gateway.

## Responsibilities

- Register one execution machine through an `agentlet/hello` control connection.
- Accept `server/spawn`, `server/stop`, `server/list`, `server/discoverHarnesses`, `server/sendResource`, and shutdown control messages.
- Launch and supervise multiple ACP agent processes.
- Bootstrap each process with `initialize` followed by `session/new`, `session/resume`, or `session/load`.
- Register each bootstrapped session through its own `agent/hello` WebSocket connection.
- Relay ACP JSON-RPC messages without interpreting application semantics.
- Reconnect the machine control channel with bounded exponential backoff.
- Buffer the bounded pre-attach notification window until a new session relay is ready.
- Discover installed ACP harnesses from the daemon's trusted static catalogue, optionally preparing reusable local workspaces.

Agentlet does not provide a standalone relay server, REST API, browser UI, token administration service, or durable session/event store. Those control-plane responsibilities belong to the embedding host and its Gateway.

## Packages

| Package | Responsibility |
| --- | --- |
| `agentlet` | Daemon CLI, ACP process lifecycle, WebSocket client, relay, logging, and generic harness discovery. |
| `@agentlet/protocol` | Shared daemon/Gateway JSON-RPC types and method constants. |

## Build and test

Requirements:

- Node.js 20 or newer
- pnpm 9 or newer

```bash
pnpm install
pnpm build
pnpm test
```

## Run the daemon

The remote host supplies the Gateway WebSocket URL and authentication token:

```bash
agentlet daemon \
  --server "wss://host.example/api/bridge"
```

For local development only, `ws://` can be enabled explicitly:

```bash
agentlet daemon \
  --server "ws://127.0.0.1:3001/api/bridge" \
  --allow-insecure
```

Important options:

| Option | Meaning |
| --- | --- |
| `--agentlet-id <id>` | Exact execution-node identity override; the default is the persistent UUID in `~/.agentlet/device.json`. |
| `--max-agents <count>` | Maximum number of concurrently managed agent processes. |
| `--buffer-limit <count>` | Buffer capacity advertised in daemon and session profiles. |
| `--reconnect-max <seconds>` | Maximum exponential reconnect delay in positive whole seconds; defaults to 30. |
| `--heartbeat <seconds>` | WebSocket ping interval; `0` disables heartbeats. |
| `--log-level <level>` | `debug`, `info`, `warn`, or `error`. |
| `--log-file <path>` | Optional JSON-lines log destination. |
| `--env-inject <KEY=VALUE>` | Repeatable non-secret, opaque bootstrap value forwarded to every spawned agent. |

Set `AGENTLET_TOKEN` in the daemon's environment before running these examples. The generic `--token` option remains available, but environment credentials avoid putting the token in process arguments. A rejected control handshake exits nonzero; an ordinary shutdown exits zero.

The control and session connections use the same `agentletId`. Each spawned ACP session has its own `sessionId` and WebSocket, so control-channel and session-channel failures remain independent. The machine control channel reconnects automatically; a closed session channel stops that session's relay and is not automatically reconnected.

A `server/shutdown` notification with reason `server_shutting_down` means the host is stopping, not that the user wants the daemon to exit. The daemon stops old managed agents and pending launches, stays alive, and reconnects with the same device identity and credentials after delays of 1, 2, 4, 8, 16, then 30 seconds by default. Attempts continue while the daemon runs; a successful handshake resets the delay. This restores device availability, not running tasks or session relays. Other shutdown reasons and user signals still stop the daemon. A rejected control handshake or HTTP 401/403 upgrade exits nonzero with actionable connection guidance rather than retrying rejected credentials indefinitely.

Stopping waits for owned process-tree cleanup before releasing capacity or reconnecting, not merely for the shell to exit. POSIX signals the dedicated process group; Windows awaits tree-wide `taskkill`. Descendants that deliberately create a separate POSIX session are outside that group.

Failed bootstrap cleanup retains its capacity reservation and is retried after one second. Idle cleanup failure keeps the agent tracked for an explicit stop retry. Shutdown attempts all pending and managed cleanups concurrently and waits for every result before exiting, reporting failure if any tree could not be stopped.

## Harness discovery

The daemon advertises `capabilities.harnessDiscovery: { version: 2 }`. Gateways may call `server/discoverHarnesses` with `{}` for read-only discovery or `{ "prepareWorkspaces": true }` for automatic provisioning. The response includes every registered Definition with static identity, boolean capabilities, `ready`, `adapter-missing`, or `not-found` status, optional version, workspace, and diagnostics. No remote candidates, commands, IDs, or roots are accepted.

Windows discovery scans all `where.exe` results and accepts absolute `.exe`, `.com`, `.cmd`, and `.bat` candidates, so an extensionless POSIX npm shim does not hide a later shell-resolvable wrapper. Unix discovery requires an absolute `which` result. Version probing uses the Windows command shell for wrappers and shell-free invocation on Unix. Discovery models the target platform shell but does not promise interactive aliases or startup-script behavior.

Discovery uses bounded, shell-free PATH and optional version probes. It does not start ACP sessions, install packages, provision credentials, or copy prompts or skills. An optional version-probe failure does not change a successfully detected executable into a missing binary.

Only explicit workspace preparation creates `~/.agentlet/workspace/<definition-id>` on the daemon machine, and only for ready known harnesses. Existing contents are retained. Failed creation produces a diagnostic without a fallback directory. Agent Team runtime packages, setup commands, and Team RPCs are retired; manifests remain historical data only.

## Protocol lifecycle

### Typed harness launch

The daemon advertises `capabilities.harnessLaunch: { version: 2 }` independently of discovery. A host must gate structured spawning on that capability. `sessionSpec` accepts exactly one of the legacy trusted `command` string or `launch: { kind: 'acp-harness', harnessId, options?: { autoApprove?: boolean } }`. The structured path validates the daemon's own registry, rejects unknown options and unsupported approval presets, and compiles trusted fixed tokens plus bounded options into a terminal-style shell command. The legacy command path remains explicit user-authorized shell input. Editable display metadata never chooses a command.

Every Profile selects a Definition from its launch identity alone: `acp-harness` selects `harnessId`, and legacy `acp-command` selects the special `custom` Definition. Metadata and command text never infer a known harness, and old records are not converted. Each Definition implements `discover()` and `compile()`. Custom reports ready for manual selection, never probes executables or prepares a workspace, and hosts exclude it from automatic provisioning.

`@agentlet/protocol` exports `CUSTOM_COMMAND_WRAPPER_ID = 'custom'` and the frozen `CUSTOM_COMMAND_CAPABILITIES` object as canonical constants. Hosts may reuse these when projecting the manual Custom descriptor without duplicating capability policy.

Definition capabilities are the booleans `autoApprove` and `customLaunchCommand`. Custom supports only `customLaunchCommand`; known Definitions reject custom command overrides. `compile()` returns `{ kind: 'shell', command }`. A known harness's optional model intent remains `initialPreferences.model` for existing ACP controls, never a launch option or guessed CLI argument.

Compilation occurs inside `server/spawn`; there is no preview RPC. Known commands are generated only from trusted Definition tokens and bounded options, while Custom commands remain user-authorized shell code. Historical `launchPlan` input is schema-validated then ignored, and spawn does not return a new plan. Runtime and recovery therefore compile the frozen launch intent with the target Agentlet's current Definition.

```text
agentlet daemon
  -> connect control WebSocket
  -> agentlet/hello
  <- server/spawn
  -> launch ACP process
  -> initialize
  -> session/new | session/resume | session/load
  -> connect session WebSocket
  -> agent/hello
  <-> transparent ACP relay
```

The daemon always initiates outbound connections. Authentication uses the host-provided token, and the remote Gateway decides whether the reported identity may connect.

The complete daemon/Gateway wire behavior is documented in [`spec/protocol.md`](spec/protocol.md). The Agent Reachback resource-distribution contract is documented in [`spec/agent-reachback.md`](spec/agent-reachback.md).

## Agent Reachback

The host may push scripts or other resources through `server/sendResource`. The daemon interpolates destinations against its explicit bootstrap map, writes the resource locally, and injects that map into spawned processes. It does not provision a default reachback directory or infer bootstrap values from its ambient environment.

```bash
agentlet daemon --server "wss://host.example/api/bridge" \
  --env-inject TOOL_ENTRY="/device/tools/entry.js" \
  --env-inject AGENTLET_REACHBACK_DIR="/device/resources"
```

The bootstrap map defaults to empty. The equivalent programmatic option is `bootstrapEnv`. Values are copied and frozen at construction, split at the first `=` by the CLI, and remain opaque: spaces, empty values, additional equals signs, and relative paths are preserved without expansion or path resolution. Keys must match `[A-Za-z_][A-Za-z0-9_]*`; NUL, duplicate keys, and `AGENTLET_TOKEN` declarations are rejected without printing values. Do not pass credentials through `--env-inject`, because arguments are visible to other processes.

Bootstrap overrides inherited values. A session that declares any bootstrap key or `AGENTLET_TOKEN` is rejected before process launch, even if its value is identical. Windows matching is case-insensitive and the final child environment removes inherited case variants; Unix matching is case-sensitive. Ordinary session values, including `AGENTLET_SERVER`, retain their override behavior. This protects launch configuration, not the executing agent's ability to change its own environment.

Hosts previously relying on automatic `AGENTLET_REACHBACK_DIR` must supply it explicitly; ambient values are no longer an interpolation registry and no path is automatically resolved.

The standard environment includes:

| Variable | Purpose |
| --- | --- |
| `AGENTLET_REACHBACK_DIR` | Optional host-defined bootstrap value, with no built-in default or path interpretation. |
| `AGENTLET_SERVER` | Gateway URL supplied to the daemon. |
| `AGENTLET_TOKEN` | Authentication token available to host-provided reachback tools. |

Agentlet transports opaque resources and environment values; it does not interpret the host-specific tool protocol.

Host-specific Service clients and SDKs are not shipped or automatically configured by Agentlet. Hosts provide their own entry coordinates through generic bootstrap.

## Repository layout

```text
packages/
  protocol/    # Shared daemon/Gateway wire contract
  local/       # agentlet CLI and execution daemon
spec/
  protocol.md
  agent-reachback.md
  agent-team.md # Historical manifest data reference, not a runtime contract
```
