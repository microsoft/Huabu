# Agentlet

Agentlet is an execution-plane daemon that makes local stdio-based ACP agents available to a remote control plane over outbound WebSocket connections.

It contains no AI or host-application logic. The daemon accepts authenticated control messages, launches ACP-compatible processes, performs ACP session bootstrap locally, and relays protocol messages between each process and the remote Gateway.

## Responsibilities

- Register one execution machine through an `agentlet/hello` control connection.
- Accept `server/spawn`, `server/stop`, `server/list`, `server/sendResource`, and shutdown control messages.
- Launch and supervise multiple ACP agent processes.
- Bootstrap each process with `initialize` followed by `session/new`, `session/resume`, or `session/load`.
- Register each bootstrapped session through its own `agent/hello` WebSocket connection.
- Relay ACP JSON-RPC messages without interpreting application semantics.
- Reconnect the machine control channel with bounded exponential backoff.
- Buffer the bounded pre-attach notification window until a new session relay is ready.
- Prepare and validate Agent Team packages through the `agentlet agent-team` commands.

Agentlet does not provide a standalone relay server, REST API, browser UI, token administration service, or durable session/event store. Those control-plane responsibilities belong to the embedding host and its Gateway.

## Packages

| Package | Responsibility |
| --- | --- |
| `agentlet` | Daemon CLI, ACP process lifecycle, WebSocket client, relay, logging, and Agent Team commands. |
| `@agentlet/protocol` | Shared daemon/Gateway JSON-RPC types and method constants. |
| `@agentlet/agent-team` | Agent Team manifest parsing, setup, validation, and diagnostics. |

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

## Agent Teams

Run Agent Team commands from a directory containing `agentlet.yaml`:

```bash
agentlet agent-team setup
agentlet agent-team validate
agentlet agent-team doctor
```

Use `--harness <name>` to target one configured harness.

The declarative manifest and workspace preparation contract are documented in [`spec/agent-team.md`](spec/agent-team.md).

## Protocol lifecycle

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
  agent-team/  # Agent Team manifests and setup logic
spec/
  protocol.md
  agent-reachback.md
  agent-team.md
```
