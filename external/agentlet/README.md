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

The bundled `proxy` harness is a deterministic ACP agent, not an AI provider. Its `initialize` response declares `agentCapabilities._meta["com.microsoft.agentlet/filesystem"] = { version: 1 }`, identifying the complete fixed read-only `fs-list` / `fs-read` contract. `@agentlet/protocol` exports the canonical extension key, capability value and `supportsFsProtocol` validator. Hosts can validate compatibility before creating a session and must not require a separate command-announcement handshake. The proxy still advertises both commands through `available_commands_update` for older hosts. It accepts `/COMMAND ` followed by a strict JSON object with an absolute `path` and optional stateless continuation cursor. Native read-only operations use the daemon account's filesystem permissions, follow ordinary symlinks, and never execute input as shell commands. Each response is one versioned JSON result or explicit error; listing, UTF-8 reads and serialized output are bounded. The executable is built beside the daemon and needs no downloaded runtime. Hosts decide whether and how to expose this capability to their owner.

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

After building, `pnpm --filter agentlet test` runs the focused filesystem initialization-capability, stdio and harness/bootstrap regressions; embedding workspaces can include them through their normal recursive test command. Set `AGENTLET_FS_PROXY_TEST_ENTRY` to an absolute bundled `fs-proxy.js` path to exercise the production bundle instead of `tsc` output; the harness test uses its sibling `index.js` as the daemon entry.

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

### Pi ACP harness

The `pi` Definition compiles exactly `pi-acp` with no approval or model flags. Discovery requires both `pi-acp` and native `pi` on Unix, or `pi-acp` and **`pi.cmd`** on Windows, matching the adapters' default native launcher. It does not inspect npm package provenance or execute either command, even for version probing: the adapters do not implement a version-only entrypoint. A non-default native launcher configured inside an adapter is outside this Definition's discovery contract; explicit Custom command configuration remains available.

Both prerequisites present reports `ready`; native-only reports `adapter-missing` with `adapter_missing`; adapter-only reports `not-found` with `native_runtime_missing`; neither reports `not-found` with both diagnostics. Failed/malformed/timed-out PATH lookups retain `lookup_failed`, not a missing-package diagnosis. Only ready discovery can prepare `~/.agentlet/workspace/pi`. Readiness proves command presence, not versions, provider login, model availability, or successful ACP startup.

Install native Pi separately on the daemon machine, for example `npm install -g @earendil-works/pi-coding-agent@1.5.2` (Node.js >=22.19.0), then configure its providers/login. Install only one adapter: both packages own the same `pi-acp` binary. The target-platform `installHint` exposes recommendations and known issues to consuming hosts; Agentlet neither installs packages nor fixes or switches adapters.

| Platform | Adapter guidance and known limitations |
| --- | --- |
| Unix | Prefer `npm install -g @geohar/pi-acp@0.4.0`: unlike upstream, it emits standard Bash text/tool output when the client has no terminal capability. It lacks upstream context-usage reporting and model-specific thinking-level discovery. |
| Windows | Prefer `npm install -g pi-acp@0.0.34` for its fixed native session-path escaping (Pi >=0.81.0), but Bash output uses terminal metadata and may not display in terminal-less clients. The fork provides that output fallback but retains known native session-path quoting risks, including paths with spaces. Neither is guaranteed fully compatible. |

Both adapters negotiate ACP protocol 1 and persist native Pi sessions separately from host transcripts. They default to native `~/.pi/agent` (relocatable with `PI_CODING_AGENT_DIR`) and adapter mappings at `~/.pi/pi-acp/session-map.json`. The fork reads its own settings from `<agent-dir>/extensions/pi-acp.json`, with the old agent-root file as fallback; its `dataDir` setting relocates adapter data. Current fork settings do not honor the older advertised `PI_ACP_*` overrides. Authentication and configuration remain user-owned, including optional MCP and plan-producing extensions. Terminal login is an out-of-band native action, not an Agentlet setup workflow.

Pi advertises neither `customLaunchCommand` nor `autoApprove`. `autoApprove: false` means no supported launch-time bypass contract, not that native tools are gated or sandboxed: Pi executes locally, and extension UI select/confirm requests are not a generic native-tool approval protocol. Actual client compatibility depends on its ACP features; adapter implementation defects remain with the external adapter projects.

Linux x64 smoke with Node.js `24.19.0`, native Pi `1.5.2`, both adapter versions above and a local deterministic provider exercised the real Agentlet bootstrap/process tree and a host client on ACP SDK `0.22.1`: new session, config-option model/thinking changes, text/thought/tool/diff streaming, cancellation, continued prompts and cross-process recovery passed. Fork resume and upstream load were selected from their advertised capabilities. Upstream Bash output remained terminal-only. Both adapters rejected the legacy experimental `session/set_model` method, while their advertised `model` config option worked. This does not certify real providers/accounts, Windows/macOS lifecycle, older native versions, or optional extensions.

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
