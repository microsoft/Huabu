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
} from '@sediment/shared';

import type { CanvasStore, NodeContent } from '../storage/canvas-store.js';

/** Window of characters shown around each match in `snippet`. */
const SNIPPET_RADIUS = 60;

/** Maximum matches emitted per node per field — keeps one huge body
 *  from drowning out everything else. */
const MAX_HITS_PER_FIELD = 3;

/**
 * Loose shape of a persisted node (id + type + data). We avoid coupling
 * to the route layer's `NodeLike` so the scanner can also be driven
 * directly by tests.
 */
export interface SearchableNode {
  id: string;
  type: string;
}

export interface RunSearchOptions {
  /** Persisted canvas state nodes — supplies node ids + types. */
  nodes: readonly SearchableNode[];
  /** Single-shot sidecar snapshot. Keyed by node id. */
  contentByNodeId: ReadonlyMap<string, NodeContent>;
  /** Request as parsed by zod (already validated). */
  request: CanvasSearchRequest;
  /** Sink for stream frames. Called synchronously per emit. */
  emit: (event: CanvasSearchEvent) => void;
  /** Optional abort signal. Polled between nodes. */
  signal?: AbortSignal;
}

const DEFAULT_LIMIT = 50;
const ALL_FIELDS: readonly SearchField[] = [
  'label',
  'summary',
  'keywords',
  'content',
];

/**
 * In-memory driver. Walks the requested fields tier-by-tier, emits
 * `match` frames as it finds hits, and closes with a `done` frame.
 *
 * This entry point takes a fully-materialised `contentByNodeId` map
 * and never touches disk — used by tests and any callers that already
 * have a hydrated snapshot. The production route uses
 * {@link searchCanvas} instead, which streams sidecars off disk and
 * forwards matches as each lands.
 *
 * Caller responsibilities:
 *   - Validate `request` first (zod safeParse) — we trust the input.
 *   - Wrap the call in try/catch and emit an `error` frame on throw.
 */
export function runCanvasSearch(opts: RunSearchOptions): void {
  const { nodes, contentByNodeId, request, emit, signal } = opts;
  const limit = request.limit ?? DEFAULT_LIMIT;
  const fields = new Set<SearchField>(request.fields ?? ALL_FIELDS);

  const needle = request.query;
  const needleLower = needle.toLowerCase();
  const needleLen = needle.length;

  // Apply node-id / node-type filters once up front so both tiers
  // walk the same set in the same order (callers rely on the order
  // for deterministic test output).
  const candidates = filterCandidates(nodes, request);

  let totalEmitted = 0;
  let truncated = false;

  const tryEmitMatch = (
    tier: 'meta' | 'content',
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

  // ── Tier 1: metadata (label / summary / keywords) ────────────────────
  const wantsMeta = META_SEARCH_FIELDS.some((f) => fields.has(f));
  if (wantsMeta) {
    for (const node of candidates) {
      if (signal?.aborted) return;
      if (totalEmitted >= limit) {
        truncated = true;
        break;
      }
      const content = contentByNodeId.get(node.id);
      scanNodeMeta(node, content, fields, needleLower, needleLen, (m) =>
        tryEmitMatch('meta', m),
      );
    }
  }

  // Always emit a `meta-done` boundary so the client can flip its
  // "searching titles…" indicator to "searching contents…" even when
  // the meta tier was empty.
  emit({ type: 'progress', phase: 'meta-done' });

  // ── Tier 2: content (markdown body) ──────────────────────────────────
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
      // Coarse progress every 25 nodes so a 100+ node canvas can show
      // a determinate bar without flooding the wire.
      if (scanned % 25 === 0 && scanned < total) {
        emit({ type: 'progress', phase: 'content', scanned, total });
      }
    }
  }

  emit({ type: 'done', total: totalEmitted, truncated });
}

// ─── Internals ──────────────────────────────────────────────────────────────

/** Shared filter used by both the in-memory and the streaming driver. */
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

interface FieldEmitContext {
  nodeId: string;
  nodeType: string;
  label: string | null;
  /** Returns false when the global limit is exhausted. */
  tryEmit: (match: CanvasSearchMatch) => boolean;
}

/**
 * Find up to {@link MAX_HITS_PER_FIELD} occurrences of `needleLower`
 * inside `haystack` (case-insensitive). For each, build a
 * SNIPPET_RADIUS-wide window centred on the hit and emit a match.
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
  const lower = haystack.toLowerCase();
  let from = 0;
  let count = 0;
  while (count < MAX_HITS_PER_FIELD) {
    const idx = lower.indexOf(needleLower, from);
    if (idx === -1) break;
    const snippet = buildSnippet(haystack, idx, needleLen);
    const keepGoing = ctx.tryEmit({
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
    });
    if (!keepGoing) return;
    from = idx + Math.max(1, needleLen);
    count += 1;
  }
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
    out.push({ id, type: typeof type === 'string' ? type : '' });
  }
  return out;
}

/**
 * Drive a search directly off a {@link CanvasStore}.
 *
 * Streams meta-tier matches as each sidecar lands (no `await`-all
 * barrier in front of the first emit). Content tier runs after the
 * stream settles, scanning the in-memory cache that was built as a
 * side effect of the meta walk — zero extra disk reads.
 */
export async function searchCanvas(
  store: CanvasStore,
  request: CanvasSearchRequest,
  emit: (event: CanvasSearchEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const file = store.read();
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
    tier: 'meta' | 'content',
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
  const contentByNodeId = await store.streamAllNodes((id, content) => {
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
  }, signal);

  if (signal?.aborted) return;

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

  emit({ type: 'done', total: totalEmitted, truncated });
}
