# Node Write Unification — one writer per field (content / label / derived)

Status: Shipped (P0a / P0.5 / P0.6 done; P1 + endpoint merge deferred as non-essential). Durable facts folded into `docs/architecture/{canvas-storage,node-preprocessing,canvas-realtime-sync}.md`.
Last updated: 2026-07-09

> **Archived.** This plan shipped (P0a / P0.5 / P0.6). The lasting design now
> lives in `docs/architecture/canvas-storage.md` §4 (write coordinator),
> `docs/architecture/node-preprocessing.md` §3–§4 (`bodyOwnership` CAS +
> settle trigger), and `docs/architecture/canvas-realtime-sync.md` (baseline
> rebase). Kept here as read-only history; do not treat as current.

> **Why this exists.** A user edited a note's `.md` externally (Google-Drive
> folder), then edited the same node in-app. The app showed a
> `NODE_CONTENT_CONFLICT` toast **but the on-disk file had already been
> overwritten with the in-app version** — before the user chose anything. Root
> cause: the node's markdown body has **two independent writers**, and only one
> of them enforces the rev-CAS. This plan removes the second writer and
> collapses node persistence to **one authoritative writer per field**.

---

## 0. Problem

A node's `nodes/<safe(label)>.md` sidecar is written by **two** server paths
today:

| Path                                                                                                                                          | Trigger                             | CAS?                     | Writes                          |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ------------------------ | ------------------------------- |
| Content PUT — `PUT /:canvasId/nodes/:nodeId/content` ([canvas.route.ts](../../apps/server/src/modules/canvas/canvas.route.ts))                | in-app editor edit (0.5 s debounce) | ✅ `expectRev` (rev-CAS) | body + label + summary/keywords |
| Preprocess persist — `POST /:canvasId/nodes/:nodeId/preprocess` ([persist.ts](../../apps/server/src/modules/preprocessing/stages/persist.ts)) | same edit (1 s debounce)            | ❌ none                  | body + label + summary/keywords |

Both fire for the **same** edit, both carry the client's in-app content
snapshot. When the on-disk body has diverged (another tab/device, an external
editor, or a Drive-synced copy):

- the **content PUT** correctly 409s (`NODE_CONTENT_CONFLICT`) and freezes the
  node — nothing written;
- the **preprocess persist** has no CAS, so `store.writeNode({ content })`
  lands and **silently clobbers** the newer on-disk body.

So the toast and the clobber happen together: one path refuses, the other
already wrote. A band-aid (make preprocess skip note/text bodies on divergence)
plugs the leak but leaves the deeper smell: **two writers of the same bytes at
two cadences with two different concurrency guarantees.**

### What is already clean (don't regress it)

- **Label ownership** is already single-source via
  [`isLabelProtected`](../../apps/server/src/modules/preprocessing/label-policy.ts):
  a `user` / `agent` label is never overwritten by auto-derivation (the
  `generate_label` stage is dropped from the plan). Auto labels are
  preprocess's job only when the user hasn't named the node.
- **rev-CAS primitive** (`nodeRevision` / `nodeRevisionOf`,
  [change.ts](../../packages/shared/src/canvas-engine/change.ts)) is shared,
  deterministic, and already used by the agent executor (see
  [agent-node-freshness-cas-plan.md](./agent-node-freshness-cas-plan.md)) and
  the content PUT.

---

## 1. Target model — one writer per field

```
             ┌────────── label (user rename) ──────────┐
 client ───► │  PUT /nodes/:id/label   (direct, await)  │──► filename + frontmatter
             └──────────────────────────────────────────┘
             ┌────────── content (body) ───────────────┐
 editor ───► │  node-write endpoint (CAS + serialized)  │──► body  ──► async: derive
   src   ───►│  (absorbs today's content PUT semantics) │       summary/keywords/auto-label
             └──────────────────────────────────────────┘
```

| Field                                 | Sole writer                              | Concurrency                                                       |
| ------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------- |
| `label` (user / agent rename)         | **label endpoint** (new)                 | synchronous, strict-rename 409                                    |
| body (`note`/`text` typed)            | **node-write endpoint** (was preprocess) | rev-CAS + per-node serialized (profile `bodyOwnership: authored`) |
| body (`web`/`pdf`/`office` extracted) | node-write endpoint (extract path)       | **no CAS** — read-only (profile `bodyOwnership: derived`)         |
| `summary` / `keywords` / auto `label` | node-write endpoint (derive stage)       | idempotent, gated by `isLabelProtected`                           |

The **content PUT endpoint is deleted**; its rev-CAS, per-node serialization,
synchronous confirmation (returns `rev`), and strict-rename collision are
**absorbed** into the node-write endpoint. Result: exactly one path writes the
body, and it always enforces CAS.

### Why routing the body through the (renamed) preprocess path is safe

The frequency-coupling objection ("don't run the LLM on every keystroke") does
**not** apply: per
[profiles.ts](../../apps/server/src/modules/preprocessing/profiles.ts), `note`
and `text` have **no** `generate_label` / `generate_summary` /
`generate_keywords` capability — their pipeline is `resolve_title` (a cheap
heuristic) + persist, no LLM, no network. The LLM stages exist only on
`web`/`pdf`/`office`, whose bodies are **extraction-triggered (src change), not
keystroke-triggered**. So a typed save never triggers an LLM call.

---

## 2. Endpoint naming — kill "preprocess"

`preprocess` is a poor client-facing name once this endpoint is the
authoritative node write. But `content` is also too narrow: the request carries
**more than a body** (also `src`) and has **side effects** (CAS gate; triggers
extraction / enrichment / title derivation). The best-fitting term is the one
the codebase already uses for exactly this — **ingestion** (`NodeIngestionInfo`,
`ingestionByNodeId`, `setNodeIngestion`): take a node's authored inputs in and
process them.

| Name                                           | Reads as                                            | Notes                                                                                              |
| ---------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| **`POST …/nodes/:id/ingest-content`** (chosen) | "ingest this node's content (+ src) and process it" | Matches existing ingestion vocab; the explicit `-content` segment makes it obvious at a call site. |
| `POST …/nodes/:id/ingest`                      | "ingest node"                                       | Shorter; relies on the reader knowing `ingest` = content + src + process.                          |
| `PUT …/nodes/:id/content`                      | "save node content"                                 | Undersells it — hides the `src` write and the derivation side effects.                             |

**Decision:** `POST /:canvasId/nodes/:nodeId/ingest-content`. It names the whole
operation honestly (persist authored `content` / `src` under CAS, then run the
processing pipeline as a server-side consequence), reuses the established
`ingest` / `ingestion` domain word, and the explicit `-content` segment reads
clearly at the call site — retiring both the misleading `preprocess` and the
too-narrow `content` names. The client queue (`preprocessQueue`) becomes
`nodeIngestQueue`.

---

## 3. Save semantics to absorb (design detail)

### 3a. rev-CAS — check twice

Applies to **editor-authored bodies only** (`note` / `text`). Extracted bodies
(`web` / `pdf` / `office`) are read-only in-app and carry no `expectRev` — see
§7 Decided.

- **Early (fast-fail, optimization):** at the top of the node-write handler,
  compare `expectRev` against the on-disk rev; if diverged, 409 immediately and
  skip the (possibly expensive) extract/enrich pipeline.
- **At persist (authoritative, required):** re-check right before
  `store.writeNode`. The pipeline can take seconds (LLM); the disk can change
  during it. The early check does **not** cover that TOCTOU window — the persist
  check is the correctness boundary. Both checks use the same
  `nodeRevisionOf({ content, src })`.

### 3b. Per-node serialization

The node-write path must serialize per node (at most one in-flight write per
`nodeId`, applied in submission order) so a slower older write can't land after
a newer one. Today `nodeContentQueue` serializes; `preprocessQueue` explicitly
does **not** ("a race only wastes a request"). The unified queue must adopt the
serialized-chain behaviour for the **body-save** path. Serialization also keeps
the CAS baseline advancing cleanly (each success returns the new `rev`; the next
write uses it) so a client never 409s against its own prior write.

### 3c. Synchronous confirmation

The node-write endpoint returns `{ rev, label }` (as the content PUT does now).
The client updates its per-node baseline from the response — **co-delivered with
the write it confirms** — so content and its CAS baseline never diverge (false
conflicts become structurally impossible; see
[agent-node-freshness-cas-plan.md](./agent-node-freshness-cas-plan.md) §Phase 3).

### 3d. Two cadences, one queue

The unified queue keys per node and picks a debounce by trigger, so the two
rhythms stay decoupled:

- `note`/`text` **body** typed → fast (~0.5 s), serialized, CAS, confirmed.
- `web`/`pdf`/`office` **body** src-changed → extract + LLM on the existing
  slower (~1 s) cadence; not keystroke-driven.

### 3e. Label endpoint (no client queue)

Rename is discrete, user-initiated, and must be **awaited** (to surface a
`NODE_LABEL_CONFLICT` and revert the optimistic name). So the client calls the
label endpoint **directly** — no debounce queue — mirroring today's
`tryRename` → `flushNow` behaviour ([canvasStore.ts](../../apps/web/src/store/canvasStore.ts)).
Strict vs lazy rename policy (user = strict 409, agent/auto = ` (N)` dedupe) is
preserved via `labelSource` + `writeNode({ strictRename })`.

**Auto-derived label — settle-triggered (SHIPPED, the label-churn fix).**
`note`/`text` titles auto-derive from the first heading/line inside the
preprocess pipeline. The churn — renaming the `.md` through every partial
heading (`Note 1.md` → `H.md` → `He.md` → …; see §10) — came from firing
preprocess on **every ~1 s typing pause**. The shipped fix moves the trigger to
a **settle** boundary (the user leaving the editor), so preprocess (and the
rename it drives) fires once per edit session, not per keystroke pause:

- `note` (edited only in the expanded panel): settled on `closeExpanded` /
  `openExpanded` ([canvasStore.ts](../../apps/web/src/store/canvasStore.ts)).
- `text` (inline textarea): settled on `TextNode`'s blur handler
  ([TextNode.tsx](../../apps/web/src/components/Nodes/text/TextNode.tsx)).

The body keeps saving on the fast per-node content cadence (`nodeContentQueue`)
independently, and the `beforeunload` keepalive flushes a pending settle on
close. New nodes are created with a stable placeholder label (`Note 1`,
`Text 1`, … via `generateNextLabel`
[labels.ts](../../packages/shared/src/canvas-engine/utils/labels.ts)), so the
sidecar lives at `nodes/Note 1.md` from creation and is renamed to the
heading-derived name at the first settle.

**No "sticky" freeze (NOT implemented — deferred).** The filename is **not**
frozen after first commit: whenever the heading/first line changes and the user
settles, the file is renamed to stay consistent with it. The accepted behaviour
is **"label follows the heading/first line."** A one-time "sticky slug" (name
once, then never auto-rename) was considered but deferred; note that the actual
rename flows through the preprocess `project` stage → client patch → the content
PUT — **none of which gate on a settled flag** — so a real sticky implementation
would have to gate `project` (not just `persist`) and the content-PUT rename,
not the persist stage alone. See §5.

### 3f. Profile-driven CAS policy (declarative, not hardcoded)

Whether a node type's body is CAS-guarded must **not** be hardcoded as
`if (type === 'note' || type === 'text')` in the ingest handler. Instead, add a
field to `NodePreprocessProfile`
([types.ts](../../apps/server/src/modules/preprocessing/types.ts)) — the same
declarative registry that already drives `capabilities` / `watchFields`:

```ts
interface NodePreprocessProfile {
  // … existing fields
  /**
   * Who authors the node body:
   *  - 'authored' → user-editable in-app; the ingest write is rev-CAS-guarded
   *    (a concurrent edit must not clobber the user's body).
   *  - 'derived'  → produced by the pipeline (extraction), read-only in-app;
   *    no CAS (last-extraction-wins).
   * REQUIRED for every profile with a `contentKind` — no default. A missing
   * value is a type error, so a new editable type can't silently ship without
   * CAS (fail-safe: forgetting the flag fails the build, not the user's data).
   */
  bodyOwnership: 'authored' | 'derived';
}
```

- `note` / `text` → `bodyOwnership: 'authored'` → ingest enforces rev-CAS.
- `web` / `pdf` / `office` → `bodyOwnership: 'derived'` → no CAS.

The ingest handler reads the CAS decision **purely** from
`getProfile(nodeType).bodyOwnership`. So if a type becomes editable later (e.g.
an editable web excerpt), it is a **one-line profile flip** — the CAS/write logic
never changes. Single source of truth, consistent with how the rest of the
pipeline is already configured. (`resolve_title` staying consistent with the
body, per §4, likewise keys off the same profile.)

### 3g. Cross-writer safety — `withCanvasMutex` around the sync critical section

> **✅ Shipped as P0.6 (§5), with two deviations from the sketch below:** the
> lock lives in `storage/write-coordinator.ts` (not the executor); the executor
> still holds it for its **whole batch** (incl. async image-normalize), not only
> the sync write — see the §5 P0.6 side-effect note. The `apply(current)` policy
> supersedes the inline `isLabelProtected` snippet here.

A node's `nodes/<safe(label)>.md` has **three** writers — `ingest-content` (body

- derived label), the **label endpoint** (rename → changes the _filename_), and
  the **executor** (agent writes). They must not corrupt each other. Two hazards:

1. **Interleaving** a read-check-write with another writer (TOCTOU).
2. **Writing based on stale content** (a write that already happened before us).

`store.readNode` / `store.writeNode` are both **synchronous** (writeNode is
deliberately never async), so the critical section is a single **`await`-free**
block. That alone makes **ingest-vs-ingest** safe (the event loop can't switch
mid-block). But it is **not** enough against the **executor**: the executor's CAS
is a **pre-flight over the batch prestate** (`collectMergeConflicts` in
[canvas-executor.ts](../../apps/server/src/modules/canvas/canvas-executor.ts)),
and there are `await`s between that prestate hydration and its `writeNode` (agent
image-normalize). A concurrent ingest write to the same node during those awaits
is invisible to the executor's prestate-based CAS → **lost update**. So a
lock-free ingest is unsafe against the executor.

**Fix:** wrap **only the sync critical section** in the executor's existing
`withCanvasMutex(canvasId)` — the same lock the executor holds for its whole
batch. The expensive pipeline stays **outside** the lock:

```ts
const enriched = await runPipeline(snapshot); // async, OUTSIDE the lock

await withCanvasMutex(canvasId, () => {
  // sync body: no `await` inside → atomic; excludes the executor batch too
  const existing = store.readNode(nodeId); // one read (CAS + label + dedup)
  if (bodyOwnership === 'authored' && expectRev !== nodeRevisionOf(existing)) {
    return conflict; // CAS: stale baseline → 409, no clobber
  }
  if (isLabelProtected(existing?.labelSource, existing?.label)) {
    /* keep the user's label — read from current on-disk state, not the snapshot */
  }
  store.writeNode(nodeId /* body/label from `enriched` */);
});
```

- The lock is held **only** for the sync write, so it never blocks enrichment:
  editing note A cannot stall pdf B's (lock-free) extraction/LLM — only B's final
  sync write briefly takes the lock. The executor's batch is likewise short (no
  LLM inside the mutex), so ingest waits at most that long.
- Inside the lock the read-check-write is atomic **and** mutually exclusive with
  the executor batch, closing the lost-update window. CAS still catches a write
  that landed _before_ this section; the current-on-disk `labelSource` read
  inside the lock subsumes the label-protection race.

> Granularity note: `withCanvasMutex` is per-canvas, coarser than per-node. Since
> it wraps only the sync `.md` write (microseconds) and the executor holds it
> only for a short LLM-free batch, contention is negligible — reusing the
> existing mutex beats introducing a per-node lock table. Revisit only if
> profiling shows write contention.

### 3h. Guard ordering inside the critical section (CAS → wouldClobber → dedup)

The persist stage already has two content guards ([persist.ts](../../apps/server/src/modules/preprocessing/stages/persist.ts)):
`wouldClobber` (refuse to wipe a non-empty body with an empty one) and a
content-equality **dedup** (skip the body rewrite when unchanged, only refresh
`label` / `mhtml`). The new CAS must compose with them in a fixed order, all
reusing the single `existing = readNode` read:

1. **CAS** (outermost gate, authored bodies only): `expectRev !== nodeRevisionOf(existing)`
   → 409. If the baseline is wrong, nothing else runs — no dedup, no write.
2. **wouldClobber**: incoming empty body + existing non-empty → keep existing.
3. **dedup**: `existing.content === canonicalContent` → skip body write; still
   refresh `label` / `mhtml` (respecting `isLabelProtected`).
4. **writeNode**.

CAS is the outermost check because dedup/wouldClobber are content-**value**
guards that only make sense once the write is confirmed to descend from the
current on-disk baseline.

---

## 4. Consistency guarantee (title ↔ body)

Because the derived title (`resolve_title`) runs **inside the node-write path,
from the body just persisted** (not from a separately-debounced stale snapshot),
`(body, title)` are consistent by construction. This removes the transient
"fresh body + stale-derived title" mismatch that a naïve two-endpoint split
would allow.

---

## 5. Migration plan

Status reflects what has shipped. The **data-loss fix** and the **label-churn
fix** are independent and each shippable alone; the endpoint merge is deferred
(no longer necessary — see below).

1. **P0a — authored-body CAS guard (the data-loss fix). ✅ Done.**
   [persist.ts](../../apps/server/src/modules/preprocessing/stages/persist.ts)
   skips the whole persist when an `authored` body (`bodyOwnership: 'authored'`)
   has diverged from the snapshot, so the content PUT stays the **sole
   authoritative body writer** and the newer on-disk body is never clobbered.
   Covered by
   [persist.test.ts](../../apps/server/src/modules/preprocessing/stages/persist.test.ts).
   (The `bodyOwnership` profile flag of §3f also already shipped.)
2. **P0.5 — label-churn fix (settle trigger). ✅ Done.** The auto-derived
   `note`/`text` label (the `.md` filename) is committed **at a settle boundary**
   (the user leaving the editor) instead of on every keystroke pause. Only the
   client trigger moved; the server derivation path is unchanged:
   - **Client — settle-only trigger.**
     [postEffects.web.ts](../../apps/web/src/handler/canvasCommand/postEffects.web.ts)
     no longer fires `triggerPreprocessing` for `note`/`text` on every mutation.
     Instead `settleNodePreprocess`
     ([canvasStore.ts](../../apps/web/src/store/canvasStore.ts)) fires at the real
     edit-done boundaries: `closeExpanded` / `openExpanded` for a `note` (edited
     only in the expanded panel) and `TextNode`'s blur handler
     ([TextNode.tsx](../../apps/web/src/components/Nodes/text/TextNode.tsx)) for
     an inline `text`. The body keeps saving on the fast `nodeContentQueue`
     cadence independently, and the `beforeunload` keepalive flushes a pending
     settle on tab close.
   - **Behaviour:** the label follows the heading / first line and is renamed on
     each settle where it changed — mid-typing churn is gone, but there is **no
     "sticky" freeze** (see §3e). A one-time sticky slug is deferred; the accepted
     behaviour is "label follows the heading/first line."
   - **Background save-failure surfacing. ✅ Done.** The settle-driven preprocess
     and its content-PUT rename run on the `auto` cadence. A genuine (non-conflict)
     failure — where the rename **and** the body write both fail — is no longer
     console-only: [nodeContentQueue.ts](../../apps/web/src/store/canvasStore/save/nodeContentQueue.ts)
     `handleSaveFailure` now surfaces a persistent, dismissible toast with a
     **Retry** action (re-flushes the node's still-in-store body/label), throttled
     to once per node on the `auto` path until a save succeeds. Benign
     `NODE_CONTENT_CONFLICT` (409) stays silent-and-frozen as before.
3. **P0.6 — unified write coordinator. ✅ Done.** All durable node `.md` writes
   now funnel through one storage-layer coordinator
   ([write-coordinator.ts](../../apps/server/src/modules/storage/write-coordinator.ts)),
   so serialization + rev-CAS live in one place instead of being re-implemented
   per call site (§3g realized — **mechanism only**; field-ownership policy stays
   in each caller's `apply`):
   - **`withCanvasMutex`** (the per-canvas write lock) was lifted out of the
     executor into the coordinator so **every** writer shares one lock.
   - **`updateNode(store, id, { expectRev?, apply, strictRename? })`** — locking:
     `read → rev-CAS → apply(current) → writeNode`, atomic under the lock. Used by
     the **content PUT** ([canvas.route.ts](../../apps/server/src/modules/canvas/canvas.route.ts),
     its hand-written rev-CAS branch deleted) and **preprocess persist**
     ([persist.ts](../../apps/server/src/modules/preprocessing/stages/persist.ts),
     now `async`; **P0a survives as its `apply` field-ownership policy**, not a
     bespoke top-level skip — the lock stops interleaving but does NOT stop a
     stale-snapshot write, so the authored-body guard is still required).
   - **`applyNodeUpdate(...)`** — the same core WITHOUT the lock, for writers
     already inside the canvas lock. Used by the **executor**
     ([canvas-executor.ts](../../apps/server/src/modules/canvas/canvas-executor.ts)),
     whose whole batch already holds `withCanvasMutex` (a re-entrant `updateNode`
     would deadlock).

   Net: content-PUT / preprocess / executor can no longer interleave on a node's
   `.md`, so the double-rename race (the `Node rename failed` 500) is structurally
   closed. Covered by
   [write-coordinator.test.ts](../../apps/server/src/modules/storage/__tests__/write-coordinator.test.ts)
   plus the content-CAS / executor / persist suites.

   > **Side effect (known):** node writes to a canvas now serialize on the
   > per-canvas lock, and the executor holds it for its **whole batch** — which
   > includes **async image-geometry normalization**. So a user content-save (or
   > a preprocess write) can wait for an in-flight agent batch before landing.
   > Short in the common case (sync writes), but not bounded while an agent batch
   > normalizes images. Acceptable for correctness; revisit by narrowing the
   > executor's lock to only its sync writes (§3g's "lock only the sync critical
   > section") if save latency during heavy agent activity is observed.

4. **P1 (optional) — rename-only label endpoint.** `PUT /nodes/:id/label` to give
   user rename a strict-CAS home separate from the body's rev-CAS (§3e). **Not
   required:** user rename already works correctly via the content PUT's
   `flushNow`. Defer until the label-CAS / body-CAS split is worth a new endpoint.
5. **Deferred — endpoint merge / rename (§1, §2).** Folding content PUT +
   preprocess into a single `ingest-content` endpoint is **no longer necessary**:
   the **write coordinator (P0.6)** already realizes "one authoritative writer" at
   the **storage layer** — every writer funnels through `updateNode` /
   `applyNodeUpdate` — so the HTTP endpoints can stay separate. "One writer" means
   one write chokepoint, not one endpoint. Revisit the merge only if the separate
   endpoints prove confusing.

---

## 6. Testing

- **Server (node-write CAS):** stale `expectRev` → 409 (no write); matching →
  ok + new `rev`; create-race (empty rev vs existing) → 409; label-only change
  doesn't 409; external-edit divergence → 409 (no clobber) — the exact repro
  that motivated this plan.
- **Server (early vs persist CAS):** disk changed mid-pipeline → persist-stage
  409 even though the early check passed.
- **Server (guard ordering §3h):** CAS runs before dedup/wouldClobber (a stale
  `expectRev` on unchanged content still 409s, not a silent dedup-skip); empty
  body doesn't wipe a non-empty on-disk body.
- **Label endpoint:** strict-rename collision → `NODE_LABEL_CONFLICT`; agent
  label → ` (N)` dedupe.
- **Cross-writer safety (§3g):** an agent batch whose prestate CAS passed, but
  where a user ingest wrote the same node during the batch's awaits, does **not**
  lose the user's write (both take `withCanvasMutex`, so they can't interleave);
  a stale in-flight ingest does not override a fresh user rename (derived-label
  write reads current on-disk `labelSource` inside the lock).
- **Client (unified queue):** baseline seeded on load / agent-sync; advanced on
  success; conflict freezes the node (no further PUT from debounce / keepalive);
  serialized writes apply in order; rename awaits + reverts on 409.

---

## 7. Risks & open questions

- **Critical-path refactor.** This rewrites the save path. Mitigation: phased,
  each phase tested, P0 shippable alone.
- **Async enrich return channel.** `ingest-content` returns `{rev,label}` for the
  body write; for `web`/`pdf` the slower `summary`/`keywords` land afterwards via
  the existing sync/broadcast path (same as today's preprocess result). No fast
  typing path ever triggers an LLM (note/text have no enrich capability;
  artifact enrich is `src`-triggered), so there is **no** "LLM on every
  keystroke" cadence to defend against.

### Decided

- **`web`/`pdf`/`office` extracted bodies need no rev-CAS.** These bodies are
  **read-only** in-app (`web`/`pdf`/`office` render via the read-only
  [`MilkdownPreview`](../../apps/web/src/components/Milkdown/MilkdownPreview.tsx),
  not the editable
  [`MilkdownEditor`](../../apps/web/src/components/Milkdown/MilkdownEditor.tsx)),
  so there is no user hand-edit to protect against clobbering. The only writers
  are re-extraction (idempotent for a given `src` → last-extraction-wins is
  fine) and the agent (which already CASes via the executor). rev-CAS on the
  node-write path therefore applies **only to editor-authored bodies**
  (`note` / `text`). This is encoded declaratively via the profile's
  `bodyOwnership` flag (§3f), not hardcoded — so flipping a type to editable
  later turns on CAS with no logic change.

---

## 8. Code entry points

| File / dir                                                                                                               | Role in this plan                                                                     |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| [apps/server/src/modules/canvas/canvas.route.ts](../../apps/server/src/modules/canvas/canvas.route.ts)                   | Content PUT (to delete) + preprocess POST (to become node-write) + new label endpoint |
| [apps/server/src/modules/preprocessing/stages/persist.ts](../../apps/server/src/modules/preprocessing/stages/persist.ts) | Persist stage — add authoritative rev-CAS before `writeNode`                          |
| [apps/server/src/modules/canvas/canvas-executor.ts](../../apps/server/src/modules/canvas/canvas-executor.ts)             | Reference for `withCanvasMutex` (batch/canvas.json only) + agent-write CAS (§3g)      |
| [apps/server/src/modules/preprocessing/dispatcher.ts](../../apps/server/src/modules/preprocessing/dispatcher.ts)         | Add early fast-fail CAS; keep `isLabelProtected` plan-pruning                         |
| [apps/server/src/modules/preprocessing/label-policy.ts](../../apps/server/src/modules/preprocessing/label-policy.ts)     | Single source of label ownership (unchanged)                                          |
| [apps/server/src/modules/preprocessing/profiles.ts](../../apps/server/src/modules/preprocessing/profiles.ts)             | Per-type capabilities (note/text = no LLM) + new `bodyOwnership` flag                 |
| [apps/server/src/modules/preprocessing/types.ts](../../apps/server/src/modules/preprocessing/types.ts)                   | `NodePreprocessProfile` — add `bodyOwnership?: 'authored' \| 'derived'`               |
| [packages/shared/src/types/api/canvas.ts](../../packages/shared/src/types/api/canvas.ts)                                 | Wire contracts: node-write body (`expectRev`), `rev`, label endpoint, error codes     |
| [packages/shared/src/canvas-engine/change.ts](../../packages/shared/src/canvas-engine/change.ts)                         | `nodeRevision` / `nodeRevisionOf` (CAS primitive)                                     |
| [apps/web/src/store/canvasStore/save/preprocessQueue.ts](../../apps/web/src/store/canvasStore/save/preprocessQueue.ts)   | → `nodeIngestQueue`; absorbs serialization / baseline / freeze / keepalive            |
| [apps/web/src/store/canvasStore/save/nodeContentQueue.ts](../../apps/web/src/store/canvasStore/save/nodeContentQueue.ts) | To delete after P2 (semantics migrated)                                               |
| [apps/web/src/store/canvasStore.ts](../../apps/web/src/store/canvasStore.ts)                                             | `tryRename` → direct label call; wire the unified queue                               |

---

## 9. Related

- [agent-node-freshness-cas-plan.md](./agent-node-freshness-cas-plan.md) — the
  `nodeRevision` CAS primitive and the agent/executor + web content-PUT write
  paths this plan unifies.
- [node-preprocessing.md](../architecture/node-preprocessing.md) — current
  6-stage pipeline this plan turns into the single node-write path.

---

## 10. Appendix — label-commit cadence (current implementation)

Findings from tracing how a node's `label` (which **is** the on-disk filename
`nodes/<safe(label)>.md`) gets committed today. Two paths, very different
cadences:

| Path                          | Trigger                                                                                                                                                           | Cadence                                                                          | `labelSource` |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------- |
| **User explicit rename**      | rename UI → `tryRename` ([canvasStore.ts](../../apps/web/src/store/canvasStore.ts)) → `updateNodeData({label, labelSource:'user'})` → `nodeContentQueue.flushNow` | **immediate, single commit, strict** (0 ms; awaits the 409)                      | `user`        |
| **Auto-extract from heading** | typing → `updateNodeData({content})` → `UPDATE_NODE_DATA` → web post-effects → `preprocessQueue.schedule` → `resolve_title` → persist writes `label`              | **1 s debounce** (`PREPROCESS_DEBOUNCE_MS`), but **fires on every typing pause** | `auto`        |

**Why the auto path feels high-frequency.** The debounce resets on each
keystroke, so preprocessing fires ~1 s after typing _pauses_ — not per
keystroke. But while composing a heading a user pauses several times, and each
pause re-derives the title from the **partial** heading and rewrites `label` →
which **renames the `.md` file** (`H.md` → `He.md` → `Hea.md` → …). So a single
heading can churn the filename many times: bad for Drive sync (a burst of file
renames + possible conflicted copies), for anything referencing the file by
path, and for undo/history noise. The body save (`NODE_CONTENT_DEBOUNCE_MS` =
0.5 s, same file, cheap) is fine at that cadence; the **label/filename** is not.

**P0a does not address this — P0.5 does.** The persist CAS guard only stops the
body _clobber_; in the normal typing case the on-disk body matches the snapshot,
so before P0.5 the dedup branch still refreshed the drifting auto-label on every
pause. The churn is now fixed by the **settle trigger** shipped in **P0.5** (see
§5): preprocess for `note`/`text` fires when the user leaves the editor, not on
every typing pause.

**What P0.5 shipped (and did not).** Decouple the two cadences: the body save
stays fast, but the auto-derived label (filename) is committed **only at a settle
boundary** — the real edit-done points: `closeExpanded` / `openExpanded` for a
`note` and `TextNode`'s blur handler for an inline `text` (not a
`NodeWrapper.onBlur`, which sits on the read-only card). New nodes already live at
a stable `Note N` name (`generateNextLabel`), renamed to the heading-derived name
at settle. There is **no sticky freeze**: the label follows the heading / first
line and is renamed on each settle where it changed. A one-time sticky slug and
surfacing background (`auto`) save failures are both open follow-ups (see §5).
