# Data Storage (Current)

This document describes the **current** data storage approach in this repo (as of now). It focuses on what is persisted, where it lives on disk, and how it is referenced at runtime.

> Scope note
>
> - This project currently targets **local workflows**.
> - Server-side persistence exists for agent/chat state.
> - The web app state (canvas, chat message list) is currently **in-memory** only unless you add your own persistence.

---

## 1) ID convention

All business identifiers should follow this format:

- `{type}-{uuid}`

Examples:

- `thread-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`
- `message-...`
- `artifact-...`

The canonical generator is:

- `createId(type)` in `packages/shared/src/utils/id.ts`

It generates `${type}-${uuid}` using:

1. `globalThis.crypto.randomUUID()` when available
2. `crypto.getRandomValues()` to generate a UUID v4
3. A non-cryptographic UUID-shaped fallback if crypto APIs are unavailable

---

## 2) Server-side persistence

### 2.1 LangGraph checkpoints (chat / agent state)

**What is stored**

- The compiled LangGraph workflow state (primarily the message history in `AgentState.messages`, and other annotated fields)
- Checkpoints are used to support multi-turn conversations by resuming state by `threadId`.

**Where it is stored**

- File-based SQLite database:
  - `apps/server/data/langgraph-checkpoints.sqlite`

This is created on-demand by:

- `getCheckpointer()` in `apps/server/src/modules/agent/store/checkpointer.ts`

**How it is keyed**

- The API accepts a `threadId` (`SendMessageRequest.threadId`).
- The server uses that `threadId` as LangGraph `thread_id` (see the `configurable.thread_id` passed to LangGraph in `apps/server/src/modules/chat/chat.route.ts`).

**Operational notes**

- SQLite sidecar files may appear in the same directory (WAL/SHM):
  - `langgraph-checkpoints.sqlite-wal`
  - `langgraph-checkpoints.sqlite-shm`
- This folder is gitignored (`apps/server/data` and `*.sqlite`).

### 2.2 Artifacts store (large tool outputs)

**Why this exists**

Some tool results can be too large to embed directly into tool messages/checkpoints.
For example, `web_search` may return large `content` bodies.

**What is stored**

- JSON files containing large text payloads.

Current payload shape (written by `saveTextArtifact`):

```json
{
  "id": "artifact-...",
  "createdAt": "2026-02-06T00:00:00.000Z",
  "meta": { "tool": "web_search", "url": "...", "title": "..." },
  "text": "..."
}
```

**Where it is stored**

- Directory:
  - `apps/server/data/artifacts/`
- Files are named:
  - `${id}.json` (for example: `artifact-<uuid>.json`)

The directory is created lazily when first needed.

**How it is referenced**

- Tools may return a reference string like:
  - `artifact://artifact-<uuid>`
- The tool payload uses `contentRef` for these references (see `WebSearchResultItem.contentRef` in `packages/shared/src/types/chat.ts`).

---

## 3) Web app storage (client-side)

### 3.1 Chat panel state

**What is stored**

- `messages` list in the ChatPanel component
- `threadId` generated on component mount

**Where it is stored**

- In React component state / refs (memory only)

Implications:

- Refreshing the page will reset the UI message list.
- A new `threadId` will be generated unless you persist and restore it yourself.
- The server can resume a conversation _if the client reuses the same `threadId`_.

### 3.2 Canvas state (nodes/edges)

**What is stored**

- React Flow nodes/edges (Zustand store)

**Where it is stored**

- In-memory Zustand store (`apps/web/src/store/canvasStore.ts`)

Implications:

- Canvas edits are not persisted across reloads.
- If you want persistence, you can add a storage layer (e.g., localStorage, IndexedDB, or a server API) and rehydrate the store.

---

## 4) Clearing data (local dev)

To reset all persisted server data:

- Stop the server
- Delete:
  - `apps/server/data/langgraph-checkpoints.sqlite*`
  - `apps/server/data/artifacts/` (if present)

Because `apps/server/data` is gitignored, this is safe for local cleanup.
