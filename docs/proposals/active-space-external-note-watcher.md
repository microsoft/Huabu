# Active-Space External-Note Watcher

Status: Accepted — implemented on PR [#392](https://github.com/hai-team/Huabu/pull/392); set to `Shipped` when that PR merges.
Last updated: 2026-07-30

> **Superseded in part.** A follow-up on the same PR removed the depth-zero Workspace watcher entirely and moved the suspension bracket out of this module, so sections [9](#9-workspace-lifecycle) and [10](#10-server-owned-rename-and-delete) no longer describe shipped code. The `canvasId -> directory` index is now invalidated lazily by its read paths, and `space-dir-handles.ts` owns a neutral, `canvasId`-scoped `withSpaceDirHandlesReleased` primitive that active sessions register with. [canvas-storage.md](../architecture/canvas-storage.md) is authoritative.

> **Scope.** This proposal refines the external-note watcher introduced by PR #392 so Workspace-level observation owns only Space lifecycle while `nodes/` observation exists only for Spaces with active external-note SSE subscribers. It preserves #392's depth-zero Workspace watcher, lazy discovery, bounded asynchronous reads, and cloud-drive startup improvements. It does not attempt to repair Google Drive, OneDrive, or macOS File Provider synchronization state.

## 1. Problem

The current implementation watches the entire Workspace with Chokidar to discover external Markdown files under every `<Space>/nodes/` directory. Even with `ignoreInitial: true`, Chokidar crawls the existing directory tree while it initializes. On cloud-backed Workspaces this can enumerate and hydrate hundreds of virtual files, block the server event loop, delay API requests, and create unnecessary load on the sync provider.

PR #392 correctly removes that recursive startup crawl by limiting Chokidar to Workspace depth zero, lazily scanning a Space when its external-note stream first opens, and using native `fs.watch` handles for subsequent note events. Its first implementation registers one native watcher for every Space at Workspace startup.

Registering every Space's `nodes/` watcher preserves the old Workspace-wide observation behavior, but it retains the wrong ownership boundary. An inactive Space has no SSE consumer, and its eventual state is recovered by the first lazy scan. Workspace lifecycle code therefore does not need to own or retain watchers for every Space's internal files.

## 2. Goals

- Keep Workspace startup independent of the number of Markdown files under all `nodes/` directories.
- Restrict the Workspace watcher to top-level Space creation, deletion, and rename detection.
- Create a native `nodes/` watcher only while a Space has at least one external-note SSE subscriber.
- Guarantee that initial discovery and live events compose without a gap or stale resurrection.
- Share one watcher across concurrent subscribers to the same Space and release it after the last subscriber disconnects.
- Prevent scans from an old Workspace generation from mutating state after reset, switch, or shutdown.
- Preserve #392's maximum of eight concurrent Markdown reads and one asynchronous `space.json` read per initial scan.
- Degrade to a lazy snapshot when native watching is unavailable instead of failing the SSE request.

## 3. Non-goals

- Forcing a cloud provider to upload or download files.
- Establishing that local files are fully synchronized with remote storage.
- Repairing DriveFS, OneDrive, or macOS File Provider databases, snapshots, cursors, conflicts, or placeholders.
- Coordinating concurrent edits from multiple devices.
- Replacing node revision CAS or the durable write coordinator.
- Watching nested directories below `nodes/`; external-note discovery remains flat and Markdown-only.

## 4. Ownership model

```text
Workspace watcher (one, depth zero)
  Space create / delete / rename

Active Space session (one per subscribed Space)
  native watcher on <Space>/nodes/
  initial lazy scan
  pending event timers
  subscriber reference count

Inactive Space
  no nodes/ watcher
  no in-memory external-note state required
  first subscription reconstructs state from disk
```

The Workspace watcher owns only the mapping between stable `canvasId` values and top-level directory names. A Space session owns observation and discovery inside that Space. The SSE subscription is the resource boundary because it is the only consumer of live external-note events.

## 5. Proposed session API

Replace the route's separate scan and subscription calls with one operation that acquires a coherent Space-scoped session:

```ts
interface ExternalNoteSession {
  snapshot: ExternalNoteItem[];
  close(): void;
}

function openExternalNoteSession(
  canvasId: string,
  listener: (event: ExternalNoteEvent) => void,
): Promise<ExternalNoteSession>;
```

The first subscriber creates the native watcher before discovery begins. Additional subscribers reuse the same watcher and pending state. Each returned `close` function is idempotent; the final close releases the native watcher, clears pending timers, and removes Space-scoped discovery state.

The route must call `close` when the request closes, including when the client disconnects while initial discovery is still running. A closed response must never receive the snapshot or later live events.

## 6. Space session state

```ts
interface ActiveSpaceWatch {
  canvasId: string;
  nodesPath: string;
  watcher: NativeFSWatcher | null;
  subscribers: Set<Listener>;
  pendingItems: Map<string, ExternalNoteItem>;
  pendingEvents: Map<string, NodeJS.Timeout>;
  scanGeneration: number;
  initialScan: Promise<void> | null;
}
```

The implementation may use a reference count instead of a listener set if listener ownership remains explicit, but it must keep exactly one watcher and one initial scan per active Space. Failed scans must not be cached permanently; a later subscription must be allowed to retry.

## 7. Gap-free initial discovery

The first subscription follows this order:

```text
resolve current Space directory
  -> register native nodes/ watcher
  -> capture Workspace and session generations
  -> enumerate existing nodes/*.md
  -> read candidates with concurrency <= 8
  -> merge scan results with events observed during the scan
  -> verify both generations are still current
  -> return one snapshot
```

Registering the watcher before scanning closes the ordinary scan-then-watch race. Event application and scan application must be idempotent by `relativePath`.

An event observed during discovery wins over an older scan observation. If a file is removed after enumeration but before its read completes, the read failure or recorded remove event keeps it out of the snapshot. If a file is added after enumeration, the watcher adds it even though the directory listing did not include it. Repeated add or change events replace the same map entry rather than creating duplicates.

Native events are settled with a named bounded delay such as `NODE_EVENT_SETTLE_MS`, then verified with `stat` and `readFile`. Transient read failures may receive a small bounded retry; reset, close, and final unsubscribe clear all pending timers.

## 8. Generation safety

Maintain a monotonically increasing Workspace generation. Reset, Workspace switch, and shutdown increment it before closing handles or clearing state. Each initial scan captures the current Workspace generation and a Space-session generation.

A scan may commit results only when both captured generations still match. Closing and reopening the same Space advances the session generation, so a slow cloud read from the old session cannot repopulate a new session. Workspace switching similarly prevents the previous Workspace's scan from writing into current in-memory state.

## 9. Workspace lifecycle

The depth-zero Chokidar watcher reacts only to real top-level directory changes after its initial ready event. It refreshes the `canvasId -> directory` index without enumerating `nodes/` contents.

When an inactive Space is created, deleted, or renamed, no Space watcher work is required beyond refreshing the index. When an active Space is deleted, its session is closed and subscribers receive an appropriate terminal or empty-state response. When an active Space is renamed, the implementation refreshes the index and re-arms only that active Space's native watcher at its new path.

Workspace reset and server shutdown close the Workspace watcher and all active Space sessions. Neither operation re-arms inactive Spaces.

## 10. Server-owned rename and delete

`runWithExternalNoteWatcherSuspended` continues to protect server-owned Space directory rename and delete operations on platforms where open watcher handles can block filesystem mutation.

Suspension records active sessions, closes the depth-zero Workspace watcher and only those active Space watchers, performs the mutation, refreshes the directory index, and re-arms only sessions that still have subscribers and resolve to live Spaces. Deleted sessions are discarded. Pending timers are cleared before mutation so callbacks cannot target stale paths.

## 11. Failure behavior

If native `fs.watch` registration fails, log a warning containing `canvasId` and `nodesPath`, continue the initial lazy scan, and return its snapshot. The next first subscription may retry watcher registration. This fallback gives a correct initial state without claiming realtime updates are available.

If directory enumeration or content reads fail, preserve any valid watcher-observed entries, do not permanently cache the failed scan, and allow a later subscription to retry. Errors in one Space must not block requests or scans for another Space.

## 12. Expected impact

### Local Workspaces

Local Workspaces avoid the previous recursive startup crawl and no longer allocate one watcher per inactive Space. The first external-note stream for a Space pays one bounded scan, while live add, remove, and rename discovery remains realtime for active Spaces. Normal canvas loading, node writes, chat persistence, and CAS behavior are unchanged.

### Cloud-backed Workspaces

Google Drive, OneDrive, and other virtual filesystems receive substantially fewer startup enumerations, reads, and persistent watch registrations. Only actively viewed Spaces touch their `nodes/` directories. This reduces sync-provider pressure and server stalls, but it does not guarantee that the provider has downloaded every remote change or that its local index is healthy.

### Resource scaling

Watcher count scales with active external-note streams rather than total Space count:

$$
W = 1 + A
$$

where $W$ is the total watcher count and $A$ is the number of distinct Spaces with active subscribers. The constant watcher is the Workspace depth-zero watcher.

## 13. Implementation plan

1. Keep PR #392's depth-zero Chokidar configuration, lazy scan helpers, asynchronous topology read, and concurrency limit.
2. Remove startup-wide `armNodeWatchers` and the array of watchers for all Spaces.
3. Introduce the active Space session map and generation counters.
4. Implement watcher-first, scan-second session acquisition with idempotent event merging.
5. Update the external-note SSE route to acquire one session and release it on every close path.
6. Refactor suspension, Workspace reset, and shutdown to operate on active sessions only.
7. Handle active Space rename and deletion without touching inactive Space internals.
8. Update tests and the storage architecture documentation.
9. Validate on ordinary local storage and a real cloud-backed Workspace before merging PR #392.

## 14. Test plan

### Startup

- Starting the watcher creates one depth-zero Chokidar watcher.
- Startup does not read any `nodes/*.md` file.
- Startup does not register native watchers for inactive Spaces.

### Subscription lifecycle

- The first subscriber to Space A registers only `Space A/nodes/`.
- Space B remains unwatched until its first subscription.
- Multiple subscribers to Space A share one watcher and one initial scan.
- Closing a non-final subscriber keeps the watcher alive.
- Closing the final subscriber closes the watcher and clears timers and state.
- Disconnecting during the initial scan releases the session and suppresses response writes.

### Discovery consistency

- The native watcher is registered before directory enumeration begins.
- A file added during the scan appears exactly once in the snapshot or subsequent event stream.
- A file removed during the scan does not reappear from a late read.
- Duplicate native events do not create duplicate items.
- Markdown read concurrency never exceeds eight.
- One initial scan reads `space.json` at most once.
- A failed initial scan can retry on a later subscription.

### Lifecycle and races

- A scan from an old Workspace generation cannot mutate current state.
- Closing and reopening one Space rejects results from the prior session generation.
- Renaming an active Space re-arms only its watcher at the new path.
- Deleting an active Space closes its watcher and drops its state.
- A file added to an inactive Space is discovered by its first lazy scan.
- Suspension and shutdown release every watcher and timer.

### Failure degradation

- Native watcher registration failure still returns the lazy snapshot.
- One Space's watch or scan failure does not block another Space.
- Transient cloud-drive read failure follows the bounded retry policy and does not hang the SSE route indefinitely.

## 15. Validation

Run the focused server checks first:

```bash
pnpm --filter @huabu/server exec vitest run src/modules/canvas/external-watcher.test.ts
pnpm --filter @huabu/server typecheck
```

Before review handoff, run the repository checks:

```bash
pnpm typecheck
pnpm format
pnpm lint:fix
```

Validate the packaged application against a real cloud-backed Workspace: startup must not enumerate all `nodes/` files; opening Space A must register only Space A's watcher; an external Markdown added to active Space A must appear in realtime; an external Markdown added to inactive Space B must appear on Space B's first open; Workspace switching must reject late results from the previous Workspace; shutdown must release all handles cleanly.

## 16. Rollout and proposal lifecycle

Implement this design as a follow-up commit on PR #392 rather than as a parallel PR from `main`, because it preserves and refines the same #391 fix. The PR should not merge until focused tests pass, repository CI is green, and the real cloud-drive validation succeeds.

When shipped, set this proposal to `Status: Shipped`, record the merge PR or commit, and fold the durable watcher contract into [canvas-storage.md](../architecture/canvas-storage.md). The architecture document remains authoritative for shipped behavior.

## 17. Code entry points

| File                                                                                      | Responsibility                                                                                         |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| [external-watcher.ts](../../apps/server/src/modules/canvas/external-watcher.ts)           | Active Space session ownership, lazy discovery, native event handling, and workspace-switch teardown.  |
| [space-dir-handles.ts](../../apps/server/src/modules/storage/space-dir-handles.ts)        | Neutral `canvasId`-scoped handle release/re-acquire bracket for server-owned Space rename and delete.  |
| [external.route.ts](../../apps/server/src/modules/canvas/external.route.ts)               | External-note SSE session acquisition, snapshot delivery, event forwarding, and release on disconnect. |
| [external-watcher.test.ts](../../apps/server/src/modules/canvas/external-watcher.test.ts) | Subscription, race, lifecycle, degradation, and resource-release coverage.                             |
| [canvas-storage.md](../architecture/canvas-storage.md)                                    | Authoritative shipped storage and watcher contract after implementation.                               |
