/**
 * Remote File System (RFS) API — wire types.
 *
 * The RFS is the curl-native surface external agents use to reach back into a
 * canvas. It replaces the v1 node-CRUD reachback tool with four endpoints under
 * `/api/rfs/:canvasId`:
 *
 * - `GET  download/<path>` — fetch a node/artifact/upload file as raw bytes.
 *   All node metadata (including the label and incident edges) rides along in
 *   ASCII-safe `X-Huabu-*` response headers (see {@link RFS_HEADERS}).
 * - `POST/DELETE upload/<file>` — stage/remove a file in the shared upload area
 *   so the internal agent can consume it (see {@link RfsUploadResponse}).
 * - `POST agent` — talk to the canvas-internal agent for all graph-semantic
 *   work (create/move/layout/snapshot/discovery). Response is **always**
 *   `text/event-stream` (see {@link RfsAgentRequest}).
 * - `GET  skill` — pull the full RFS usage guide (per-canvas `skill.md` override
 *   or the bundled default).
 *
 * Auth for every endpoint is a per-request `Authorization: Bearer $AGENTLET_TOKEN`
 * header. Errors use the canonical {@link ApiErrorBody}; on `4xx`/`5xx` the
 * `message` embeds a runnable `GET .../skill` recovery command.
 *
 * Conventions: schemas are the single source of truth; request bodies are
 * validated server-side via `safeParse`; the web bundle must import these as
 * `import type` only (keep it zod-free).
 */

import { z } from 'zod';

import { CANVAS_NODE_TYPES } from '../canvas/node.js';

// ==================== Metadata allow-list ====================

/**
 * The metadata subset exposed to external agents on a node download.
 *
 * Every field is carried in an ASCII-safe `X-Huabu-*` response header (see
 * {@link RFS_HEADERS}). `id`, `type`, `src`, `locked` are ASCII in practice;
 * `label` may contain arbitrary Unicode, so it is **percent-encoded** (UTF-8,
 * like `encodeURIComponent`) before going on the wire and must be URL-decoded
 * by the caller.
 *
 * This is intentionally a small allow-list, not the full `BaseNodeData`: server
 * hints (`contentMissing`, `duplicateFiles`, …), layout, and styling are
 * canvas-internal concerns the agent should not depend on.
 */
export const rfsNodeMetaSchema = z.object({
  /** Stable node id. */
  id: z.string(),
  /** Node kind — one of {@link CANVAS_NODE_TYPES}. */
  type: z.enum(CANVAS_NODE_TYPES),
  /** Display label (Unicode; percent-encoded in the header). */
  label: z.string().optional(),
  /**
   * Artifact/URL reference for media nodes (image/pdf/video/…). The storage
   * key or URL as persisted in `data.src`. ASCII in practice; header-safe.
   */
  src: z.string().optional(),
  /** Whether the node is locked against move/resize/auto-layout. */
  locked: z.boolean().optional(),
  /**
   * Revision token over the node's authored content (`content` / `src`); the
   * same value carried as the download's `ETag`. Lets an agent skip re-reading
   * an unchanged node (compare to the `rev` it last saw) and conditional-GET
   * with `If-None-Match`. Absent only for a node with no authored body.
   */
  rev: z.string().optional(),
});

export type RfsNodeMeta = z.infer<typeof rfsNodeMetaSchema>;

/**
 * Incident edges of a node, grouped by direction, serialised as a JSON string
 * in the `X-Huabu-Node-Edges` header. Node ids are ASCII, so the compact JSON
 * (`{"parents":[…],"children":[…]}`) is header-safe. `parents` are the sources
 * of edges pointing **at** this node; `children` are the targets of edges this
 * node points **to**.
 */
export interface RfsNodeEdges {
  /** Ids of nodes with an edge whose target is this node. */
  parents: string[];
  /** Ids of nodes with an edge whose source is this node. */
  children: string[];
}

// ==================== Response headers ====================

/**
 * Canonical `X-Huabu-*` response header names carrying the node metadata on a
 * raw byte download. Centralised so server and any client helper agree on the
 * exact casing.
 *
 * `nodeLabel` is **percent-encoded** UTF-8 (URL-decode it); `edges` is a JSON
 * string (see {@link RfsNodeEdges}). The rest are plain ASCII strings.
 */
export const RFS_HEADERS = {
  /** `X-Huabu-Node-Id` — the node id. */
  nodeId: 'X-Huabu-Node-Id',
  /** `X-Huabu-Node-Type` — one of {@link CANVAS_NODE_TYPES}. */
  nodeType: 'X-Huabu-Node-Type',
  /** `X-Huabu-Node-Label` — display label, percent-encoded UTF-8. */
  nodeLabel: 'X-Huabu-Node-Label',
  /** `X-Huabu-Src` — artifact/URL ref for media nodes, when present. */
  src: 'X-Huabu-Src',
  /** `X-Huabu-Locked` — `'true'`/`'false'` when the node is locked. */
  locked: 'X-Huabu-Locked',
  /** `X-Huabu-Node-Edges` — `{"parents":[…],"children":[…]}` JSON string. */
  edges: 'X-Huabu-Node-Edges',
} as const;

// ==================== Upload ====================

/** Success body for `POST /api/rfs/:canvasId/upload/<file>`. */
export interface RfsUploadResponse {
  /**
   * Canvas-relative path where the bytes were staged, e.g. `upload/out.md`.
   * This is the path the internal agent reads when asked to consume the file.
   */
  path: string;
  /** Number of bytes written. */
  size: number;
}

// ==================== ask-agent ====================

/** Lower clamp for {@link RfsAgentRequest.heartbeatSec}. */
export const RFS_HEARTBEAT_MIN_SEC = 5;
/** Upper clamp for {@link RfsAgentRequest.heartbeatSec}. */
export const RFS_HEARTBEAT_MAX_SEC = 30;
/** Default heartbeat cadence when the caller omits `heartbeatSec`. */
export const RFS_HEARTBEAT_DEFAULT_SEC = 15;

/** Canonical request headers for `POST /api/rfs/:canvasId/agent`. */
export const RFS_AGENT_HEADERS = {
  threadId: 'X-Huabu-Thread-Id',
  eventMode: 'X-Huabu-Event-Mode',
  heartbeatSec: 'X-Huabu-Heartbeat-Sec',
} as const;

export const rfsAgentEventModeSchema = z.enum(['final', 'all']);
export type RfsAgentEventMode = z.infer<typeof rfsAgentEventModeSchema>;

/**
 * Validated control headers for `POST /api/rfs/:canvasId/agent`.
 *
 * Fastify normalizes incoming header names to lowercase. Unknown standard
 * headers are retained by `.passthrough()` and ignored by the route.
 */
export const rfsAgentHeadersSchema = z
  .object({
    'x-huabu-thread-id': z
      .string()
      .trim()
      .min(1)
      .max(256)
      .regex(/^[^\r\n]+$/)
      .optional(),
    'x-huabu-event-mode': rfsAgentEventModeSchema.optional(),
    'x-huabu-heartbeat-sec': z.coerce
      .number()
      .int()
      .min(RFS_HEARTBEAT_MIN_SEC)
      .max(RFS_HEARTBEAT_MAX_SEC)
      .optional(),
  })
  .passthrough();

export type RfsAgentHeaders = z.infer<typeof rfsAgentHeadersSchema>;

/**
 * Request body for `POST /api/rfs/:canvasId/agent`.
 *
 * The response is **always** `text/event-stream`: the SSE framing is the
 * envelope (comment `:` heartbeats keep proxies/timeouts at bay; a terminal
 * `event: error` frame reports failures), while the payload inside `data:`
 * frames is plain text when {@link doneTextOnly} is set. A caller can recover
 * the final answer with `sed -n 's/^data: //p'`.
 */
export const rfsAgentRequestSchema = z.object({
  /** Natural-language instruction for the canvas-internal agent. */
  prompt: z.string().min(1),
  /**
   * When true (the default, applied server-side), the agent streams a single
   * final plain-text answer in `data:` frames instead of structured
   * intermediate events — the simplest thing to consume from a shell. Set false
   * to receive the full structured agent event stream.
   */
  doneTextOnly: z.boolean().optional(),
  /**
   * Heartbeat cadence in seconds, clamped to
   * [{@link RFS_HEARTBEAT_MIN_SEC}, {@link RFS_HEARTBEAT_MAX_SEC}]. Comment
   * heartbeats are emitted on this timer to keep the connection alive during
   * long agent turns. Defaults to {@link RFS_HEARTBEAT_DEFAULT_SEC}.
   */
  heartbeatSec: z
    .number()
    .int()
    .min(RFS_HEARTBEAT_MIN_SEC)
    .max(RFS_HEARTBEAT_MAX_SEC)
    .optional(),
});

export type RfsAgentRequest = z.infer<typeof rfsAgentRequestSchema>;
