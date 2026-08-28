// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Per-canvas full-text search.
 *
 * Two-tier scan:
 *   1. **Metadata tier** (label / summary / keywords) — emitted as each
 *      sidecar lands via `CanvasStore.streamAllNodes`. Matches start
 *      flowing to the client after the very first `.md` read resolves,
 *      not after the whole directory has been pulled into memory, so
 *      perceived latency is bounded by the slowest single file rather
 *      than the full scan.
 *   2. **Content tier** (markdown body) — scans the same `NodeContent`
 *      bodies already cached by step 1. No additional disk reads.
 *
 * Why no application-level caching:
 *   Search is low-frequency. The OS page cache handles repeated reads
 *   transparently, and adding our own cache would cost permanent RAM
 *   plus an invalidation surface across every sidecar write path. If a
 *   single canvas grows past ~30 MB of sidecar text, the right next
 *   step is swapping the scan for spawned `ripgrep`, not in-process
 *   caching. See discussion in #search-architecture for the call.
 *
 * Cancellation:
 *   The caller passes a `signal` (AbortSignal-like — we only need
 *   `.aborted` polling). Workers inside `streamAllNodes` short-circuit
 *   when the signal aborts, and the content-tier loop checks before
 *   each node so a superseded keystroke doesn't waste CPU.
 *
 * Output:
 *   Pure data — matches are pushed to the supplied `emit` callback so
 *   the route layer owns the framing (NDJSON, in our case). Keeps the
 *   scan testable without spinning up Fastify.
 */

import {
  META_SEARCH_FIELDS,
  type CanvasSearchEvent,
  type CanvasSearchMatch,
  type CanvasSearchRequest,
  type SearchField,
} from '@huabu/shared';

import { agenetes } from '../agent/agenetes/drivers.js';
import { chatEnvelopeFromSubmission } from '../agent/agenetes/handle.js';
import { canvasAcpNamespace } from '../workspace/paths.js';

import type { NodeContent, Space } from '../storage/index.js';
import type { AgentTurn } from '@agenetes/protocol';

/** Window of characters shown around each match in `snippet`. */
const SNIPPET_RADIUS = 60;

/**
 * Per-(node, field) hits are not capped here on the server. The only
 * back-pressure is the global request `limit` — once that many matches
 * have been emitted across all (node, field) groups, the scan stops
 * and the `done` frame carries `truncated: true`. The client renders
 * a banner explaining the user should narrow their query.
 *
 * Rationale: capping per-(node, field) (the old `MAX_HITS_PER_FIELD = 3`)
 * silently hid hits beyond the cap with no UI affordance, so users had
 * no way to tell whether a node had 3 matches or 300. The global cap
 * is a single, surfaceable limit that matches VS Code's behaviour.
 */

/**
 * Loose shape of a persisted node (id + type + data). We avoid coupling
 * to the route layer's `NodeLike` so the scanner can also be driven
 * directly by tests.
 */
export interface SearchableNode {
  id: string;
  type: string;
  /**
   * Chat thread this node owns, if any. Only question nodes set
   * `data.threadId`; drives the `conversation` search tier. Undefined
   * for every other node type.
   */
  threadId?: string;
}

/**
 * Loose shape of a persisted edge for the scanner. Carries only what
 * we actually search on (`label`) plus the endpoints so the client
 * can `fitView` on both ends when the user activates a result.
 */
export interface SearchableEdge {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  /** `data.edgeStyle.label` if set, else `null`. */
  label: string | null;
}

const DEFAULT_LIMIT = 1000;
const ALL_FIELDS: readonly SearchField[] = [
  'label',
  'summary',
  'keywords',
  'content',
  'conversation',
];

// ─── Internals ──────────────────────────────────────────────────────────────

/** Shared filter used by the streaming driver. */
function filterCandidates(
  nodes: readonly SearchableNode[],
  request: CanvasSearchRequest,
): SearchableNode[] {
  const nodeTypes = request.nodeTypes?.length
    ? new Set(request.nodeTypes)
    : null;
  return nodes.filter((n) => {
    if (request.nodeId && n.id !== request.nodeId) return false;
    if (nodeTypes && !nodeTypes.has(n.type)) return false;
    return true;
  });
}

/**
 * Edge counterpart to {@link filterCandidates}.
 *
 * Edges have no concept of `nodeType`, so the `nodeTypes` request
 * filter applies indirectly: an edge is kept only when at least one
 * of its endpoints survives the node-type filter. Without this an
 * `nodeTypes: ['note']`-scoped search would still surface edges
 * connecting two non-note nodes, which is surprising. The single
 * `nodeId` filter is handled upstream (we skip edge scanning entirely
 * when `request.nodeId` is set \u2014 a per-node search asked for that
 * node's content, not its surrounding connections).
 */
function filterEdgeCandidates(
  edges: readonly SearchableEdge[],
  request: CanvasSearchRequest,
  candidateNodes: readonly SearchableNode[],
): SearchableEdge[] {
  if (!request.nodeTypes?.length) return [...edges];
  const allowedNodeIds = new Set(candidateNodes.map((n) => n.id));
  return edges.filter(
    (e) =>
      allowedNodeIds.has(e.sourceNodeId) || allowedNodeIds.has(e.targetNodeId),
  );
}

/** Emit all label/summary/keywords matches for one node. */
function scanNodeMeta(
  node: SearchableNode,
  content: NodeContent | undefined,
  fields: Set<SearchField>,
  needleLower: string,
  needleLen: number,
  tryEmit: (match: CanvasSearchMatch) => boolean,
): void {
  const label = content?.label ?? null;
  if (fields.has('label') && label) {
    emitFieldHits('label', label, needleLower, needleLen, {
      nodeId: node.id,
      nodeType: node.type,
      label,
      tryEmit,
    });
  }
  if (fields.has('summary')) {
    const summary = stringFrontmatter(content, 'summary');
    if (summary) {
      emitFieldHits('summary', summary, needleLower, needleLen, {
        nodeId: node.id,
        nodeType: node.type,
        label,
        tryEmit,
      });
    }
  }
  if (fields.has('keywords')) {
    const keywords = stringArrayFrontmatter(content, 'keywords');
    if (keywords && keywords.length > 0) {
      const joined = keywords.join(', ');
      emitFieldHits('keywords', joined, needleLower, needleLen, {
        nodeId: node.id,
        nodeType: node.type,
        label,
        tryEmit,
      });
    }
  }
}

/** Emit all content-body matches for one node. */
function scanNodeContent(
  node: SearchableNode,
  content: NodeContent | undefined,
  needleLower: string,
  needleLen: number,
  tryEmit: (match: CanvasSearchMatch) => boolean,
): void {
  const body = content?.content;
  if (typeof body === 'string' && body.length > 0) {
    emitFieldHits('content', body, needleLower, needleLen, {
      nodeId: node.id,
      nodeType: node.type,
      label: content?.label ?? null,
      tryEmit,
    });
  }
}

/**
 * Flatten one chat thread into a single searchable haystack: every
 * user message (`envelope.user.text`) followed by every assistant
 * *text* block, turn by turn. Tool calls / tool results, thinking
 * blocks, and the ACP `plan` overlay are intentionally dropped — the
 * `conversation` tier searches what the human and the model *said*,
 * not the tool plumbing in between.
 *
 * Segments are joined with `\n\n` so a match never silently bridges a
 * user message and an unrelated reply, while `buildSnippet`'s
 * whitespace collapse still renders them on one row.
 */
function buildThreadHaystack(turns: readonly AgentTurn[]): string {
  const segments: string[] = [];
  for (const turn of turns) {
    const userText = chatEnvelopeFromSubmission(turn.request)?.user?.text;
    if (typeof userText === 'string' && userText.length > 0) {
      segments.push(userText);
    }
    for (const msg of turn.transcript) {
      // Only assistant prose contributes model speech; `tool_call`,
      // `thinking`, `plan`, and `error` fragments are excluded.
      if (msg.type !== 'text') continue;
      const text = msg.data.content;
      if (typeof text === 'string' && text.length > 0) segments.push(text);
    }
  }
  return segments.join('\n\n');
}

/**
 * Emit all conversation matches for one threaded node. Reads the node's
 * chat thread synchronously (one `<threadId>.turns.jsonl` read), so the
 * caller must gate this on `fields.has('conversation')` and the global
 * limit before invoking. No-op when the node owns no thread or the
 * thread is empty.
 */
function scanNodeConversation(
  node: SearchableNode,
  canvasId: string,
  label: string | null,
  needleLower: string,
  needleLen: number,
  tryEmit: (match: CanvasSearchMatch) => boolean,
): void {
  if (!node.threadId) return;
  const { turns } = agenetes.history(
    canvasAcpNamespace(canvasId),
    node.threadId,
  );
  if (turns.length === 0) return;
  const haystack = buildThreadHaystack(turns);
  if (haystack.length === 0) return;
  emitFieldHits('conversation', haystack, needleLower, needleLen, {
    nodeId: node.id,
    nodeType: node.type,
    label,
    tryEmit,
  });
}

/**
 * Walk every occurrence of `needleLower` inside `haystack`
 * (case-insensitive) and let the caller shape each match. Centralises
 * the lowercase-`indexOf` loop, snippet construction, and zero-width
 * progress guard so the per-(node, field) scanner and the per-edge
 * scanner can't drift on `from = idx + max(1, needleLen)` or on the
 * `occurrenceIndex` ordinal.
 *
 * Uses `String.prototype.indexOf` on the lower-cased haystack — V8's
 * implementation is a SIMD-accelerated literal search and runs at
 * ~1 GB/s, fast enough for typical canvas sidecars without a
 * dedicated regex compiler.
 */
function scanOccurrences(
  haystack: string,
  needleLower: string,
  needleLen: number,
  tryEmit: (match: CanvasSearchMatch) => boolean,
  buildMatch: (
    snippet: { text: string; matchStart: number; matchLength: number },
    occurrenceIndex: number,
  ) => CanvasSearchMatch,
): void {
  const lower = haystack.toLowerCase();
  let from = 0;
  // 0-based ordinal of the hit *within this scan*. The wire contract
  // documents `occurrenceIndex` as monotonically increasing per
  // (entity, field), and every caller invokes `scanOccurrences` once
  // per entity+field, so a local counter is enough. Survives
  // truncation: if the global limit chokes us mid-loop the indices
  // already shipped are 0..k-1 and map cleanly to the n-th DOM
  // occurrence on the client.
  let occurrenceIndex = 0;
  while (true) {
    const idx = lower.indexOf(needleLower, from);
    if (idx === -1) return;
    const snippet = buildSnippet(haystack, idx, needleLen);
    if (!tryEmit(buildMatch(snippet, occurrenceIndex))) return;
    // `max(1, needleLen)` guards against a zero-width needle locking
    // the loop — schema-bounded to >= 1 char today, but cheap insurance.
    from = idx + Math.max(1, needleLen);
    occurrenceIndex += 1;
  }
}

/**
 * Emit every match in one edge's label. Edge matches are tagged
 * `kind: 'edge'` so the client can render them with an edge-shaped
 * icon and `fitView` on both endpoints instead of trying to open an
 * (non-existent) preview. `nodeId` carries the edge's id — the field
 * is named for back-compat with the original node-only schema but
 * semantically means "the matched entity's primary id".
 */
function scanEdgeLabel(
  edge: SearchableEdge,
  needleLower: string,
  needleLen: number,
  tryEmit: (match: CanvasSearchMatch) => boolean,
): void {
  const label = edge.label;
  if (!label) return;
  scanOccurrences(
    label,
    needleLower,
    needleLen,
    tryEmit,
    (snippet, occurrenceIndex) => ({
      kind: 'edge',
      nodeId: edge.id,
      nodeType: 'edge',
      label,
      field: 'label',
      snippet: snippet.text,
      matchStart: snippet.matchStart,
      matchLength: snippet.matchLength,
      occurrenceIndex,
      sourceNodeId: edge.sourceNodeId,
      targetNodeId: edge.targetNodeId,
    }),
  );
}

interface FieldEmitContext {
  nodeId: string;
  nodeType: string;
  label: string | null;
  /** Returns false when the global limit is exhausted. */
  tryEmit: (match: CanvasSearchMatch) => boolean;
}

/**
 * Find every occurrence of `needleLower` inside `haystack`
 * (case-insensitive). For each, build a SNIPPET_RADIUS-wide window
 * centred on the hit and emit a match. Stops only when the global
 * request limit is exhausted (signalled by `tryEmit` returning false)
 * or the haystack runs out — there is no per-field cap.
 *
 * Uses `String.prototype.indexOf` on the lower-cased haystack — V8's
 * implementation is a SIMD-accelerated literal search and runs at
 * ~1 GB/s, fast enough for typical canvas sidecars without a dedicated
 * regex compiler.
 */
function emitFieldHits(
  field: SearchField,
  haystack: string,
  needleLower: string,
  needleLen: number,
  ctx: FieldEmitContext,
): void {
  scanOccurrences(
    haystack,
    needleLower,
    needleLen,
    ctx.tryEmit,
    (snippet, occurrenceIndex) => ({
      nodeId: ctx.nodeId,
      nodeType: ctx.nodeType,
      label: ctx.label,
      field,
      snippet: snippet.text,
      matchStart: snippet.matchStart,
      // Use the *collapsed* match length so the highlighted slice in
      // the snippet aligns with the actual painted span. Returning
      // `needleLen` here would over-extend when the match contained
      // whitespace runs (e.g. needle `"a  b"`, snippet `"a b"`).
      matchLength: snippet.matchLength,
      occurrenceIndex,
    }),
  );
}

/**
 * Extract a ~120-char window around a match. Collapses runs of
 * whitespace (incl. newlines) into single spaces so the snippet fits
 * on one row in the result list, then prefixes / suffixes ellipses
 * when the window was clipped at either end.
 */
function buildSnippet(
  haystack: string,
  matchAbs: number,
  matchLen: number,
): { text: string; matchStart: number; matchLength: number } {
  const winStart = Math.max(0, matchAbs - SNIPPET_RADIUS);
  const winEnd = Math.min(
    haystack.length,
    matchAbs + matchLen + SNIPPET_RADIUS,
  );

  const preRaw = haystack.slice(winStart, matchAbs);
  const matchRaw = haystack.slice(matchAbs, matchAbs + matchLen);
  const postRaw = haystack.slice(matchAbs + matchLen, winEnd);

  const preCollapsed = preRaw.replace(/\s+/g, ' ');
  const matchCollapsed = matchRaw.replace(/\s+/g, ' ');
  const postCollapsed = postRaw.replace(/\s+/g, ' ');

  let text = preCollapsed + matchCollapsed + postCollapsed;
  let matchStart = preCollapsed.length;
  if (winStart > 0) {
    text = '…' + text;
    matchStart += 1;
  }
  if (winEnd < haystack.length) {
    text = text + '…';
  }
  return { text, matchStart, matchLength: matchCollapsed.length };
}

function stringFrontmatter(
  content: NodeContent | undefined,
  key: string,
): string | null {
  if (!content) return null;
  const raw = content[key];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

function stringArrayFrontmatter(
  content: NodeContent | undefined,
  key: string,
): string[] | null {
  if (!content) return null;
  const raw = content[key];
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === 'string' && item.length > 0) out.push(item);
  }
  return out.length > 0 ? out : null;
}

/**
 * Adapter: collect persisted nodes from a `CanvasStore.read()` payload.
 * Lives here so the route layer can stay thin and tests can synthesise
 * canvas state without touching disk.
 */
export function extractSearchableNodes(state: unknown): SearchableNode[] {
  if (!state || typeof state !== 'object') return [];
  const maybeNodes = (state as { nodes?: unknown }).nodes;
  if (!Array.isArray(maybeNodes)) return [];
  const out: SearchableNode[] = [];
  for (const raw of maybeNodes) {
    if (!raw || typeof raw !== 'object') continue;
    const id = (raw as { id?: unknown }).id;
    const type = (raw as { type?: unknown }).type;
    if (typeof id !== 'string' || !id) continue;
    // `data.threadId` is only ever set on question nodes; carry it so
    // the conversation tier can locate the owning chat thread.
    let threadId: string | undefined;
    const data = (raw as { data?: unknown }).data;
    if (data && typeof data === 'object') {
      const rawThreadId = (data as { threadId?: unknown }).threadId;
      if (typeof rawThreadId === 'string' && rawThreadId) {
        threadId = rawThreadId;
      }
    }
    out.push({
      id,
      type: typeof type === 'string' ? type : '',
      ...(threadId ? { threadId } : {}),
    });
  }
  return out;
}

/**
 * Adapter: collect persisted edges from a `CanvasStore.read()` payload.
 * Reads only what the scanner needs (`id`, endpoints, `label`); other
 * `EdgeStyle` fields (lineStyle, stroke, …) are intentionally
 * dropped so the in-memory footprint stays bounded.
 */
export function extractSearchableEdges(state: unknown): SearchableEdge[] {
  if (!state || typeof state !== 'object') return [];
  const maybeEdges = (state as { edges?: unknown }).edges;
  if (!Array.isArray(maybeEdges)) return [];
  const out: SearchableEdge[] = [];
  for (const raw of maybeEdges) {
    if (!raw || typeof raw !== 'object') continue;
    const id = (raw as { id?: unknown }).id;
    const source = (raw as { source?: unknown }).source;
    const target = (raw as { target?: unknown }).target;
    if (typeof id !== 'string' || !id) continue;
    if (typeof source !== 'string' || !source) continue;
    if (typeof target !== 'string' || !target) continue;
    // Label lives at `data.edgeStyle.label` (see `LabelledEdge.tsx`
    // and the 2026-06-08 changelog entry for the storage layout).
    const data = (raw as { data?: unknown }).data;
    let label: string | null = null;
    if (data && typeof data === 'object') {
      const edgeStyle = (data as { edgeStyle?: unknown }).edgeStyle;
      if (edgeStyle && typeof edgeStyle === 'object') {
        const rawLabel = (edgeStyle as { label?: unknown }).label;
        if (typeof rawLabel === 'string' && rawLabel.length > 0) {
          label = rawLabel;
        }
      }
    }
    out.push({ id, sourceNodeId: source, targetNodeId: target, label });
  }
  return out;
}

/**
 * Drive a search off one Space.
 *
 * Streams meta-tier matches as each record lands (no `await`-all
 * barrier in front of the first emit). Content tier runs after the
 * stream settles, scanning the in-memory cache that was built as a
 * side effect of the meta walk — zero extra reads.
 */
export async function searchCanvas(
  handle: Space,
  request: CanvasSearchRequest,
  emit: (event: CanvasSearchEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const file = await handle.read();
  if (!file) {
    emit({ type: 'error', message: 'Canvas not found' });
    return;
  }

  const allNodes = extractSearchableNodes(file.state);
  const candidates = filterCandidates(allNodes, request);
  const candidateById = new Map(candidates.map((n) => [n.id, n] as const));

  const limit = request.limit ?? DEFAULT_LIMIT;
  const fields = new Set<SearchField>(request.fields ?? ALL_FIELDS);
  const needle = request.query;
  const needleLower = needle.toLowerCase();
  const needleLen = needle.length;
  const wantsMeta = META_SEARCH_FIELDS.some((f) => fields.has(f));

  let totalEmitted = 0;
  let truncated = false;

  const tryEmitMatch = (
    tier: 'meta' | 'content' | 'conversation',
    match: CanvasSearchMatch,
  ): boolean => {
    if (totalEmitted >= limit) {
      truncated = true;
      return false;
    }
    emit({ type: 'match', tier, match });
    totalEmitted += 1;
    return true;
  };

  // ── Tier 1 (streaming): emit meta matches as sidecars land.
  //
  // `streamAllNodes` reads sidecars with bounded concurrency and
  // invokes the callback synchronously as each file resolves, so a
  // match against the very first parsed file ships before any of the
  // remaining files are even opened.
  const streamed = await handle.nodes.stream(
    (snapshot) => {
      const id = snapshot.record.nodeId;
      const content = snapshot.record;
      if (signal?.aborted) return;
      if (!wantsMeta) return;
      if (totalEmitted >= limit) {
        truncated = true;
        return;
      }
      const node = candidateById.get(id);
      // Skip sidecars that belong to nodes filtered out by
      // `nodeId` / `nodeTypes` — we still read them (the directory
      // walk is unfiltered) but they contribute nothing here.
      if (!node) return;
      scanNodeMeta(node, content, fields, needleLower, needleLen, (m) =>
        tryEmitMatch('meta', m),
      );
    },
    signal ? { signal } : undefined,
  );
  const contentByNodeId = new Map<string, NodeContent>();
  for (const [id, snapshot] of streamed) {
    contentByNodeId.set(id, snapshot.record);
  }

  if (signal?.aborted) return;

  // Edge labels live in topology (no sidecar read needed), so
  // scan them synchronously once the streaming meta tier has flushed.
  // Same gating as the in-memory driver: skip when the request is
  // scoped to a single node (a per-node search isn't asking about
  // edges) or when `label` isn't in the requested field set.
  if (
    !signal?.aborted &&
    fields.has('label') &&
    !request.nodeId &&
    totalEmitted < limit
  ) {
    const allEdges = extractSearchableEdges(file.state);
    if (allEdges.length > 0) {
      const edgeCandidates = filterEdgeCandidates(
        allEdges,
        request,
        candidates,
      );
      for (const edge of edgeCandidates) {
        if (signal?.aborted) return;
        if (totalEmitted >= limit) {
          truncated = true;
          break;
        }
        scanEdgeLabel(edge, needleLower, needleLen, (m) =>
          tryEmitMatch('meta', m),
        );
      }
    }
  }

  emit({ type: 'progress', phase: 'meta-done' });

  // ── Tier 2: content scan over the same in-memory cache. No disk I/O.
  if (fields.has('content') && totalEmitted < limit) {
    const total = candidates.length;
    let scanned = 0;
    for (const node of candidates) {
      if (signal?.aborted) return;
      if (totalEmitted >= limit) {
        truncated = true;
        break;
      }
      const content = contentByNodeId.get(node.id);
      scanNodeContent(node, content, needleLower, needleLen, (m) =>
        tryEmitMatch('content', m),
      );
      scanned += 1;
      if (scanned % 25 === 0 && scanned < total) {
        emit({ type: 'progress', phase: 'content', scanned, total });
      }
    }
  }

  // ── Tier 3: conversation scan over question-node chat threads.
  //
  // Heaviest tier: one synchronous `<threadId>.turns.jsonl` read per
  // threaded candidate. Gated on the `conversation` field and skipped
  // entirely for single-node (`nodeId`) preview searches, which ask
  // about a node's own body, not its chat history. Only question nodes
  // carry a `threadId`; threads not anchored to a node are out of scope.
  if (fields.has('conversation') && !request.nodeId && totalEmitted < limit) {
    const threaded = candidates.filter((n) => n.threadId);
    const total = threaded.length;
    let scanned = 0;
    for (const node of threaded) {
      if (signal?.aborted) return;
      if (totalEmitted >= limit) {
        truncated = true;
        break;
      }
      const content = contentByNodeId.get(node.id);
      const label = content?.label ?? null;
      scanNodeConversation(
        node,
        handle.canvasId,
        label,
        needleLower,
        needleLen,
        (m) => tryEmitMatch('conversation', m),
      );
      scanned += 1;
      if (scanned % 25 === 0 && scanned < total) {
        emit({ type: 'progress', phase: 'conversation', scanned, total });
      }
    }
  }

  emit({ type: 'done', total: totalEmitted, truncated });
}
