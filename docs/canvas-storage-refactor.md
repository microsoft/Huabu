# Canvas-Centric Storage Refactor

> Status: Plan (not yet executed)
> Owner: TBD
> Last updated: 2026-04-30

## 1. Goal

Reorganise all canvas-related persistence so that every canvas is **fully
self-contained** on disk, and consolidate I/O behind a single storage
facade in the codebase.

- Remove the global `sources/` knowledge pool. The `sourceId` concept is
  retired; node markdown lives next to the canvas that owns it.
- Each canvas becomes one folder under the workspace root.
- All file I/O for canvas / nodes / artifacts / chat / intent / events /
  preferences flows through a single `CanvasStore` API.

## 2. Decisions

| #             | Decision                                                                                                               |
| ------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Layout        | `<canvasId>/` holds `canvas.json`, `nodes/`, `artifacts/`, `memory/`, `.history/` (siblings)                           |
| File formats  | `intent.json` (structured), `events.json` (array of `{ts,kind,payload}`), `memory/preferences.md` (frontmatter + body) |
| Artifacts     | Fully private per canvas (no cross-canvas dedup)                                                                       |
| `sourceId`    | Removed in one shot — no legacy field retained                                                                         |
| Migration     | Auto-runs on workspace open; idempotent; no version sentinel; no `_legacy_` archive                                    |
| Export        | `.sediment.zip` (zips the `<canvasId>/` directory)                                                                     |
| Import        | `multipart/form-data` upload of a `.zip`                                                                               |
| Canvas delete | `rm -rf <canvasId>/` (no trash)                                                                                        |

## 3. Final Disk Layout

```
<workspace>/
  <canvasId>/
    canvas.json               # { canvasId, title, version, state:{nodes,edges,...}, createdAt, updatedAt }
    nodes/
      <nodeId>.md             # frontmatter: type/title/src/content_hash/meta_json + body
    artifacts/
      <id>.<ext>              # private PDF / image / video / cover
    memory/
      preferences.md          # YAML frontmatter + markdown body
    .history/                 # hidden
      chat/<threadId>.json    # pi-ai Context
      intent.json             # IntentEpisode[]
      events.json             # CanvasEvent[]: [{ ts, kind, payload }, ...]
```

`listCanvases()` enumerates top-level subdirectories, skipping any whose
name starts with `.` or that lack a `canvas.json` file.

## 4. New Storage Module

`apps/server/src/modules/storage/`

```
paths.ts          # the only place that joins workspace paths
io.ts             # atomicWriteJson / atomicWriteText / readJson / readText / appendJsonArray / mkdirp / sanitizeId / safeJoin
frontmatter.ts    # toFrontmatter / parseFrontmatter (extracted from knowledge module)
canvas-store.ts   # CanvasStore class (per-canvas instance)
index.ts          # getCanvasStore / listCanvases / createCanvas / deleteCanvas / resetStorageCache
migrate.ts        # one-shot, idempotent migration from old layout
```

### `paths.ts`

```ts
canvasRoot(id);
canvasJsonPath(id); // <id>/canvas.json
nodesDir(id); // <id>/nodes
nodeMdPath(id, nodeId);
artifactsDir(id); // <id>/artifacts
artifactPath(id, filename);
memoryDir(id); // <id>/memory
prefsPath(id); // <id>/memory/preferences.md
historyDir(id); // <id>/.history
chatDir(id); // <id>/.history/chat
chatPath(id, threadId);
intentPath(id); // <id>/.history/intent.json
eventsPath(id); // <id>/.history/events.json
```

All functions validate `[a-zA-Z0-9_-]+` and reject path traversal.

### `CanvasStore` API

```ts
class CanvasStore {
  readonly canvasId: string;

  // Canvas structure
  read(): CanvasFile | null;
  write(c: CanvasFile): void; // atomic
  readVersion(): number | null;

  // Node content (replaces knowledge sources)
  readNode(nodeId: string): NodeContent | null;
  writeNode(nodeId: string, c: NodeContent): void;
  deleteNode(nodeId: string): boolean;
  listNodes(): NodeContentSummary[];

  // Artifacts
  artifactPath(filename: string): string;
  writeArtifactStream(
    filename: string,
    src: NodeJS.ReadableStream,
  ): Promise<void>;
  writeArtifactBuffer(filename: string, data: Buffer): Promise<void>;
  deleteArtifact(filename: string): Promise<boolean>;
  listArtifacts(): string[];

  // Chat
  readChat(threadId: string): Context | null;
  writeChat(threadId: string, ctx: Context): void;
  loadLatestChat(): { threadId: string; context: Context } | null;
  listChatThreads(): string[];

  // Intent
  readIntents(): IntentEpisode[];
  upsertIntent(ep: IntentEpisode): void;

  // Events / Preferences
  appendEvent(kind: string, payload: unknown): void;
  readEvents(limit?: number): CanvasEvent[];
  readPreferences(): UserPreferences;
  writePreferences(p: UserPreferences): void;

  // Lifecycle
  destroy(): boolean; // rm -rf canvasRoot
}
```
