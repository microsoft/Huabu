# Canvas Action Log

> Status: Write path shipped; consumed by the memory curator, not the chat
> agent directly (see §3).
> Last updated: 2026-06-30
> Related: [agent-memory.md](./agent-memory.md) · [agent-context.md](./agent-context.md) · [canvas-storage.md](./canvas-storage.md)

A persistent, append-only trail of user actions on a canvas, stored as JSONL.
It gives the agent a long-term, queryable record of user behaviour for intent
inference — beyond the small in-memory window the client holds.

---

## 1. Design: JSONL stores facts

| Role                  | Form                                                    | Why                                                                                                              |
| --------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Persistent fact layer | **JSONL** at `<canvasId>/.history/events.jsonl`         | O(1) append, crash-localised at the line boundary, easy to roll/archive, consistent with the rest of `.history/` |
| Per-line record       | `{ ts: number, payload: RecentAction }` (`CanvasEvent`) | a timestamp + the same `RecentAction` shape the client already produces                                          |

The payload only stores a `NodeRef` (id/type/label/origin) — **no node content** — the same privacy boundary as the in-memory `recentActions`. Types: [`RecentAction`](../../packages/shared/src/types/agent/context.ts) · [`NodeRef`](../../packages/shared/src/types/agent/node-ref.ts).

---

## 2. Write path (shipped)

```
client gesture / undo / redo
  └─ eventBuffer accumulates RecentAction (apps/web/src/store/canvasStore/save/eventBuffer.ts)
        │ flush: piggy-backed on the 1s autosave debounce · immediate before an agent request · beforeunload keepalive
        ▼
POST /api/canvas/:canvasId/events   { events: CanvasEventRecord[] }   (≤ 64 KB body)
        ▼
CanvasStore.appendEvents()  → appendJsonLines → events.jsonl (one write(2), line-atomic)
```

- Storage IO: `appendJsonLine` / `appendJsonLines` / `readJsonLines` ([storage/io.ts](../../apps/server/src/modules/storage/io.ts)); malformed/crash partial lines are skipped.
- Store API: `appendEvent` / `appendEvents` / `readEvents(limit?)` (tail read), [canvas-store.ts](../../apps/server/src/modules/storage/canvas-store.ts).
- Routes: `POST /api/canvas/:id/events` (write) + `GET /api/canvas/:id/events` (read, `limit`/`since`); wire types [canvas-events.ts](../../packages/shared/src/types/api/canvas-events.ts).
- Frontend API: [api/canvasEvents.ts](../../apps/web/src/api/canvasEvents.ts) `postCanvasEvents` / `getCanvasEvents`.
- The same POST also drives the memory op-counter (weighted by `events.length`; see [agent-memory.md §2.1](./agent-memory.md)).

---

## 3. Consumption: the memory curator

The agent does **not** consume the raw action log directly. The background **memory curator** periodically (op-counter triggered) reads an events digest and distils it into long-term memory:

- [memory/analyzer.ts](../../apps/server/src/modules/agent/memory/analyzer.ts) `readEventsDigest(canvasId)` (up to `MAX_EVENTS_IN_DIGEST = 100`) is fed to the curator LLM alongside the chat digest + intent-episode digest.
- The curator distils it into `<canvas>/.memory/space.md`; the chat agent then `read("memory/space.md")` on demand.

So: **raw log → curator distils → long-term memory → agent reads memory**. Cheaper on tokens and higher signal than injecting a raw action table every turn. See [agent-memory.md](./agent-memory.md).

`GET /api/canvas/:id/events` is still available (frontend / debugging) but is not part of the agent tool set.

---

## 4. Loose ends

- The single `events.jsonl` has no rolling archive yet (the planned 5 MB threshold was never implemented); not a problem at current sizes.
- `memory/journal.md` (a periodic human-readable LLM journal) was never built; kept as an optional future direction.
