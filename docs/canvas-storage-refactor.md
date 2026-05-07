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

### `NodeContent` shape

```ts
interface NodeContent {
  nodeId: string;
  type: CanvasNodeType; // 'note' | 'text' | 'web' | 'pdf' | ...
  title: string | null;
  src: string | null; // external URL or 'artifacts/<file>'
  content: string; // canonical markdown body
  contentHash: string; // skip-LLM-on-unchanged within this canvas
  metadata: Record<string, unknown>;
}
```

## 5. Server-Side API Changes

| Old                                | New                                              |
| ---------------------------------- | ------------------------------------------------ |
| `GET /api/knowledge/sources`       | **deleted**                                      |
| `GET /api/knowledge/source/:id`    | **deleted**                                      |
| `PATCH /api/knowledge/source/:id`  | **deleted**                                      |
| `DELETE /api/knowledge/source/:id` | **deleted**                                      |
| `POST /api/artifact/:type`         | `POST /api/canvas/:canvasId/artifact/:type`      |
| `GET /api/artifact/:id`            | `GET /api/canvas/:canvasId/artifact/:filename`   |
| `GET /api/canvas/:canvasId/export` | same URL, response is `application/zip`          |
| `POST /api/canvas/import`          | same URL, request is `multipart/form-data` (zip) |

All other canvas / preprocess / intent / agent routes keep their URLs.

## 6. Schema Changes (`@sediment/shared`)

**Remove**: `Source`, `SourceOverview`, `SourceMetadata`, `SourceKind`,
`CreateSourceInput`, `ExportedSource`, `BaseNodeData.sourceId`,
`hasSourceId`, `BaseNodeData.contentSnapshot`.

**Rename**: `NodeOrigin.user-excerpt.sourceId` → `excerptFromNodeId` (canvas-local).

**Add**: `NodeContent`, `NodeContentSummary`, `UserPreferences`,
`CanvasEvent { ts: number; kind: string; payload: unknown }`,
`CanvasZipManifest { version: '2'; exportedAt: string; sourceCanvasId: string; title: string | null }`.

## 7. Migration Strategy

Trigger: `setWorkspacePath()` calls `runMigrationIfNeeded(ws)` which
detects the old layout by the presence of any of `canvas/`, `sources/`,
`artifacts/`, `.history/` together with the absence of corresponding
new-layout `<canvasId>/canvas.json` files.

For each old `canvas/<id>.json`:

1. `mkdir -p <id>/{nodes,artifacts,memory,.history/chat}`
2. Read the old JSON. For each node:
   - If `data.sourceId` resolves to `sources/<title>.md`, copy that
     content to `<id>/nodes/<nodeId>.md`, rewrite the frontmatter
     (`type/title/src/content_hash/meta_json`), and drop `sourceId` /
     `contentSnapshot` from `node.data`.
   - If `data.src` / `data.coverUrl` references `/api/artifact/<file>`,
     copy `<workspace>/artifacts/<file>` into `<id>/artifacts/` and
     rewrite the URL to `/api/canvas/<id>/artifact/<file>`.
   - If `node.data.origin.sourceId` is present (excerpt origin), look up
     the canvas-local node id that wraps that knowledge source and
     replace the field with `origin.excerptFromNodeId`.
3. Write the rewritten state to `<id>/canvas.json` (preserve original
   `version` / `createdAt` / `updatedAt`).
4. Move `<workspace>/.history/<id>/thread-*.json` → `<id>/.history/chat/`
   and `intent_record.json` → `<id>/.history/intent.json`.

After all canvases processed, delete the now-empty `canvas/`, `sources/`,
`artifacts/`, `.history/` directories. If any non-empty leftover remains
(user-dropped files), keep that directory and log a warning.

**Idempotence**: each canvas-level step skips itself if
`<id>/canvas.json` already exists.

**Safety**: failure aborts startup with a clear error; partial new dirs
are harmless and will be re-attempted on next launch. **Users must back
up the workspace folder before upgrading** (called out in CHANGELOG and
startup log).

## 8. Export / Import

**Zip layout** (mirrors the canvas folder, with `manifest.json` at the
root):

```
manifest.json
canvas.json
nodes/<nodeId>.md
artifacts/<file>
memory/preferences.md
.history/...                  # included unless ?includeHistory=false
```

**Dependencies**: `archiver` (write), `yauzl` (read).

**Import**: extract to `os.tmpdir()/import-<uuid>/`, validate manifest,
allocate a new `canvasId`, rewrite `canvas.json.canvasId`, move the
extracted directory to `<workspace>/<newCanvasId>/`. No source dedup —
import always creates a new canvas.

## 9. Execution Plan (PR-by-PR)

### PR 0 — Prep

1. Audit `apps/server/package.json`; plan to add `archiver`, `yauzl`,
   and matching `@types/*`.
2. Sketch the `storage/` folder.
3. Run `pnpm typecheck` to capture a green baseline.

### PR 1 — `storage/` module (no callers wired)

4. `storage/io.ts`
5. `storage/frontmatter.ts` (extracted from the former `knowledge/file.repository.ts`)
6. `storage/paths.ts`
7. `storage/canvas-store.ts`
8. `storage/index.ts` (LRU cache, max 16)
9. `storage/__tests__/canvas-store.test.ts` against `os.tmpdir()`
10. `pnpm lint:fix && pnpm format && pnpm typecheck`

### PR 2 — Migration

11. `storage/migrate.ts` per §7
12. `storage/__tests__/migrate.test.ts` with fixtures for the old layout
13. Wire `runMigrationIfNeeded()` into `workspace.ts` → `setWorkspacePath()`
14. Cover the "workspace restored on startup" path in `app.ts`
15. Lint / format / typecheck

### PR 3 + PR 4 (combined, to avoid an unstable mid state) — Cut over canvas + preprocessing, delete `knowledge/`

16. `canvas.route.ts`: route everything through `getCanvasStore`;
    rewrite `stripManagedContent` / `hydrateNodeContent` to use
    `store.writeNode` / `store.readNode`; finish the empty
    `DELETE /:canvasId/nodes/:nodeId` handler.
17. Delete `apps/server/src/modules/canvas/canvas.filestore.ts`.
18. `preprocessing/index.ts`: dispatcher takes a `CanvasStore` per
    request (built from `request.canvasId`).
19. `preprocessing/stages/persist.ts`: `IKnowledgeRepository` →
    `CanvasStore`. No cross-canvas hash dedup.
20. `preprocessing/stages/normalize.ts`: derive `sourceId` from `nodeId`
    for now; rename the field to `nodeId` in PR 8.
21. `preprocessing/provider-manager.ts`: replace `getArtifactsDir()`
    with `store.artifactPath`.
22. `agent/tools/executor.ts`: 4 sites → `getCanvasStore(canvasId)`.
23. `web/web.route.ts`: stop writing to a global source; return
    normalised content for the frontend to feed into a node create.
24. Delete `apps/server/src/modules/knowledge/`. Move loaders
    (`web.loader` / `pdf.loader` / `text.loader` / `youtube.loader`) to
    `apps/server/src/modules/preprocessing/loaders/`.
25. Drop the `knowledge.route` registration in `app.ts`.
26. Lint / format / typecheck.

### PR 5 — Agent chat / intent

27. `agent/agent.route.ts`: `loadContext` / `saveContext` →
    `store.readChat` / `store.writeChat`. All `getArtifactsDir()`
    references take a `canvasId` (added to query/body where missing).
28. `agent/intent.route.ts` + `intent.service.ts`: `logIntentEpisode` →
    `store.upsertIntent`.
29. Delete `apps/server/src/modules/agent/store/`.
30. Lint / format / typecheck.

### PR 6 — Artifact route privatisation

31. `artifact/artifact.route.ts`: new URLs under `/api/canvas/:canvasId/artifact/...`.
32. `artifact/utils.ts`: replace constant `ARTIFACT_API_PREFIX` with a
    helper `artifactPrefix(canvasId)` (or have callers compose it).
33. Frontend artifact API + every reference (node upload, PDF cover, agent
    attachment) updated to include the canvas id.
34. Delete `getArtifactsDir` / `getCanvasDir` / `getSourcesDir` /
    `ensureWorkspaceDirs` from `workspace.ts`.
35. Lint / format / typecheck.

### PR 7 — Export / import to zip

36. `pnpm -F server add archiver yauzl @types/archiver @types/yauzl`
37. `GET /:canvasId/export`: stream the canvas folder via `archiver`,
    add `manifest.json`, content-type `application/zip`.
38. `POST /import`: handle multipart, extract via `yauzl`, validate
    manifest, rewrite `canvasId`, move into the workspace.
39. Drop the old `CanvasExportBundle` schema (sources / base64 artifacts).
40. Frontend `api/canvas.ts`: download blob → save; upload as `FormData`.
41. Lint / format / typecheck.

### PR 8 — Shared types & frontend cleanup

42. Update `packages/shared/src/types/*` per §6.
43. Resolve every TS error from removing `sourceId`.
44. Delete `apps/web/src/api/knowledge.ts` and the
    `pages/SourceListPage.tsx` page.
45. Remove the `components/Panels/DataSourcePanel/` folder (or rewrite
    it as "current canvas nodes" if still desired).
46. Update `handler/autoLayout/graphModel.ts` (and its tests) to follow
    `origin.excerptFromNodeId` instead of `origin.sourceId`.
47. Lint / format / typecheck.

### PR 9 — Documentation

48. Rewrite the affected design docs:
    - `docs/node_preprocessing_design.md`
    - `docs/agent-context.md`
    - `docs/user-guide/05-sources-and-knowledge.md`
    - `docs/user-guide/10-data-storage.md`
49. Add a CHANGELOG entry covering: new disk layout, removal of source
    sharing, artifact URL change, `.zip` export/import, automatic
    migration on first launch (with the explicit "back up first" note).
50. Refresh `/memories/repo/canvas-system-architecture.md`.

## 10. Frontend Impact

### 10.1 `apps/web/src/api/`

- Delete `knowledge.ts`.
- `artifact.ts`: every function gains a `canvasId` parameter; URLs
  resolve under `/api/canvas/:canvasId/artifact/...`. Drop the legacy
  absolute-URL fallback.
- `canvas.ts`: `exportCanvas` downloads a zip blob;
  `importCanvas(file: File)` uploads via `FormData`.
- `web.ts`: `getWebPreview({ canvasId, nodeId })` (no more `sourceId`).
- `agent.ts` / `intent.ts`: URLs unchanged; payloads carry canvas-scoped
  artifact URLs.

### 10.2 Pages

- Delete `pages/SourceListPage.tsx` and the route entry / nav link.
- `pages/CanvasListPage.tsx`: drop the `getSources()` call and the
  derived "used by N sources" label.

### 10.3 Components

- Delete `components/Panels/DataSourcePanel/` (or rewrite as a
  canvas-scoped node list).
- `components/Nodes/web/WebNode.tsx`: stop reading `data.sourceId`; call
  `getWebPreview({ canvasId, nodeId: node.id })`.
- `components/Panels/ChatPanel/ChatInput.tsx`: rename `originSourceId`
  to `originNodeId` for clarity (already used as a canvas node id).

### 10.4 Store (`store/canvasStore.ts`)

- Remove every read/write of `data.sourceId`.
- `getAgentContext()` no longer emits `sourceId`; if a stable identity
  is needed, use `node.id`.
- Node creation paths no longer expect a `sourceId` in preprocess
  responses; expect `nodeId` instead (after PR 8 rename).

### 10.5 Drag & drop

- `utils/io/dragDrop.ts`: drop the `library-source` payload (`{ sourceId }`)
  branch. There is no global library to drag from.
- PDF / image paste / drop still upload via the canvas-scoped artifact
  endpoint.

### 10.6 Auto-layout

- `handler/autoLayout/graphModel.ts`: remove the `nodeByDataSourceId`
  reverse lookup. Excerpt links use `origin.excerptFromNodeId` directly.
- Update `handler/autoLayout/__tests__/graphModel.test.ts`.

### 10.7 Tests

- Drop tests covering `SourceListPage` / `DataSourcePanel`.
- Update artifact-URL parsing tests to expect canvas-scoped URLs.
- Update graph-model test fixtures (`origin.excerptFromNodeId`).

## 11. User-Visible Behaviour Changes

| Change                             | What the user sees                                                                 |
| ---------------------------------- | ---------------------------------------------------------------------------------- |
| Same PDF dragged into two canvases | Now duplicated under each canvas's `artifacts/`; edits in one no longer propagate. |
| Global Source list page            | Removed. Browse content per canvas instead.                                        |
| Source-deletion cascade dialog     | Gone — deleting a node only affects its own canvas.                                |
| Export file extension              | `.sediment.json` → `.sediment.zip`.                                                |
| Import picker                      | Accept `.zip`.                                                                     |
| Artifact URLs                      | Now scoped: `/api/canvas/<id>/artifact/...`.                                       |
| First launch on new build          | Auto-migrates the old workspace. Users must back up first.                         |

## 12. Open Items / Risks

- Without a `_legacy_` archive, migration mistakes touch user data
  directly. The "back up the workspace before upgrading" guidance is
  the only safety net.
- Disk usage grows for users who relied on shared PDFs across canvases.
- Some agent tools / routes pass `canvasId` implicitly today; PR 5 / PR
  6 will surface any call sites that don't and need explicit propagation.
