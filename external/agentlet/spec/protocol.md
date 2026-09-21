# Agentlet Protocol

The definitive machine-readable contract is the TypeScript API in [`packages/protocol/src`](../packages/protocol/src). Wire method names retain the `server/*` prefix for compatibility even when the host implementation is called a Gateway.

## 1. Connection model

Agentlet uses two independent outbound WebSocket connection roles:

| Role | Identity | First message | Purpose |
| --- | --- | --- | --- |
| `agentlet` | `agentletId` | `agentlet/hello` | Machine-level control channel for spawn, stop, list, resource delivery, and shutdown. |
| `session` | ACP `sessionId` | `agent/hello` | Per-agent ACP relay channel with bootstrap metadata. |

The WebSocket URL includes `role`, `id`, and `token` query parameters. The Gateway authenticates the token and verifies that the query identity matches the hello payload before registering the connection.

```text
/api/bridge?role=agentlet&id=<agentletId>&token=<token>
/api/bridge?role=session&id=<sessionId>&token=<token>
```

Control and session channels report the same `agentletId`. Disconnecting one role does not implicitly disconnect the other role.

## 2. Lifecycle

```text
daemon -> Gateway: connect role=agentlet
daemon -> Gateway: agentlet/hello
Gateway -> daemon: server/spawn
daemon -> ACP process: initialize
daemon -> ACP process: session/new | session/resume | session/load
daemon -> Gateway: connect role=session
daemon -> Gateway: agent/hello
Gateway <-> daemon <-> ACP process: transparent ACP JSON-RPC relay
```

`agentlet/hello` carries the execution-node profile:

```json
{
  "jsonrpc": "2.0",
  "method": "agentlet/hello",
  "id": 1,
  "params": {
    "agentletId": "worker-01",
    "agentletProfile": {
      "bridge": { "name": "agentlet", "version": "1.0.0" },
      "machine": { "hostname": "worker-01", "platform": "linux" },
      "capabilities": {
        "autoRestart": true,
        "bufferLimit": 1000,
        "maxAgents": 10,
        "harnessDiscovery": { "version": 1 }
      }
    }
  }
}
```

`agent/hello` carries the ACP session identity and the complete live `sessionProfile`, including process details, ACP bootstrap capability flags, initialization results, and the optional `session/new` response.

Both hello methods are requests and require a matching JSON-RPC response before ordinary traffic begins.

## 3. Control methods

### Daemon to Gateway

| Method | Shape | Meaning |
| --- | --- | --- |
| `agentlet/hello` | Request | Register or reconnect the machine control channel. |
| `agent/hello` | Request | Register or reconnect one ACP session channel. |
| `agent/exited` | Notification | Agent process exited. |
| `agent/restarted` | Notification | Agent process restarted after a crash. |
| `agent/goodbye` | Notification | Daemon or session is shutting down. |
| `agent/overflow` | Notification | A bounded reconnect buffer dropped messages. |
| `agent/suspended` | Notification | Idle timeout suspended a resumable session. |
| `agent/pong` | Notification | Application-level heartbeat response. |

### Gateway to daemon

| Method | Shape | Meaning |
| --- | --- | --- |
| `server/spawn` | Request | Launch and bootstrap an ACP agent. |
| `server/stop` | Request | Stop one managed agent session. |
| `server/list` | Request | List the daemon's active agents. |
| `server/discoverHarnesses` | Request | Discover the daemon's static ACP harness catalogue, optionally preparing local workspaces. |
| `server/buildHarnessLaunch` | Request | Compile a Profile launch without probing, spawning, or preparing workspaces. |
| `server/sendResource` | Notification | Write a host-provided resource through the daemon environment registry. |
| `server/replay` | Notification | Replay Gateway-to-daemon messages buffered during disconnection. |
| `server/ping` | Notification | Application-level heartbeat request. |
| `server/shutdown` | Notification | Ask the daemon to stop gracefully. |

`server/discoverHarnesses` accepts omitted params, `{}`, or `{ "prepareWorkspaces": boolean }`; every other option and invalid request shape is rejected with `-32602`. The advertised `AgentletProfile.capabilities.harnessDiscovery` is `{ version: 1 }`. Unsupported daemons must not be inferred to support discovery.

Discovery includes a final `custom` descriptor for manual selection, with `installed: false` and no executable probe or workspace preparation. Hosts must not auto-provision it. Entries may include `launchPreviewVersion: 1` and `capabilities.customLaunchCommand` (`supported`, `unsupported`, or `unknown`); older responses may omit these fields. Custom supports only custom commands, while known wrappers do not support command overrides.

`server/buildHarnessLaunch` requires `AgentletProfile.capabilities.harnessLaunchPreview: { version: 1 }`. Its only parameter is `{ launch }`, where launch is the unchanged Profile union `{ kind: 'acp-command', command }` or `{ kind: 'acp-harness', harnessId, options?: { autoApprove?: boolean } }`. A legacy command maps to Custom without inspecting its text or metadata. A structured launch maps to its known catalogue wrapper; `harnessId: 'custom'` is invalid. The response is `{ kind: 'exec', executable, argv, env }` or `{ kind: 'shell', command }`. Compilation is pure and shares runtime wrapper logic; it does not resolve PATH, create directories, test credentials, or start ACP. Unknown fields, malformed input, unknown wrappers, and unsupported options fail with `-32602`. No model launch option is introduced. Gateways validate request and response and reject old daemons explicitly rather than computing a local fallback.

The result is `{ harnesses: HarnessDiscoveryEntry[] }`, including the complete catalogue in stable order. Each entry contains `id`, `displayName`, `binary`, `acpArgs`, `autoApprove`, `installHint`, and `installed`, with optional `executablePath`, `version`, `workingDirPath`, and `diagnostics: Array<{ code, message }>`. `autoApprove` is either `null` or `{ args: string[], position: "before-acp" | "after-acp" }`. Skip-version rules are internal catalogue data and are not returned.

Discovery is read-only unless `prepareWorkspaces` is explicitly true. Probes use shell-free `execFile` calls with a 2.5-second timeout and bounded output. PATH lookup distinguishes `binary_missing` from `lookup_failed`; optional version failures produce `version_unknown` or `version_probe_failed` while retaining `installed: true`. Known interactive adapters are never invoked for version detection. Discovery never installs tools, copies skills or prompts, provisions credentials, or starts an ACP session.

With preparation enabled, only installed entries receive reusable directories under the daemon's own `homedir()/.agentlet/workspace/<static-catalogue-id>`. Neither roots nor IDs are supplied remotely. Directory creation never clears existing data; failure returns `workspace_failed` without `workingDirPath` and without a fallback path. Installation state remains independent of workspace readiness.

The retired `agent-team/*` RPCs return unknown-method errors; there is no setup worker or progress notification.

All JSON-RPC envelopes and method payloads are defined in [`messages.ts`](../packages/protocol/src/messages.ts) and [`json-rpc.ts`](../packages/protocol/src/json-rpc.ts).

## 4. Spawn and bootstrap

`server/spawn` includes a host correlation `appId`, an optional native ACP `sessionId`, and a `sessionSpec`.

The daemon uses the required `sessionSpec.command` and optional `sessionSpec.cwd` directly, then launches the process with `shell: true`. The host must therefore send only trusted commands. Any `sessionSpec.agentTeam` field is explicitly rejected with `-32602`, including when a command is also supplied; there is no manifest resolution or silent fallback.

For a fresh session the daemon performs:

1. `initialize`
2. `session/new`
3. session WebSocket connection
4. `agent/hello`

When `sessionId` is supplied, the daemon prefers `session/resume` and falls back to `session/load` when supported. If native recovery is unavailable because the method is unsupported, the session does not exist, or the ACP resource is missing, the spawn error carries `data: { "code": "session_resume_unavailable" }`.

The host must include the required spawn parameters in every request. Agentlet has no durable session store.

Historical Team manifest data is described in [`agent-team.md`](agent-team.md); it is not a runtime launch contract.

## 5. ACP relay

After `agent/hello` succeeds, every WebSocket text frame on the session channel contains exactly one ACP JSON-RPC message.

```text
Gateway -> session WebSocket -> agent stdin
agent stdout -> session WebSocket -> Gateway
```

The daemon appends newline framing when writing to agent stdin and reads agent stdout line by line. Invalid JSON and binary WebSocket frames are rejected rather than forwarded.

Agentlet performs ACP session bootstrap locally before opening the session connection. The Gateway does not send `initialize` or `session/new` through the relay.

Idle suspension measures host-to-agent inactivity only when no host request is awaiting an agent response. A pending request such as `session/prompt` keeps the session active for its entire duration; the idle countdown restarts after the matching success or error response arrives.

## 6. Reconnection and buffering

When the machine control WebSocket disconnects unexpectedly, the daemon reconnects with exponential backoff capped by `--reconnect-max`, then repeats `agentlet/hello` with the same `agentletId`.

Session WebSockets do not currently reconnect automatically. Closing a session connection stops its relay without implicitly stopping the ACP process; the host must realize or stop that workload explicitly.

The Gateway surfaces a local `agent/disconnected` lifecycle event when a session WebSocket closes so host clients can reject pending requests and discard connection-scoped state. This event is not an on-wire agent notification.

The daemon uses bounded FIFO buffers for ACP notifications emitted during bootstrap and through the short window before the new session relay attaches. The embedding Gateway may independently buffer host-to-session traffic while its connection object is detached. Neither side provides durable replay, sequence acknowledgement, or deduplication.

## 7. Identity and placement

The daemon's `agentletId` defaults to the operating-system hostname and can be supplied explicitly with `--agentlet-id`. The same identity appears in the control query, `agentlet/hello`, session query context, and `sessionProfile.agentletId`.

The native ACP `sessionId` is established by session bootstrap and is the routing identity for one session connection. The embedding control plane selects the target `agentletId`; the daemon does not choose workload placement.

## 8. Security boundary

- Production connections require `wss://`; `--allow-insecure` permits `ws://` only when explicitly requested.
- The Gateway authenticates both control and session connections before accepting hello.
- Agent commands run with the daemon process's operating-system permissions.
- `sessionSpec.command` uses a shell and is trusted control-plane input.
- Resource destinations are resolved through the daemon environment registry.

## 9. Resource distribution

`server/sendResource` runs on the machine-level control channel and carries `{ destination, content }`.

The destination may reference daemon environment variables such as `${AGENTLET_REACHBACK_DIR}`. The daemon resolves the destination, creates parent directories, writes the text content, and logs success or failure.

Hosts should send resources when a daemon connects and repeat them after reconnect. Writes are overwrite-based and idempotent.

The host-agnostic Reachback contract is documented in [`agent-reachback.md`](agent-reachback.md).

## 10. Source references

| Contract | Source |
| --- | --- |
| Method constants and error codes | [`packages/protocol/src/constants.ts`](../packages/protocol/src/constants.ts) |
| JSON-RPC envelopes and ACP message alias | [`packages/protocol/src/json-rpc.ts`](../packages/protocol/src/json-rpc.ts) |
| Hello, lifecycle, spawn, replay, and resource payloads | [`packages/protocol/src/messages.ts`](../packages/protocol/src/messages.ts) |
| Shared Gateway-facing connection types | [`packages/protocol/src/gateway-types.ts`](../packages/protocol/src/gateway-types.ts) |
| Daemon implementation | [`packages/local/src/agentlet.ts`](../packages/local/src/agentlet.ts) |
| Trusted harness catalogue and probes | [`packages/local/src/harnesses/catalogue.ts`](../packages/local/src/harnesses/catalogue.ts), [`detect.ts`](../packages/local/src/harnesses/detect.ts) |
| Daemon-owned reusable workspaces | [`packages/local/src/harnesses/workspace.ts`](../packages/local/src/harnesses/workspace.ts) |
| WebSocket client and reconnect behavior | [`packages/local/src/ws-client.ts`](../packages/local/src/ws-client.ts) |
