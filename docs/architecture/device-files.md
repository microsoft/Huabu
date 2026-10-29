# Connected-device File Explorer

The Files mode in the left Canvas sidebar browses files on an explicitly selected connected Agentlet. The working-directory popover beside Chat's Profile selector offers **Browse files** for its effective device and directory without editing either. Realized conversations use the frozen execution device and cwd, not the current Profile template. Legacy executions without a known frozen device cannot guess a replacement.

## Transport and ownership

```text
Files sidebar / file-reference Preview
  -> owner-only POST /api/acp/files
  -> private queued ACP Job on the exact Agentlet
  -> bundled proxy harness, session/prompt
  -> native read-only filesystem operations
```

Agentlet bundles the deterministic `proxy` ACP executable beside its daemon. Discovery provisions one automatic Profile per device with `harnessId: "proxy"` and `visible: false`. Missing `visible` means visible for existing Profiles. Normal Profile lists, selectors and absent-only Utility defaults exclude hidden Profiles; hiding is presentation, not an authorization boundary. Manual creation reserves the proxy harness. Discovery and launch reuse existing Agentlet messages and the ACP relay; there is no new filesystem WSS method, shell command dispatcher, downloaded runtime or model call.

The Server lazily maintains at most four device sessions, with at most eight queued operations per device and FIFO execution within each session. These are private Jobs with no Chat node, durable conversation transcript, RFS environment or conversational recency update. Their neutral Profile cwd does not change with browsing. A cold request has a 60-second deadline and a warm request 10 seconds. Idle sessions retire after 60 seconds, checked every 15 seconds. Disconnect, reconnect, failure and shutdown retire the old generation, shut down the client and reclaim its Agentlet process. Late startup retains admission ownership until it settles and can be reclaimed; failed reclamation is explicit and retryable rather than admitting replacement processes silently.

## Command contract

The proxy advertises `fs-list` and `fs-read` through ACP `available_commands_update`. A prompt contains exactly one text block: `/COMMAND ` followed by one strict JSON object. Unknown commands and fields are rejected. Each call is self-contained; ACP session reuse is an optimization, not filesystem command state. There are no root IDs, open/close operations, retained file handles or per-browser authorization roots.

| Command   | Input                                                             | Result                                                                                                     |
| --------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `fs-list` | Absolute `path`; optional `cursor`, `limit` (1–100), `showHidden` | Canonical `path`, `parentPath`, bounded `entries` (`name`, absolute `path`, `kind`), optional `nextCursor` |
| `fs-read` | Absolute `path`; optional `cursor`, `limitBytes` (4–65,536)       | `path`, `encoding: "utf-8"`, source `text`, `byteLength`, `size`, `contentVersion`, optional `nextCursor`  |

The response is one JSON document: `{ version: 1, operation, ok: true, result }` or `{ version: 1, operation, ok: false, error: { code, message } }`. The Server assembles bounded text notifications and accepts a result only after successful `end_turn`, response schema validation and matching operation. ACP completion alone is not filesystem success. Permission requests are rejected. Raw file output is not written to runtime diagnostics or conversation history; HTTP results use `Cache-Control: no-store`.

Paths are native absolute paths on the selected Agentlet, not the Huabu Server or browser. The process OS account is the authority: all readable paths are accessible, normal symlinks are followed, and no privilege elevation or project-root confinement is added. Only directory listing and stable-sized regular UTF-8 text reads are implemented. Binary/invalid text, special or generated files without stable size metadata, inaccessible paths and malformed requests fail explicitly. The proxy uses nonblocking read-only opens to avoid blocking on a substituted FIFO.

List cursors encode the canonical directory, hidden-file option and last name. Pages are best-effort under directory mutation, not snapshots; the UI deduplicates entries. Scans are capped at 20,000 entries. Read cursors encode path, byte offset and a version derived from filesystem identity, size and timestamps. Reads preserve UTF-8 boundaries and reject changes between or during chunks; they do not retain file descriptors across calls. Responses are capped at 524,288 serialized bytes. Cursors are continuation positions, not secrets or authorization grants.

## Canvas and Preview

Files uses existing Common controls and `react-virtuoso` for a lazy expandable directory disclosure list. It loads directories on demand, supports hidden-file filtering and pagination, and caps a mounted tree at 2,000 entries and 32 nested levels. Opening a path or refreshing rereads the tree; there is no watcher, polling or rename tracking. Layers remains the other sidebar mode, and Canvas search switches back to Layers.

Adding or dragging a file uses existing Canvas commands to create a `fileReference` node. Structural data stores only `{ agentletId, path, deviceName? }` under `data.fileReference`, plus ordinary presentation fields. The label uses a frontmatter-only node sidecar. Content/source mutation endpoints reject source bytes on these nodes. Duplication and bundle export preserve inert references, not external file contents. Loading a Canvas or processing/searching its nodes does not read remote files or import them into artifacts.

Opening a file-reference Preview reads supported UTF-8 text into component-local state. The view reuses read-only CodeMirror in plain-text mode; `.tex` remains source and is never compiled. Manual refresh restarts from the path, including a replacement made by atomic save. Read more continues up to a 256 KiB display cap; stale content and offline devices remain explicit errors until retry. No edit, download-as-import, automatic AI ingestion, shell execution or automatic reference repair is provided.

A single nonempty contiguous text selection offers Comment, using the existing Preview Comment editor and existing-conversation destination picker. Explicit staging shares only the captured quote and up to 40 UTF-16 positions of neighboring loaded text per side, not the full file or an implicit attachment. The structured file source freezes Space/reference-node ID, Agentlet ID, canonical returned path, `contentVersion`, UTF-16 selection offsets, loaded document length and completeness. Offsets address CodeMirror's line-ending-normalized text, not UTF-8 byte positions. `contentVersion` identifies observed filesystem state, not a content hash or a retained historical file; the source device may differ from the receiving Agent's execution device. Metadata appears in the escaped model reference template, not editable comment text.

CodeMirror's model owns capture even when selected lines are virtualized. New capture is unavailable during loading or a read error; an already opened Comment retains its original labeled snapshot across refresh/read-more/failure. Switching reference identity closes that editor rather than retargeting it. Capture never reads more bytes, edits/imports the file, creates an Agent, submits a turn or navigates to a hidden conversation. Hidden drafts reuse the explicit View input notification described in [Preview Workspace](./preview-workspace.md). Chat, Note, Ink and other Preview types retain their existing behavior.

## Code entry points

| File                                                                                           | Responsibility                                                    |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| [filesystem protocol](../../external/agentlet/packages/protocol/src/filesystem.ts)             | Command vocabulary, request validation and resource constants     |
| [native filesystem reader](../../external/agentlet/packages/local/src/filesystem.ts)           | Read-only list/read, encoding, symlinks and stateless cursors     |
| [ACP proxy](../../external/agentlet/packages/local/src/fs-proxy.ts)                            | Capability advertisement and deterministic ACP command dispatch   |
| [proxy harness](../../external/agentlet/packages/local/src/harnesses/proxy.ts)                 | Bundled discovery and trusted launch compilation                  |
| [HTTP schemas](../../packages/shared/src/types/api/device-files.ts)                            | Canonical request/result and reference metadata schemas           |
| [private session service](../../apps/server/src/modules/agent/acp/device-files.ts)             | Exact-device routing, lifecycle, queueing and response validation |
| [HTTP route](../../apps/server/src/modules/agent/acp/device-files.route.ts)                    | Owner authorization and explicit HTTP errors                      |
| [Files panel](../../apps/web/src/components/Panels/FilesPanel.tsx)                             | Lazy directory disclosure, pagination, Add and copy-only drag     |
| [file-reference renderers](../../apps/web/src/components/Nodes/fileReference/)                 | Metadata card and bounded read-only source Preview                |
| [FileCommentActions](../../apps/web/src/components/Nodes/fileReference/FileCommentActions.tsx) | Model-based CodeMirror selection and frozen file-source capture   |
