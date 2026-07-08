# Node Write Unification — one writer per field (content / label / derived)

Status: Draft
Last updated: 2026-07-08

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

Phased so the critical save path is never half-migrated. **P0a is the actual
data-loss fix and ships alone** — deliberately decoupled from the endpoint merge
so a regression in the (larger) refactor can't block or obscure the bugfix.

1. **P0a — minimal CAS in persist (the bugfix, tens of lines).** Add the
   guard-ordered check (§3h: CAS → wouldClobber → dedup) before `writeNode` in
   [persist.ts](../../apps/server/src/modules/preprocessing/stages/persist.ts),
   for authored bodies (§3f), inside `withCanvasMutex` (§3g). Wire `expectRev`
   through the preprocess request contract. **This stops the clobber** without
   touching the endpoint shape. Independently shippable + testable.
2. **P0b — fold content-PUT semantics into the node-write endpoint.** Move
   strict-rename, synchronous `{rev,label}`, and the early fast-fail CAS onto the
   (renamed) `ingest-content` handler. Larger; not required for the bugfix.
3. **P1 — label endpoint.** Add `PUT /nodes/:id/label`; move user-rename off the
   content path onto it. Keep strict/lazy policy.
4. **P2 — client unification.** Rename `preprocessQueue` → `nodeIngestQueue`;
   absorb `nodeContentQueue`'s serialization / baseline / freeze / keepalive;
   route label renames to the direct label call. Delete `nodeContentQueue`.
5. **P3 — delete content PUT** and the `preprocess` endpoint name; update docs
   ([node-preprocessing.md](../architecture/node-preprocessing.md),
   [agent-node-freshness-cas-plan.md](./agent-node-freshness-cas-plan.md)).

Each phase ships behind its own tests; the app stays shippable between phases
(**P0a fixes the data-loss bug on its own**, before any endpoint merge).

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
