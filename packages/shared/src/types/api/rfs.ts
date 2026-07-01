/**
 * Remote File System (RFS) API — wire types.
 *
 * The RFS is the curl-native surface external agents use to reach back into a
 * canvas. It replaces the v1 node-CRUD reachback tool with four endpoints under
 * `/api/rfs/:canvasId`:
 *
 * - `GET  download/<path>` — fetch a node/artifact/upload file as raw bytes.
 *   Node metadata rides along in `X-Huabu-*` response headers (ASCII-safe
 *   subset). `Accept: application/json` instead returns a {@link RfsNodeView}.
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
 * The minimal, stable subset of node attributes exposed to external agents.
 *
 * Split by transport:
 * - `id`, `type`, `src`, `locked` are **ASCII-safe** and mirrored into the
 *   `X-Huabu-*` response headers on a byte download (see {@link RFS_HEADERS}).
 * - `label` may contain arbitrary Unicode, so it is carried **only** in the
 *   JSON {@link RfsNodeView} — never in a header.
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
  /** Display label (Unicode; JSON view only, never a header). */
  label: z.string().optional(),
  /**
   * Artifact/URL reference for media nodes (image/pdf/video/…). The storage
   * key or URL as persisted in `data.src`. ASCII in practice; header-safe.
   */
  src: z.string().optional(),
  /** Whether the node is locked against move/resize/auto-layout. */
  locked: z.boolean().optional(),
});

export type RfsNodeMeta = z.infer<typeof rfsNodeMetaSchema>;

/**
 * A single graph edge incident to a node, in the JSON {@link RfsNodeView}.
 * Lets an agent reason about local structure without a separate call.
 */
export const rfsEdgeSchema = z.object({
  /** Edge id. */
  id: z.string(),
  /** Source node id. */
  source: z.string(),
  /** Target node id. */
  target: z.string(),
});

export type RfsEdge = z.infer<typeof rfsEdgeSchema>;

/**
 * JSON representation of a node file, returned by `GET download/<path>` when
 * the caller sends `Accept: application/json`. Bundles the full (Unicode-safe)
 * metadata, the file body as text, and incident edges so an agent can inspect a
 * node in one round-trip.
 */
export const rfsNodeViewSchema = z.object({
  /** Full metadata allow-list (includes `label`). */
  meta: rfsNodeMetaSchema,
  /** The file body as UTF-8 text (frontmatter included, verbatim). */
  content: z.string(),
  /** Edges touching this node (either direction). */
  edges: z.array(rfsEdgeSchema),
});

export type RfsNodeView = z.infer<typeof rfsNodeViewSchema>;

// ==================== Response headers ====================

/**
 * Canonical `X-Huabu-*` response header names carrying the ASCII-safe metadata
 * subset on a raw byte download. Centralised so server and any client helper
 * agree on the exact casing. `label` is deliberately absent (Unicode-unsafe for
 * HTTP headers) — read it from the JSON view instead.
 */
export const RFS_HEADERS = {
  /** `X-Huabu-Node-Id` — the node id. */
  nodeId: 'X-Huabu-Node-Id',
  /** `X-Huabu-Node-Type` — one of {@link CANVAS_NODE_TYPES}. */
  nodeType: 'X-Huabu-Node-Type',
  /** `X-Huabu-Src` — artifact/URL ref for media nodes, when present. */
  src: 'X-Huabu-Src',
  /** `X-Huabu-Locked` — `'true'`/`'false'` when the node is locked. */
  locked: 'X-Huabu-Locked',
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
