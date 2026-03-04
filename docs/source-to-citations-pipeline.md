# Canvas Source Selection Ingestion Context Injection (v1 Implemented) and Record-level Citations (Planned)

> This document reflects the current code implementation (as of 2026-02-10).
>
> **Implemented:** Canvas selection node-level ingestion & storage Chat injects SELECTED SOURCES context SSE (update/end/error) frontend rendering.
>
> **Not yet implemented (planned):** Record-level citation tokens, `citations` SSE event, frontend token parsing and click-to-locate.

---

## 1) Terminology & Identifiers (Current Implementation)

- **nodeId** Canvas node ID (`id` field of a ReactFlow Node).
- **sourceId** `sources.source_id` in the knowledge DB; identifies a single source record.
- **Revision** Used only for editable sources (note/text); stored in `source_revisions`.
- **revisionId** `source_revisions.revision_id`; represents a content snapshot.

### Where do IDs appear?

- `canvasId / canvasVersion / selectedNodeIds`
  - Transport: Chat request body (`SendMessageRequest`).
  - Purpose: Backend looks up the `sourceIds` for the selected nodes via `canvas_nodes` and validates version consistency.

- `sourceId`
  - Storage: `sources.source_id` in `knowledge.sqlite`.
  - Transport: Not emitted as a citation token in model responses in the current implementation; used only for backend context construction.

### sourceId Generation (Decoupled from nodeId)

Implementation in `apps/server/src/modules/knowledge/utils.ts`:

- Note/Text: `src_${uuid}` (UUID for editable content)
- Web: `src_${sha256(workspaceId + normalizedUrl)}` (truncated to 16 hex chars)
- PDF: `src_${sha256(workspaceId + fileHash)}` (`fileHash` currently uses the `contentHash` of extracted text, not the raw file bytes hash)

---

## 2) Implemented Flow (v1)

### Link A Canvas Save/Load + Selection (Web Client)

#### Chat request carries selection

The frontend sends the following with each chat request:

- `canvasId`
- `canvasVersion`
- `selectedNodeIds` (collected from `node.selected` in the current canvas)

#### Canvas server-side persistence (authoritative state + optimistic locking)

Backend endpoints:

- `GET /canvas/:canvasId` `{ canvasId, version, state }`
- `PUT /canvas/:canvasId` (body: `{ version, state, workspaceId?, title? }`)
  - Returns `409` if `version` does not match (response includes `serverVersion`)
  - On success: `version = version + 1`

Note: In the current implementation, `PUT /canvas/:canvasId` only persists `state_json`; the node-to-source mapping is maintained separately.

### Link B Node-level Ingestion & Storage (Server)

#### Node ingestion API (maintains nodeId sourceId mapping)

Backend endpoints:

- `PUT /canvas/:canvasId/nodes/:nodeId`
  - body: `{ workspaceId?, type: 'note'|'text'|'web'|'pdf', title?, content?, src? }`
  - Behaviour: Ingests the node and upserts `canvas_nodes(canvas_id, node_id, source_id)`
  - Returns: `{ nodeId, sourceId, success, suggestedLabel?, error? }`

- `DELETE /canvas/:canvasId/nodes/:nodeId`
  - Behaviour: Removes the `canvas_nodes` mapping (does not delete the source from the knowledge DB)

Frontend trigger points (core logic in `apps/web/src/utils/ingestHelper.ts`):

- **New node:** Triggers `upsertNode()` after `addNode()`.
- **Node update:** Triggers `upsertNode()` when `data.content` (note/text) or `data.src` (web/pdf) changes.
- **Node deletion:** Triggers `DELETE /canvas/:canvasId/nodes/:nodeId`.

#### canvas_nodes table (current schema)

The table only maintains the mapping:

- `canvas_nodes(canvas_id, node_id, source_id)`, primary key `(canvas_id, node_id)`

Note: The current implementation does not store `type` / `data_json` in `canvas_nodes`; node content is written directly to the knowledge DB during ingestion.

#### Knowledge DB (`knowledge.sqlite`)

Location: `apps/server/data/knowledge.sqlite`

Table structure (v1):

- `sources`
  - `type`: `web | pdf | note | text`
  - `content_text`: Full content text (NOT NULL)

- `source_revisions` (note/text only)
  - A new revision row is inserted whenever the content hash changes.

#### Web / PDF Ingestion Details

- **Web:**
  - Prefers `content` sent from the frontend if provided.
  - Otherwise the backend fetches via the Tavily Extract API.
  - Requires environment variable: `TAVILY_API_KEY`
  - Optional config: `SEDIMENT_TAVILY_EXTRACT_DEPTH`, `SEDIMENT_TAVILY_EXTRACT_FORMAT`

- **PDF:**
  - Frontend passes an `artifactUri` in `data.src`.
  - Backend reads the file from the artifact store and extracts text with `pdf-parse`.
  - On parse failure a placeholder source is written (`sources.meta_json.placeholder=true`, with `ingestError`).

### Link C Retrieval (v1: Direct Selected-Source Injection)

The current implementation has no vector search or chunking. Chat simply injects the selected source records (truncated) into the system prompt.

Context builder behaviour (`apps/server/src/modules/knowledge/context-builder.ts`):

- Input: `sourceIds: string[]`
- note/text: Takes the latest `source_revisions` as content, including `revisionId`.
- web/pdf: Takes the current `sources` content.
- Each record is capped at 10k characters (excess is followed by `[Content truncated]`).

Injected format (conceptual example):

```text
## SELECTED SOURCES

- sourceId: src_xxx
  type: note
  title: ...
  revisionId: rev_xxx
  content: |
    ...
```

---

## 3) Chat SSE Protocol (Current Implementation)

The backend `/chat` endpoint streams manually via SSE:

- `event: update` - Incremental UI update (assistant token stream, tool output, meta(threadId), etc.)
- `event: end` - Stream complete
- `event: error` - Error occurred

Note: There is no `event: citations` in the current implementation.

---

## 4) Not Yet Implemented (Planned, Not Current Behaviour)

The following are planned but not yet implemented:

### Link C2 Chunking / Vector Retrieval (TODO)

- Goal: Split `sources` content into chunks and build a vector index; replace / augment direct source injection with retrieved chunks.
- Expected change: Chat flow moves from "selected sources -> direct injection" to "selected sources -> chunking/index -> retrieval -> inject top-k chunks".
- Open design questions:
  - Chunking strategy (by token / paragraph / heading level), chunk metadata (sourceId, revisionId, offset, etc.)
  - Index lifecycle (incremental update per revision vs full rebuild)
  - Filter scope (search only within the sourceIds corresponding to selectedNodeIds)
  - Result format (whether chunkId needs to be exposed to the citation system)

### Link D Record-level Citation Tokens

- Planned token format: `[source:<sourceId>]`
- Requires updating the system prompt to constrain the model to only cite `sourceId` values that appear in the context.

### Link E `citations` SSE Event

- Planned: Emit `event: citations` after stream end, returning `references[]` (sourceId / nodeId / type / title / uri / revisionId, etc.)

### Link F Frontend Token Parsing & Click-to-Locate

- Planned: Parse `[source:<sourceId>]` -> render as numbered citations + References list.
- Planned: Clicking a reference navigates via `sourceId -> canvas_nodes -> nodeId` to locate / highlight the node.

---

## 5) TODO (Planned)

- **Chunking / vector retrieval:** Chunk and index `sources` (and note/text revisions); switch Chat injection to top-k chunks.
- **`event: citations`:** Emit structured `references[]` at the end of the SSE stream.
- **Citation tokens:** Have the model generate stable tokens (e.g. `[source:<sourceId>]` or finer-grained chunk tokens).
- **Frontend citation rendering:** Convert tokens to numbered citations + a clickable References list with node highlight/locate support.
