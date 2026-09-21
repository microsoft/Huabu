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
  --server "wss://host.example/api/bridge" \
  --token "$AGENTLET_TOKEN"
```

For local development only, `ws://` can be enabled explicitly:

```bash
agentlet daemon \
  --server "ws://127.0.0.1:3001/api/bridge" \
  --token "development-token" \
  --allow-insecure
```

Important options:

| Option | Meaning |
| --- | --- |
| `--agentlet-id <id>` | Stable execution-node identity; defaults to the machine hostname. |
| `--max-agents <count>` | Maximum number of concurrently managed agent processes. |
| `--buffer-limit <count>` | Buffer capacity advertised in daemon and session profiles. |
| `--reconnect-max <seconds>` | Maximum exponential reconnect delay. |
| `--heartbeat <seconds>` | WebSocket ping interval; `0` disables heartbeats. |
| `--log-level <level>` | `debug`, `info`, `warn`, or `error`. |
| `--log-file <path>` | Optional JSON-lines log destination. |

The control and session connections use the same `agentletId`. Each spawned ACP session has its own `sessionId` and WebSocket, so control-channel and session-channel failures remain independent. The machine control channel reconnects automatically; a closed session channel stops that session's relay and is not automatically reconnected.

## Harness discovery

The daemon advertises `capabilities.harnessDiscovery: { version: 1 }`. Gateways may call `server/discoverHarnesses` with `{}` for read-only discovery or `{ "prepareWorkspaces": true }` for automatic provisioning. The response includes every static catalogue entry, installation state, resolved executable path, optional version, and diagnostics. No remote candidates, commands, IDs, or roots are accepted.

Detected catalogue entries include `launchVersion: 1` as the explicit opt-in for hosts provisioning structured Profiles or presenting the structured editor only when the located executable supports shell-free launch. Windows opts in native `.exe`/`.com` executables, not npm `.cmd`/`.bat` shims or other script wrappers; shim entries remain installed and retain their legacy command recipe. Missing binaries and older daemon responses omit the field as well. This discovery hint does not replace the Gateway's independent handshake capability check at spawn.

Discovery uses bounded, shell-free PATH and optional version probes. It does not start ACP sessions, install packages, provision credentials, or copy prompts or skills. An optional version-probe failure does not change a successfully detected executable into a missing binary.

Only explicit workspace preparation creates `~/.agentlet/workspace/<catalogue-id>` on the daemon machine, and only for installed binaries. Existing contents are retained. Failed creation produces a diagnostic without a fallback directory. Agent Team runtime packages, setup commands, and Team RPCs are retired; manifests remain historical data only.

## Protocol lifecycle

### Typed harness launch

The daemon advertises `capabilities.harnessLaunch: { version: 1 }` independently of discovery. A host must gate structured spawning on that capability. `sessionSpec` accepts exactly one of the legacy trusted `command` string or `launch: { kind: 'acp-harness', harnessId, options?: { autoApprove?: boolean } }`. The structured path validates the daemon's own catalogue, rejects unknown options and unsupported approval presets, and spawns executable/argv without a shell. The legacy command path is unchanged. Editable display metadata never chooses an executable.

`Harness.get(id).describeCapabilities()` reports `supported`, `unsupported`, or `unknown` for `autoApprove`, `modelOverride`, and `sessionPersistence`, scoped specifically to the ACP entry. Discovery includes these as an optional `capabilities` field; older daemons may omit it. `Harness.buildLaunch()` returns executable, argv, and catalogue-owned environment. An optional model intent becomes `initialPreferences.model` for standard ACP controls, never a guessed CLI argument. Model override and session-persistence control remain unknown until verified; native print transports and adapter no-save flags are not inferred.

A successful structured spawn returns `launchPlan: { version: 1, executable, argv, env }`. A host can persist and send that plan with subsequent spawns; the daemon compares it against its locally resolved plan and refuses catalogue drift instead of executing caller-supplied arguments. This pins the catalogue command recipe, not the installed binary version, PATH resolution, inherited environment, credentials, or runtime reachback environment. Structured launch requires an executable that the OS can spawn without a shell; shell-only wrappers such as Windows `.cmd` shims are not converted into shell commands.

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

The host may push scripts or other resources through `server/sendResource`. The daemon resolves destinations against its environment registry, writes the resource locally, and injects the same environment into spawned processes.

The standard environment includes:

| Variable | Purpose |
| --- | --- |
| `AGENTLET_REACHBACK_DIR` | Directory containing host-provided resources. |
| `AGENTLET_SERVER` | Gateway URL supplied to the daemon. |
| `AGENTLET_TOKEN` | Authentication token available to host-provided reachback tools. |

Agentlet transports opaque resources and environment values; it does not interpret the host-specific tool protocol.

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
