# Node Preprocessing Design

> **Status**: This document is both a design spec and a living record.
> Sections under "Current Model" and "Current Implementation Details" describe
> the state **before** the preprocessing refactoring. They are kept for
> historical context. See the "Implementation Progress" section at the end
> for what has been completed and what remains.

## Background

Sediment originally had two different classes of server-side processing for canvas nodes:

- Knowledge ingestion for `note`, `text`, `web`, and `pdf`
- LLM-based semantic preprocessing for `image` and `frame`

Both are triggered by canvas node lifecycle events, but they are not modeled as one unified system yet. As a result:

- Different node types go through different client triggers and different server routes
- Knowledge persistence and semantic enrichment are coupled to specific implementations rather than shared capabilities
- It is hard to centralize LLM usage, caching, retry policy, and cost control
- The distinction between canvas node types and knowledge source types is implicit rather than explicit

This document summarizes the current implementation and proposes a unified `preprocessing` abstraction that can cover ingestion, enrichment, and future node-level analysis in one coherent pipeline.

## Goals

The proposed preprocessing architecture should make the following explicit:

- Which canvas nodes participate in preprocessing
- Which preprocessing capabilities each node type has
- Which stages are pure extraction, which are LLM or external-provider enrichment, and which are persistence
- How node insertion and node updates flow through the same pipeline with different triggers
- How to avoid unnecessary repeated work and reduce LLM and external API cost

## Current Model (Pre-Refactoring)

> The following describes the architecture **before** the preprocessing
> refactoring. After Phase 1 and Phase 2 of the refactoring plan, the
> server pipeline has been replaced by the unified 6-stage `PreprocessDispatcher`.
> Frontend triggers have been partially unified. See "Implementation Progress"
> for details.

### Two Different Processing Pipelines

Current processing is split into two separate pipelines.

#### 1. Knowledge ingest pipeline

Applies to:

- `note`
- `text`
- `web`
- `pdf`

High-level path:

- Frontend trigger in `apps/web/src/utils/io/ingest.ts`
- Client API call in `apps/web/src/api/canvas.ts`
- Canvas route in `apps/server/src/modules/canvas/canvas.route.ts`
- Ingest service in `apps/server/src/modules/knowledge/ingest.service.ts`
- Document loaders in `apps/server/src/modules/knowledge/loaders/`
- Persistence through `IKnowledgeRepository`

#### 2. Semantic label preprocessing pipeline

Applies to:

- `image`
- `frame`

High-level path:

- Frontend trigger in `apps/web/src/utils/io/resolveLabel.ts`
- Client API call in `apps/web/src/api/canvas.ts`
- Canvas route in `apps/server/src/modules/canvas/canvas.route.ts`
- LLM call through `apps/server/src/modules/agent/llm.ts`

This second pipeline does not create or update knowledge sources. It only returns semantic label suggestions.

## Node Categories

### Canvas node types

Canvas node types are defined as UI and graph entities. Current types include:

- `note`
- `text`
- `image`
- `pdf`
- `video`
- `web`
- `frame`

Important point:

- `frame` is a normal canvas node type
- It is not a separate category outside the node model
- Its role is structural and organizational rather than source-backed

### Knowledge source types

Knowledge source types are currently separate from canvas node types. Current source types are:

- `web`
- `pdf`
- `note`
- `text`

Important point:

- `image`, `video`, and `frame` are canvas nodes but are not current knowledge source types

### Why this distinction matters

The current codebase mixes these concepts in a few places. The future preprocessing design should keep them separate:

- `CanvasNodeKind`: what the node is on the canvas
- `SourceKind`: whether and how the node persists into the knowledge layer
- `Capability`: what processing operations this node supports

## Current Implementation Details (Pre-Refactoring)

> The file paths below reflect the state before the refactoring. After the
> refactoring (and a concurrent canvas-command restructure on `main`), the
> frontend trigger files, store handlers, and server route internals have
> changed. See "Implementation Progress" for the new file layout.

### Frontend trigger model

The frontend has two separate trigger systems.

#### Ingest trigger

The ingest trigger is based on node updates and only covers `note`, `text`, `web`, and `pdf`.

Trigger rules:

- `note` and `text`: trigger when `content` changes
- `web` and `pdf`: trigger when `src` changes
- Trigger is debounced
- There is a `beforeunload` flush for pending work

This means current ingest behavior is edit-driven, not modeled as a generic node preprocessing pipeline.

#### Label resolution trigger

The label-resolution trigger is separate.

Trigger rules:

- `image`: trigger when the node has a resolvable `src`
- `frame`: trigger when it has meaningful child labels
- User-authored labels are protected and not overwritten

### Server entry points

Current HTTP routes are separate:

- `PUT /api/canvas/:canvasId/nodes/:nodeId`
  - Used for ingest only
  - Backend accepts `note`, `text`, `web`, `pdf`
- `POST /api/canvas/resolve-label`
  - Used for semantic label generation
  - Backend accepts `image` or `frame`

### Current node processing behavior by type

#### Note

Current behavior:

- Canonical input is markdown content
- Empty content is treated as a valid placeholder state rather than a hard failure
- A source can be created or updated
- Existing `sourceId` is respected for updates
- Content hash is used to skip unnecessary writes

Meaning:

- `note` is mutable, source-backed content
- It behaves like editable knowledge state

#### Text

Current behavior:

- Processed the same way as `note`
- Uses the same text loader path
- Supports persistence into the knowledge store

Meaning:

- `text` is currently source-backed even though some comments in the code suggest a lighter role
- In practice it behaves as a mutable persisted source

#### Web

Current behavior:

- `src` is normalized
- Source identity is deterministic based on normalized URL
- If content is provided by the frontend, backend may reuse it
- Otherwise content is fetched through Tavily Extract
- Metadata is enriched from fetched response and hostname
- Content hash is used to skip unnecessary updates

Meaning:

- `web` is currently a remote-source extraction workflow plus persistence
- It uses an external provider, but not through the shared LLM interface

#### PDF

Current behavior:

- `src` is treated as an artifact URI rather than a generic URL
- Artifact URI is resolved to a file in the artifacts directory
- Text extraction is performed through `pdf2md`
- PDF metadata such as title and page count may be extracted
- Source identity is deterministic from extracted content hash or file hash fallback
- Placeholder records are used for missing file or parse failure cases

Meaning:

- `pdf` is an artifact-backed extraction workflow plus persistence
- It already has a useful distinction between partial success and complete success

#### Image

Current behavior:

- No knowledge ingest
- No current source persistence
- Uses LLM vision input to generate a short label

Meaning:

- `image` already participates in preprocessing
- It just participates in a different preprocessing pipeline than ingest

#### Frame

Current behavior:

- No knowledge ingest
- No source persistence
- Child labels are summarized into a short semantic label using the LLM

Meaning:

- `frame` is also part of preprocessing today
- Its input is not direct content but structural context from child nodes

#### Video

Current behavior:

- Present as a canvas node type
- Not handled by current ingest route
- Not handled by current label-resolution route
- There is a `YoutubeLoader` in the repository, but it is not integrated into the current node processing path

Meaning:

- `video` is a strong candidate for future preprocessing support
- The repository already hints at future extraction capabilities, but type and routing are not unified yet

## Current Pain Points

The current design works, but it has several architectural limitations.

### 1. Processing is route-driven instead of capability-driven

The system currently asks:

- Is this an ingest request?
- Is this a label-resolution request?

Instead, it should ask:

- What capabilities does this node have?
- Which capabilities are dirty for this change?

### 2. Persistence is entangled with preprocessing

Today, preprocessing for `note`, `text`, `web`, and `pdf` is effectively synonymous with persistence into the knowledge store.

That makes it difficult to support:

- preprocessing without persistence
- progressive background enrichment
- reuse of extracted content for multiple downstream purposes

### 3. LLM and external-provider work are not centrally managed

Current provider usage is split across:

- Azure OpenAI through `llm.ts`
- Tavily Extract inside the web loader

This makes it hard to implement:

- centralized budget policy
- provider-level caching
- retry and fallback rules
- observability of expensive processing

### 4. Different node types have different trigger machinery

Current frontend logic has separate pipelines for ingest and label resolution. That increases duplication in:

- debounce logic
- stale result handling
- patch application logic
- background processing policy

### 5. Partial states are under-modeled

The ingest pipeline already has a placeholder concept, but it is not elevated to a shared preprocessing result model. This makes it harder to uniformly express:

- empty note state
- unresolved artifact state
- retryable external fetch failure
- enrichment skipped due to cost policy

## Proposed Abstraction

The core recommendation is:

- Do not define preprocessing as “unified ingest”
- Define ingest as one capability inside a broader preprocessing system

### Core concepts

#### CanvasNodeKind

Represents the node that exists on the canvas.

Example values:

- `note`
- `text`
- `web`
- `pdf`
- `image`
- `video`
- `frame`

#### SourceKind

Represents the knowledge-source form, if any.

Example values:

- `note`
- `text`
- `web`
- `pdf`

`image`, `frame`, and `video` may have no `SourceKind` initially.

#### Capability

Represents what processing a node can participate in.

Capabilities are organized by pipeline stage. Each capability belongs to exactly one stage
so that the dispatcher can plan execution without ambiguity.

| Stage         | Capability             | Description                                           |
| ------------- | ---------------------- | ----------------------------------------------------- |
| Input Resolve | `resolve_input`        | Normalize raw node data into canonical pipeline input |
| Extract       | `extract_text`         | Parse local content (TextLoader, PdfLoader)           |
| Extract       | `fetch_remote_content` | Fetch content from an external source (Tavily, etc.)  |
| Normalize     | `compute_fingerprint`  | Content hash / source key generation                  |
| Normalize     | `resolve_title`        | Derive a title from extracted content or metadata     |
| Normalize     | `merge_metadata`       | Merge and canonicalize metadata fields                |
| Enrich (LLM)  | `generate_label`       | LLM-powered label for image, frame, or any node       |
| Enrich (LLM)  | `generate_summary`     | LLM-powered summary of extracted content              |
| Enrich (LLM)  | `generate_keywords`    | LLM-powered keyword extraction                        |
| Persist       | `persist_source`       | Write / update a knowledge source record              |
| Project       | `build_patch`          | Assemble the authoritative node patch for the client  |

Design rule: **all LLM and paid-provider work lives exclusively in the Enrich stage**.
This makes it possible to skip the entire Enrich stage for cost control, run it in
a separate background pass, or batch multiple enrichments into a single LLM call.

#### TriggerReason

Represents why preprocessing is running.

Suggested trigger reasons:

- `node_inserted`
- `node_updated`
- `flush`
- `manual`
- `repair`

## Proposed Capability Profiles

Each node type should define a preprocessing profile.

Illustrative shape:

```ts
type NodePreprocessProfile = {
  nodeType: CanvasNodeKind;
  sourceKind?: SourceKind;
  capabilities: Capability[];
  watchFields: string[];
};
```

Suggested initial profiles:

```ts
const profiles: Record<CanvasNodeKind, NodePreprocessProfile> = {
  note: {
    nodeType: 'note',
    sourceKind: 'note',
    capabilities: [
      'resolve_input',
      'extract_text',
      'compute_fingerprint',
      'resolve_title',
      'merge_metadata',
      'persist_source',
      'build_patch',
    ],
    watchFields: ['content', 'label'],
  },
  text: {
    nodeType: 'text',
    sourceKind: 'text',
    capabilities: [
      'resolve_input',
      'extract_text',
      'compute_fingerprint',
      'resolve_title',
      'merge_metadata',
      'persist_source',
      'build_patch',
    ],
    watchFields: ['content', 'label'],
  },
  web: {
    nodeType: 'web',
    sourceKind: 'web',
    capabilities: [
      'resolve_input',
      'fetch_remote_content',
      'compute_fingerprint',
      'resolve_title',
      'merge_metadata',
      'generate_summary', // Enrich: optional LLM summary
      'persist_source',
      'build_patch',
    ],
    watchFields: ['src', 'label'],
  },
  pdf: {
    nodeType: 'pdf',
    sourceKind: 'pdf',
    capabilities: [
      'resolve_input',
      'extract_text',
      'compute_fingerprint',
      'resolve_title',
      'merge_metadata',
      'generate_summary', // Enrich: optional LLM summary
      'persist_source',
      'build_patch',
    ],
    watchFields: ['src', 'label'],
  },
  image: {
    nodeType: 'image',
    capabilities: [
      'resolve_input',
      'compute_fingerprint',
      'generate_label', // Enrich: LLM vision label
      'build_patch',
    ],
    watchFields: ['src'],
  },
  video: {
    nodeType: 'video',
    capabilities: [
      'resolve_input',
      'extract_text', // future: YoutubeLoader
      'compute_fingerprint',
      'resolve_title',
      'merge_metadata',
      'build_patch',
    ],
    watchFields: ['src'],
  },
  frame: {
    nodeType: 'frame',
    capabilities: [
      'resolve_input', // collect child labels
      'compute_fingerprint',
      'generate_label', // Enrich: LLM summarize-children → label
      'build_patch',
    ],
    watchFields: ['childLabels'],
  },
};
```

The important improvement is that node handling becomes declarative and capability-driven.

## Proposed Processing Layers

The preprocessing system should be split into explicit layers.

### 1. Trigger layer

Responsibility:

- detect node insertion or updates that affect preprocessing
- debounce and coalesce rapid changes
- attach trigger reason and execution mode

This should replace the current split between `ingest.ts` and `resolveLabel.ts`.

### 2. Request construction layer

Responsibility:

- package the latest node snapshot
- package optional previous snapshot or revision metadata
- send one unified request to the server

Suggested request shape:

```ts
interface PreprocessNodeRequest {
  canvasId: string;
  nodeId: string;
  nodeType: CanvasNodeKind;
  trigger: TriggerReason;
  snapshot: Record<string, unknown>;
  previousSnapshot?: Record<string, unknown>;
  options?: {
    allowLLM?: boolean;
    allowPersistence?: boolean;
    force?: boolean;
    mode?: 'interactive' | 'background' | 'manual';
  };
}
```

### 3. Dispatcher and planning layer

Responsibility:

- load the node profile
- compute dirty fields from current and previous snapshot
- map dirty fields to capabilities
- generate the minimum execution plan for this run

This is where the system decides which parts of preprocessing are necessary.

Examples:

- `note` content changed: run `extract_text` and `persist_source`
- `web` label manually changed: skip expensive extraction and skip semantic overwrite
- `frame` child labels changed: run `summarize_children` and `resolve_label`
- node position changed only: skip preprocessing entirely

### 4. Stage execution layer

Responsibility:

- run the selected pipeline stages in a stable order
- keep stages reusable across node types

Recommended stages are described below.

## Proposed Pipeline Stages

All node types pass through the same 6-stage pipeline. The dispatcher decides which
stages to execute based on the node profile and dirty capabilities.

### Stage 1. Input Resolve

Purpose: convert raw node data into a canonical, stage-ready input structure.

| Node type | What happens                                       |
| --------- | -------------------------------------------------- |
| note/text | Pass through markdown content as-is                |
| web       | Normalize URL, attach optional prefetched content  |
| pdf       | Resolve artifact URI → absolute file path          |
| image     | Resolve image src (local artifact or external URL) |
| video     | Resolve video src / extract video ID               |
| frame     | Collect child node labels into an ordered list     |

Rules:

- No external calls, no LLM, no persistence
- Must be deterministic and cheap
- Output is a `ResolvedInput` object consumed by subsequent stages

### Stage 2. Extract

Purpose: perform content extraction and parsing without LLM involvement.

| Node type | Extractor                                 | External call? |
| --------- | ----------------------------------------- | -------------- |
| note/text | `TextLoader` — pass-through normalization | No             |
| web       | `WebLoader` → Tavily Extract API          | Yes (HTTP)     |
| pdf       | `PdfLoader` → `pdf2md`                    | No (local)     |
| video     | `YoutubeLoader` → transcript API (future) | Yes (HTTP)     |
| image     | None (no textual extraction)              | —              |
| frame     | None (structural, not content-based)      | —              |

Rules:

- This stage does NOT persist data
- Existing `DocumentLoaderFactory` and loaders are reused here
- Tavily Extract lives here because it is content extraction, not semantic enrichment.
  Currently called through `WebLoader` directly (not `ProviderManager`).
  Future enhancement: route Tavily calls through `ProviderManager` for unified
  budget tracking and retry policy alongside LLM calls.

### Stage 3. Normalize

Purpose: produce canonical metadata, fingerprints, and stable identifiers
from the extracted content.

Operations performed:

- **Content hash** — SHA-256 of extracted content (`computeContentHash`)
- **Source key** — deterministic `sourceId` generation (`generateSourceId`)
- **Title extraction** — first heading, PDF metadata title, web page title, etc.
- **Metadata merge** — combine loader metadata, user metadata, and derived fields
- **Canonical content** — final normalized string that will be stored

Rules:

- No external calls, no LLM
- Must be deterministic given the same extract output
- The `inputFingerprint` produced here is the cache/skip key for all subsequent stages:
  if it matches the last successful run, stages 4–5 can be skipped entirely

### Stage 4. Enrich

Purpose: **all LLM and paid semantic work happens here and only here**.

| Capability          | Input                           | LLM prompt                          | Output           |
| ------------------- | ------------------------------- | ----------------------------------- | ---------------- |
| `generate_label`    | image src OR frame child labels | Vision describe / group-name prompt | `suggestedLabel` |
| `generate_summary`  | extracted web/pdf/note content  | Summarization prompt                | `summary`        |
| `generate_keywords` | extracted content               | Keyword extraction prompt           | `keywords[]`     |

Design principles:

1. **Single provider entry point** — all LLM calls go through `ProviderManager`,
   which wraps the existing `llmComplete` / `llmStream` from `agent/llm.ts`.
2. **Batchable** — when multiple nodes are preprocessed together (e.g. bulk import),
   the dispatcher MAY combine enrichment requests into fewer LLM calls.
3. **Skippable** — if `options.allowLLM === false` or `mode === 'interactive'`,
   the entire Enrich stage is skipped. The pipeline still produces a valid result.
   This is enforced in `pipeline.ts`'s Stage 4 gate.
4. **Cacheable** — enrichment results are keyed by `inputFingerprint`.
   If the fingerprint has not changed since the last enrichment, cached results are reused.

This consolidation means that `summarize_children` for frames and `analyze_image` for images
are no longer separate capabilities — they are both instances of `generate_label` with
different input preparation (done in Stage 1) and different prompts (selected by node type).

### Stage 5. Persist

Purpose: write the canonical source record into the knowledge store.

| Node type | Persists?                            | Identity model                           |
| --------- | ------------------------------------ | ---------------------------------------- |
| note/text | Yes                                  | Mutable: existing `sourceId` or new UUID |
| web       | Yes                                  | Deterministic: hash of normalized URL    |
| pdf       | Yes                                  | Deterministic: hash of file content      |
| image     | No (unless future policy enables it) | —                                        |
| video     | No (unless future policy enables it) | —                                        |
| frame     | No                                   | —                                        |

Rules:

- Uses `IKnowledgeRepository.createSource` / `updateSource`
- Content-hash deduplication: skip write if hash unchanged
- Placeholder records are created for valid-but-empty or failed-extract states
- Persistence is policy-controlled via `options.allowPersistence`

### Stage 6. Project

Purpose: assemble the authoritative response and node patch.

Output fields:

- `sourceId` — from Persist stage (if applicable)
- `suggestedLabel` — from Enrich stage (if applicable)
- `preprocessingStatus` — success / partial / error / skipped
- `contentChanged` / `isNew` / `placeholder` flags
- `diagnostics[]` — structured warnings and errors
- `patch` — the definitive key-value object the frontend should apply to node data

Rules:

- The frontend does NOT independently decide what to patch
- The server returns one canonical `patch` object
- Label policy (user-set vs auto) is enforced here before including `suggestedLabel` in the patch

## LLM Consolidation Principle

A key architectural goal is to ensure that **every LLM invocation in the preprocessing
path goes through a single Enrich stage execution**. This enables:

### Cost control

- The Enrich stage can be globally gated by a budget flag
- A per-canvas or per-session token budget can be enforced in one place

### Batch optimization

- When N nodes enter preprocessing simultaneously (e.g. canvas import, bulk paste),
  the dispatcher can collect all Enrich requests and submit them as a batch

### Cache deduplication

- Enrichment results are keyed by `(capability, inputFingerprint)`
- Re-processing a node whose content has not changed skips the LLM call entirely

### What moves into Enrich

| Current location                        | Current behavior                      | New location                |
| --------------------------------------- | ------------------------------------- | --------------------------- |
| `canvas.route.ts` resolve-label (image) | `llmComplete` with vision prompt      | Enrich: `generate_label`    |
| `canvas.route.ts` resolve-label (frame) | `llmComplete` with child-label prompt | Enrich: `generate_label`    |
| Future: web/pdf summary                 | Not yet implemented                   | Enrich: `generate_summary`  |
| Future: keyword extraction              | Not yet implemented                   | Enrich: `generate_keywords` |

### What does NOT move into Enrich

| Current location                 | Reason it stays                             |
| -------------------------------- | ------------------------------------------- |
| Tavily Extract in `WebLoader`    | Content extraction, not semantic enrichment |
| `pdf2md` in `PdfLoader`          | Local parsing, no LLM                       |
| `YoutubeLoader` transcript fetch | External API but deterministic extraction   |

## Recommended Runtime Mechanism

### One unified preprocessing API

Instead of:

- one route for node ingest
- one route for label resolution

the system should evolve toward:

- one route for node preprocessing

Suggested response shape:

```ts
interface PreprocessNodeResult {
  nodeId: string;
  nodeType: CanvasNodeKind;
  trigger: TriggerReason;
  requestId: string;

  success: boolean;
  status: 'success' | 'partial' | 'error' | 'skipped';

  usedCapabilities: Capability[];

  fingerprints: {
    input: string;
    output?: string;
  };

  extracted?: {
    title?: string;
    content?: string;
    metadata?: Record<string, unknown>;
  };

  enriched?: {
    suggestedLabel?: string;
    summary?: string;
    keywords?: string[];
  };

  persistence?: {
    sourceId?: string;
    sourceKind?: SourceKind;
    isNew?: boolean;
    contentChanged?: boolean;
    placeholder?: boolean;
  };

  patch: Record<string, unknown>;

  diagnostics: Array<{
    code: string;
    level: 'info' | 'warning' | 'error';
    message: string;
    retryable?: boolean;
  }>;
}
```

This would subsume both current `UpsertNodeResponse` and `ResolveLabelResponse` behavior.

### Unified per-node state machine

Recommended preprocessing state values:

- `idle`
- `queued`
- `running`
- `success`
- `partial`
- `error`
- `stale`

`partial` is important for placeholder cases and retryable external failures.

### Revision-aware or request-aware patching

The frontend should attach a request or revision identifier to each preprocessing run.

Recommended rule:

- Only apply returned patches if the result still matches the latest known node revision or request token

This prevents stale LLM or external-provider results from overwriting newer edits.

### Capability-level debounce

Debounce should not be organized around ad hoc APIs like “ingest” or “resolve label”.

Instead, debounce should be organized around capabilities or capability groups.

Examples:

- `persist_source` may debounce longer for note editing
- `resolve_label` may debounce separately for frame summarization
- cheap fingerprint and validation may run immediately

### Execution modes

The system should distinguish:

- `interactive`
  - low latency
  - cheap and necessary steps only
- `background`
  - allowed to run expensive extraction and enrichment
- `manual`
  - user explicitly requested reprocessing or enrichment

This distinction is important for reducing perceived latency and controlling cost.

## Recommended Insertion and Update Chains

Insertion and update should use the same pipeline, but with different trigger reasons and dirty scopes.

### Node insertion chain

Suggested sequence:

1. Frontend inserts the node into canvas state immediately
2. Frontend schedules preprocessing with trigger `node_inserted`
3. Backend resolves node profile and computes execution plan
4. Cheap stages run first
5. Expensive stages may continue in background mode if needed
6. Backend returns authoritative patch information
7. Frontend applies patch if result is still current

Examples:

- New empty `note`
  - resolve and fingerprint only
  - optional placeholder policy decision
- New `note` with content
  - extract and persist
- New `web`
  - normalize URL, fetch content, persist source
- New `pdf`
  - resolve artifact path, parse PDF, persist source
- New `image`
  - defer label generation until input is stable
- New `frame`
  - wait until child labels are meaningful before summarizing

### Node update chain

Suggested sequence:

1. Frontend captures previous and next node snapshot
2. Frontend schedules preprocessing with trigger `node_updated`
3. Backend computes dirty fields
4. Dispatcher maps dirty fields to capabilities
5. Only the minimum necessary stages run
6. Backend returns patch and diagnostics
7. Frontend applies patch if still current

Examples:

- `note` content changed
  - rerun extract and persist
- `note` label manually changed
  - do not rerun source persistence unless title policy requires it
- `web` src changed
  - rerun resolve, fetch, and persist
- `image` position changed only
  - skip preprocessing
- `frame` child labels changed
  - rerun summary and label resolution

## Mapping Current Code to the New Architecture

The current codebase already contains reusable pieces that fit into the proposed model.

### Trigger layer

Can be evolved from:

- current ingest trigger logic
- current label-resolution trigger logic

### Resolve and extract stage

Can reuse:

- `TextLoader`
- `PdfLoader`
- web snapshot and fetch helpers
- existing artifact URI resolution logic in the PDF path

### Persist stage

Can reuse:

- `IngestService` source create or update logic
- placeholder record logic
- `IKnowledgeRepository` and current Obsidian implementation

### Enrich stage

Can reuse:

- current image and frame label prompting logic
- current LLM client wrapper

### Project stage

Should consolidate the patch decisions currently spread across:

- frontend sourceId patching
- frontend suggestedLabel application
- route response shaping

## Recommended Interface Boundaries

### Server-side module structure

```
apps/server/src/modules/preprocessing/
├── index.ts                   # public exports
├── types.ts                   # internal stage context types
├── profiles.ts                # NodePreprocessProfile registry
├── dispatcher.ts              # dirty-field analysis → execution plan
├── pipeline.ts                # ordered stage runner
├── stages/
│   ├── input-resolve.ts       # Stage 1
│   ├── extract.ts             # Stage 2 — delegates to existing loaders
│   ├── normalize.ts           # Stage 3
│   ├── enrich.ts              # Stage 4 — single LLM entry point
│   ├── persist.ts             # Stage 5 — delegates to IKnowledgeRepository
│   └── project.ts             # Stage 6
└── provider-manager.ts        # Unified wrapper for llm.ts + Tavily + future providers
```

### Shared types

```
packages/shared/src/types/
├── preprocessing.ts           # CanvasNodeKind, Capability, TriggerReason,
│                              # PreprocessNodeRequest, PreprocessNodeResult, etc.
└── canvas/source.ts           # keep UpsertNodeRequest/Response as deprecated aliases
```

## Technical Decisions

### Confirmed decisions

1. **Pipeline is always the same 6 stages** — dispatcher decides which stages to skip, not which pipeline to run
2. **All LLM work in Enrich** — no exceptions
3. **Tavily Extract stays in Extract stage** — but goes through `ProviderManager` for observability
4. **Server returns authoritative `patch` object** — frontend applies it without local inference
5. **User-authored labels are protected** — Enrich may propose a label, but Project only includes it in `patch` if `labelSource !== 'user'`

### Still open

1. **Should empty note/text get a placeholder source immediately?** — Recommendation: yes
2. **Should image/video persist derived data as knowledge sources?** — Recommendation: not in Phase 1
3. **Synchronous vs background persist for web/pdf?** — Recommendation: synchronous in Phase 1
4. **Batch preprocessing support?** — Recommendation: internal model supports it, HTTP route stays per-node in Phase 1

## Refactoring Plan

### Phase 1 — Introduce preprocessing types and server pipeline (no route changes) ✅ COMPLETED

Goal: build the new pipeline alongside existing code; both paths work.

Steps:

1. Create `packages/shared/src/types/preprocessing.ts`
   - Define `Capability`, `TriggerReason`, `PreprocessNodeRequest`, `PreprocessNodeResult`, `NodePreprocessProfile`
   - Reuse existing `CanvasNodeType` as `CanvasNodeKind` and `SourceType` as `SourceKind`

2. Create `apps/server/src/modules/preprocessing/types.ts`
   - Define internal stage context types: `ResolvedInput`, `ExtractResult`, `NormalizeResult`, `EnrichResult`, `PersistResult`

3. Create `apps/server/src/modules/preprocessing/profiles.ts`
   - Define the profile registry keyed by `CanvasNodeKind`

4. Create stage implementations under `apps/server/src/modules/preprocessing/stages/`
   - `input-resolve.ts` — extract logic from `IngestService` parameter preparation
   - `extract.ts` — call existing `DocumentLoaderFactory.getLoader(type).load(...)`
   - `normalize.ts` — content hash, sourceId generation, title extraction, metadata merge
   - `enrich.ts` — move LLM calls from `canvas.route.ts` resolve-label handler
   - `persist.ts` — extract logic from `IngestService.createOrUpdateSource`
   - `project.ts` — build `PreprocessNodeResult` from stage outputs

5. Create `apps/server/src/modules/preprocessing/pipeline.ts`
   - Run stages 1–6 in order, skipping stages whose capabilities are not in the plan

6. Create `apps/server/src/modules/preprocessing/dispatcher.ts`
   - Accept `PreprocessNodeRequest`, look up profile, build execution plan, call pipeline

7. Create `apps/server/src/modules/preprocessing/provider-manager.ts`
   - Wrap `llmComplete` with logging; start simple, add caching later

### Phase 2 — Wire new pipeline into existing routes (behind feature flag) ✅ COMPLETED (without feature flag)

Goal: existing HTTP routes delegate to the new pipeline internally.

The pipeline was wired directly into the existing routes without a feature flag,
since the refactoring replaced `IngestService` entirely rather than running in parallel.

Steps:

1. In the `PUT /:canvasId/nodes/:nodeId` handler, ~~add a branch~~:
   construct `PreprocessNodeRequest` and call dispatcher, map result to `UpsertNodeResponse`
2. In the `POST /resolve-label` handler, add a similar ~~branch~~ delegation
3. ~~Feature flag: `SEDIMENT_USE_PREPROCESSING_PIPELINE=1`~~ — not needed; direct replacement

### Phase 3 — Unify frontend triggers ⚠️ PARTIALLY COMPLETED

Goal: replace the two separate trigger systems with one.

Completed steps:

1. ✅ Created `apps/web/src/utils/io/preprocess.ts` — unified `preprocessNodeIfNeeded`
2. ⚠️ `triggerIngestion` and `triggerLabelResolve` still exist as two separate debounced
   entry points in `canvasStore.ts` and `postEffects.ts`. Both now call
   `preprocessNodeIfNeeded` internally, but the two-callback split remains in the
   canvas command system's `CanvasEffectCallbacks` interface and `PendingEffects`.
3. ❌ Request IDs and stale-result protection are not yet implemented.

Note: a concurrent canvas-command refactor on `main` replaced the old
`canvasHandlers.ts` with a command-pattern architecture (`apps/web/src/canvas/commands/`).
The preprocessing trigger integration now lives in:

- `mergeNodeData.ts` — uses `shouldPreprocessOnUpdate()` for ingestion triggers
- `createNodes.ts` — uses `needsLabelResolve()` for label resolution triggers
- `postEffects.ts` — dispatches `triggerIngestion` / `triggerLabelResolve` callbacks
- `runtime.ts` — defines `CanvasEffectCallbacks` with the two-callback interface

### Phase 4 — New unified route and cleanup 🔲 NOT STARTED

Goal: single preprocessing HTTP endpoint, remove old code paths.

Steps:

1. Add `POST /api/canvas/:canvasId/nodes/:nodeId/preprocess` route
2. ~~Update agent tool `ingest_content` to use dispatcher~~ — ✅ already done in Phase 2
3. Remove deprecated routes and frontend helpers
4. Merge `triggerIngestion` + `triggerLabelResolve` into a single `triggerPreprocessing`
   callback and update `CanvasEffectCallbacks`, `PendingEffects`, and all command handlers

### Phase 5 — Provider manager hardening 🔲 NOT STARTED

Goal: centralize external-provider usage and enable cost optimization.

Steps:

1. Add fingerprint-based result cache for Enrich stage
2. Add configurable budget limits
3. Implement batch enrichment for bulk operations

## Summary

The refactoring replaces the current split between knowledge-ingest and semantic-label
pipelines with a single 6-stage preprocessing pipeline:

1. **Input Resolve** — normalize raw node data
2. **Extract** — parse or fetch content (no LLM)
3. **Normalize** — hash, title, metadata, canonical content
4. **Enrich** — all LLM work in one place
5. **Persist** — write to knowledge store (policy-gated)
6. **Project** — build authoritative patch for the frontend

Every canvas node type goes through the same pipeline. The dispatcher decides which stages
and capabilities to execute based on node profiles and dirty-field analysis.

All LLM usage is consolidated in the Enrich stage, enabling cost control, batching,
caching, and observability in a single place.

### Error Recovery & Fallbacks

Nodes that fail extraction (e.g. malformed PDFs or missing Web URLs) do not simply silently exit. Instead:

- They throw a structured `EXTRACT_FAILED` diagnostic.
- If a web source lacks a URI or a PDF contains empty content, the `Normalize` stage assigns a stable fallback `sourceId` using the `nodeId` or `artifactUri`.
- This prevents identical empty contents across multiple failed nodes from colliding and overwriting each other in the storage, and allows the `Persist` stage to save a stable placeholder.

## Implementation Progress

This section records the actual state of the codebase relative to the plan above.

### What is implemented

| Area                           | Status | Notes                                                                                       |
| ------------------------------ | ------ | ------------------------------------------------------------------------------------------- |
| Shared preprocessing types     | ✅     | `packages/shared/src/types/preprocessing.ts`                                                |
| Server preprocessing module    | ✅     | `apps/server/src/modules/preprocessing/` with all 6 stages                                  |
| Capability profiles            | ✅     | 7 node types registered in `profiles.ts`                                                    |
| PreprocessDispatcher           | ✅     | Dirty-field analysis, execution planning, pipeline orchestration                            |
| ProviderManager                | ✅     | Wraps `llmComplete` for image label and frame label generation                              |
| PUT route integration          | ✅     | Uses `PreprocessDispatcher` instead of `IngestService`                                      |
| POST resolve-label integration | ✅     | Uses `PreprocessDispatcher` instead of inline `llmComplete`                                 |
| Agent tool `ingest_content`    | ✅     | Uses `PreprocessDispatcher`; supports all node types including PDF                          |
| Frontend `preprocess.ts`       | ✅     | Unified `preprocessNodeIfNeeded` replaces old `ingestNodeIfNeeded` + `resolveLabelIfNeeded` |
| Old `IngestService` removed    | ✅     | `apps/server/src/modules/knowledge/ingest.service.ts` deleted                               |
| Old frontend triggers removed  | ✅     | `ingest.ts` and `resolveLabel.ts` deleted                                                   |

### What is partially done

| Area                         | Status | Gap                                                                                                                                                                                                                |
| ---------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Frontend trigger unification | ⚠️     | `triggerIngestion` and `triggerLabelResolve` remain as two separate debounced callbacks. Both call `preprocessNodeIfNeeded`, but the interface split is preserved in `CanvasEffectCallbacks` and `PendingEffects`. |
| HTTP route consolidation     | ⚠️     | Two routes still exist: `PUT /nodes/:id` (ingest path) and `POST /resolve-label` (label path). They share the same dispatcher but use different request construction and response mapping.                         |

### What is not yet implemented

| Area                                     | Notes                                                                                           |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Unified preprocessing HTTP route         | `POST /api/canvas/:canvasId/nodes/:nodeId/preprocess` is defined in the plan but not created    |
| Request IDs / stale-result protection    | Frontend does not attach revision tokens to preprocessing requests                              |
| Fingerprint-based Enrich cache           | ProviderManager does not cache LLM results by input fingerprint                                 |
| Budget limits                            | No per-canvas or per-session token budget enforcement                                           |
| Batch enrichment                         | Dispatcher processes nodes one at a time; no batch LLM call optimization                        |
| `generate_summary` / `generate_keywords` | Enrich capabilities defined in profiles for web/pdf but not yet implemented in the Enrich stage |

### Concurrent changes on `main`

After the preprocessing refactoring was developed, a **canvas command refactor** landed
on `main` (PR #96). This refactoring:

- Deleted `apps/web/src/store/canvasHandlers.ts`
- Introduced `apps/web/src/canvas/commands/` with one file per command
- Introduced `apps/web/src/canvas/executor.ts` (batch command executor)
- Introduced `apps/web/src/canvas/postEffects.ts` (post-commit side effects)
- Introduced `apps/web/src/canvas/runtime.ts` (decoupled interfaces)
- Introduced `apps/web/src/canvas/uiIntent.ts` (user-intent resolution)

The preprocessing branch was rebased onto this new `main`. The relevant adaptations:

- `mergeNodeData.ts` now imports `shouldPreprocessOnUpdate` from `io/preprocess`
- `createNodes.ts` now imports `needsLabelResolve` from `io/preprocess`
- `postEffects.ts` dispatches `triggerIngestion` / `triggerLabelResolve` which call `preprocessNodeIfNeeded`
- `canvasHandlers.ts` no longer exists; its preprocessing-related logic was absorbed into the command system
