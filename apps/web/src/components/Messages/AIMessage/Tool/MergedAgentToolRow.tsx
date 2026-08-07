// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * MergedAgentToolRow — collapsible row that merges N adjacent calls
 * to the same built-in agent tool (`read`, `grep`, `find`, `ls`,
 * `inspect_nodes`, `get_canvas_outline`) into a single self-describing
 * summary, expanding to per-call detail on click.
 */

import { Check, ChevronRight, X as XIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { partIsExecuting, truncate, type ToolPart } from './helpers';
import { ToolKindIcon } from './ToolKindIcon';
import { Loading } from '../../../Common/Loading';
import { NodeRef } from '../../../Common/NodeRef';

import type { AgentToolPart } from '@huabu/shared';

/**
 * Canvas-relative path of a node markdown sidecar (`nodes/<safeLabel>.md`).
 * Only these files carry a `frontmatter.id` that is a real canvas node id —
 * skill / memory / reference files also have an `id:` frontmatter (e.g. a
 * SKILL.md's skill id), so keying a `NodeRef` off `frontmatter.id` alone
 * would mis-render those as (dead) node chips. Gate the ref on the path.
 */
const NODE_FILE_RE = /^nodes\/[^/]+\.md$/;

/**
 * Whether a single agent-tool part represents a FAILED call. Checks, in
 * order: the ACP lifecycle status, the ToolResponse `status`, and — for
 * `read` — the path invariant (a genuine read always returns a `path`, so
 * a `success`-status read with no path is a failure projected onto an
 * older history shape where the error text lives in `data.content`).
 */
function partFailed(part: AgentToolPart): boolean {
  if (part.status === 'failed') return true;
  const data = part.data;
  if (!data) return false;
  if (data.status === 'error') return true;
  if (part.toolName === 'read' && data.status === 'success') {
    const payload = (data.data ?? {}) as Record<string, unknown>;
    if (typeof payload.path !== 'string') return true;
  }
  return false;
}

/**
 * Human-readable error text for a FAILED agent-tool part, or `null` when
 * the call succeeded. Generic across tools — reads the message from
 * whichever history shape carries it: the error ToolResponse `error`
 * field (new), or `data.content` (older shape that projected a thrown
 * handler as a `success` envelope with the message in the body).
 */
function partErrorText(
  part: AgentToolPart,
  failedFallback = 'Failed',
): string | null {
  if (!partFailed(part)) return null;
  const data = part.data as { error?: unknown; data?: unknown } | undefined;
  if (typeof data?.error === 'string' && data.error) return data.error;
  const payload = (data?.data ?? {}) as Record<string, unknown>;
  if (typeof payload.content === 'string' && payload.content)
    return payload.content;
  if (typeof payload.path === 'string' && payload.path)
    return `${failedFallback}: ${payload.path}`;
  return failedFallback;
}

/**
 * One-line summary of a SUCCESSFUL agent-tool call, used as the per-call
 * detail row when a merged row (grep / find / ls / get_canvas_outline /
 * …) is expanded. `read` and `inspect_nodes` have their own richer
 * per-item renderers and don't go through here.
 */
function callSummary(
  part: AgentToolPart,
  labels: {
    match: (count: number) => string;
    file: (count: number) => string;
    entry: (count: number) => string;
    canvasOutline: string;
    connection: (count: number) => string;
    updatedPath: (path: string) => string;
    updatedFile: string;
  },
): string {
  const payload = ((part.data as { data?: unknown } | undefined)?.data ??
    {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' ? v : 0);
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  switch (part.toolName) {
    case 'grep': {
      const c = num(payload.count);
      const pat = str(payload.pattern);
      const matchLabel = labels.match(c);
      return pat ? `${pat} — ${matchLabel}` : matchLabel;
    }
    case 'find': {
      const c = num(payload.count);
      const pat = str(payload.pattern);
      const fileLabel = labels.file(c);
      return pat ? `${pat} — ${fileLabel}` : fileLabel;
    }
    case 'ls': {
      const p = str(payload.path);
      const c = num(payload.count);
      const entryLabel = labels.entry(c);
      return p ? `${p} — ${entryLabel}` : entryLabel;
    }
    case 'get_canvas_outline':
    case 'get_space_outline':
      return labels.canvasOutline;
    case 'inspect_edges':
      return labels.connection(num(payload.count));
    case 'fs_write': {
      const path = str(payload.path);
      return path ? labels.updatedPath(path) : labels.updatedFile;
    }
    default:
      return part.toolName;
  }
}

export function MergedAgentToolRow({
  tool,
  entries,
}: {
  tool: string;
  entries: ToolPart<AgentToolPart>[];
}) {
  const { t } = useTranslation();
  const [isExpanded, setIsExpanded] = useState(false);
  const count = entries.length;

  const isExecuting = entries.some((e) => partIsExecuting(e.part));
  const isError = entries.some((e) => partFailed(e.part));

  // For a merged `read` row (N>1 files), collect each call's outcome.
  // Success: the node's `frontmatter.id/label` (from `data.data`) drives a
  // clickable NodeRef. Failure: the requested path lives in `data.data.path`
  // on a live stream, but on a reloaded thread only the error message
  // ("Path not found: <path>") survives — so we fall back to that. A failed
  // read never gets a NodeRef (the path simply doesn't resolve to a node).
  const readEntries = useMemo(() => {
    if (tool !== 'read')
      return [] as Array<{
        path: string;
        text: string;
        ok: boolean;
        nodeId?: string;
      }>;
    return entries
      .map((e) => {
        const tr = e.part.data;
        const payload =
          ((tr as { data?: unknown } | undefined)?.data as
            | Record<string, unknown>
            | undefined) ?? {};
        const path = typeof payload.path === 'string' ? payload.path : '';
        const fm = (payload.frontmatter ?? {}) as Record<string, unknown>;
        // Only node sidecars (`nodes/*.md`) carry a real canvas node id in
        // their frontmatter; skill / memory / reference files also have an
        // `id:` field, so gate the NodeRef on the path to avoid rendering
        // those as dead node chips.
        const nodeId =
          NODE_FILE_RE.test(path) && typeof fm.id === 'string'
            ? (fm.id as string)
            : undefined;
        // A read that actually succeeded ALWAYS returns a `path`. Use that
        // as the source of truth for success — it survives every history
        // shape. (A failed read on an older server is projected as
        // `status:'success'` with the error text in `data.content` and no
        // path; treat that as a failure too.)
        const ok = tr?.status === 'success' && !!path;
        // Failure text via the shared helper (handles both history shapes),
        // prefixed with the attempted path when we still have it.
        const err = partErrorText(e.part, t('messages.failed')) ?? '';
        const text = ok ? path : path || err;
        return { path, text, ok, nodeId: ok ? nodeId : undefined };
      })
      .filter((x) => x.text || x.nodeId);
  }, [tool, entries, t]);

  // Generic per-call failures across ANY merged tool (e.g. an
  // `inspect_nodes` call that threw). Rendered as ✗ rows in the expanded
  // view so a failed call is never silently dropped just because it
  // produced no success payload.
  const failedEntries = useMemo(
    () =>
      entries
        .map((e) => partErrorText(e.part, t('messages.failed')))
        .filter((t): t is string => t !== null),
    [entries, t],
  );

  // Generic per-CALL detail rows for every tool that isn't `read` or
  // `inspect_nodes` (those have their own richer per-item renderers). One
  // row per call: a short success summary or the failure message, so any
  // merged row can expand to show its individual calls.
  const callEntries = useMemo(() => {
    if (tool === 'read' || tool === 'inspect_nodes')
      return [] as Array<{ ok: boolean; text: string }>;
    return entries.map((e) => {
      const ok = !partFailed(e.part);
      const text = ok
        ? callSummary(e.part, {
            match: (value) => t('messages.match', { count: value }),
            file: (value) => t('messages.file', { count: value }),
            entry: (value) => t('messages.entry', { count: value }),
            canvasOutline: t('messages.canvasOutline'),
            connection: (value) =>
              t('messages.inspectedConnections', { count: value }),
            updatedPath: (path) => t('messages.updatedPath', { path }),
            updatedFile: t('messages.updatedFile'),
          })
        : (partErrorText(e.part, t('messages.failed')) ?? t('messages.failed'));
      return { ok, text };
    });
  }, [tool, entries, t]);

  // Build merged title and content
  const { title, nodeRefs } = useMemo(() => {
    const emptyRefs: { nodeId?: string; label?: string }[] = [];

    if (tool === 'inspect_nodes') {
      // inspect_nodes returns `{ count, nodes: [{ id, label, ... }] }`.
      // One call may match many nodes; flatten across all calls so the
      // expanded view lists every matched node.
      const refs: { nodeId?: string; label?: string }[] = [];
      let totalMatched = 0;
      for (const e of entries) {
        const tr = e.part.data;
        const d =
          tr?.status === 'success'
            ? ((tr.data ?? {}) as Record<string, unknown>)
            : {};
        const nodes = Array.isArray(d.nodes)
          ? (d.nodes as Array<Record<string, unknown>>)
          : [];
        totalMatched += nodes.length;
        for (const n of nodes) {
          refs.push({
            nodeId: typeof n.id === 'string' ? n.id : undefined,
            label: typeof n.label === 'string' ? n.label : undefined,
          });
        }
      }
      return {
        title:
          count === 1
            ? totalMatched === 1
              ? t('messages.inspectedNodes', { count: 1 })
              : t('messages.inspectedNodes', { count: totalMatched })
            : t('messages.inspectedNodesMultipleCalls', { count }),
        nodeRefs: refs,
      };
    }

    if (tool === 'read') {
      const tr = entries[0]?.part.data;
      // `path` rides on `data.data` for both success and failure (seeded
      // from the provisional call args), so a single failed read still
      // shows which file it tried.
      const first =
        ((tr as { data?: unknown } | undefined)?.data as
          | Record<string, unknown>
          | undefined) ?? {};
      const firstPath = (first.path as string) || '';
      return {
        title:
          count === 1
            ? firstPath
              ? t('messages.readPath', { path: truncate(firstPath, 60) })
              : t('messages.readFile')
            : t('messages.readFiles', { count }),
        nodeRefs: emptyRefs,
      };
    }

    if (tool === 'grep') {
      // grep returns `{ matches, count, truncated }`; the searched
      // `pattern` rides on `data.data` (folded in from the call's input
      // args, not echoed by the tool). Surface it so a 0-match row still
      // tells the user WHAT was searched (older history without the arg
      // merge → fall back to the bare count).
      const totalMatches = entries.reduce((sum, e) => {
        const tr = e.part.data;
        const d =
          tr?.status === 'success'
            ? ((tr.data ?? {}) as Record<string, unknown>)
            : {};
        return sum + (typeof d.count === 'number' ? d.count : 0);
      }, 0);
      const firstData =
        entries[0]?.part.data?.status === 'success'
          ? ((entries[0].part.data.data ?? {}) as Record<string, unknown>)
          : {};
      const pattern =
        typeof firstData.pattern === 'string' ? firstData.pattern : '';
      const matchLabel = t('messages.match', { count: totalMatches });
      const query = pattern ? ` ${truncate(pattern, 40)}` : '';
      return {
        title:
          count === 1
            ? t('messages.grepTitle', {
                query,
                matches: matchLabel,
              })
            : t('messages.grepTitleMultipleCalls', {
                count,
                matches: matchLabel,
              }),
        nodeRefs: emptyRefs,
      };
    }

    if (tool === 'find') {
      // find returns `{ paths, count, truncated }`; the searched `pattern`
      // rides on `data.data` (folded in from the call's input args, not
      // echoed by the tool). Echo the glob in the title so a 0-result row
      // still tells the user WHAT was searched (older history without the
      // arg merge → fall back to the bare count).
      const totalPaths = entries.reduce((sum, e) => {
        const tr = e.part.data;
        const d =
          tr?.status === 'success'
            ? ((tr.data ?? {}) as Record<string, unknown>)
            : {};
        return sum + (typeof d.count === 'number' ? d.count : 0);
      }, 0);
      const firstData =
        entries[0]?.part.data?.status === 'success'
          ? ((entries[0].part.data.data ?? {}) as Record<string, unknown>)
          : {};
      const pattern =
        typeof firstData.pattern === 'string' ? firstData.pattern : '';
      const fileLabel = t('messages.file', { count: totalPaths });
      const query = pattern ? ` ${truncate(pattern, 40)}` : '';
      return {
        title:
          count === 1
            ? t('messages.findTitle', {
                query,
                files: fileLabel,
              })
            : t('messages.findTitleMultipleCalls', {
                count,
                files: fileLabel,
              }),
        nodeRefs: emptyRefs,
      };
    }

    if (tool === 'ls') {
      // ls returns `{ path, entries, count, limitReached }`.
      const tr = entries[0]?.part.data;
      const first =
        tr?.status === 'success'
          ? ((tr.data ?? {}) as Record<string, unknown>)
          : {};
      const firstPath = (first.path as string) || '';
      const firstCount = typeof first.count === 'number' ? first.count : 0;
      const entryLabel = t('messages.entry', { count: firstCount });
      return {
        title:
          count === 1
            ? firstPath
              ? t('messages.lsTitlePath', {
                  path: truncate(firstPath, 40),
                  entries: entryLabel,
                })
              : t('messages.lsTitle', { entries: entryLabel })
            : t('messages.lsTitleMultipleCalls', { count }),
        nodeRefs: emptyRefs,
      };
    }

    if (tool === 'get_canvas_outline' || tool === 'get_space_outline') {
      return {
        title:
          count === 1
            ? t('messages.readCanvasOutline')
            : t('messages.readCanvasOutlineMultipleCalls', { count }),
        nodeRefs: emptyRefs,
      };
    }

    if (tool === 'inspect_edges') {
      const totalEdges = entries.reduce((sum, entry) => {
        const data =
          entry.part.data?.status === 'success'
            ? ((entry.part.data.data ?? {}) as Record<string, unknown>)
            : {};
        return sum + (typeof data.count === 'number' ? data.count : 0);
      }, 0);
      return {
        title:
          count === 1
            ? t('messages.inspectedConnections', { count: totalEdges })
            : t('messages.inspectedConnectionsMultipleCalls', { count }),
        nodeRefs: emptyRefs,
      };
    }

    if (tool === 'fs_write') {
      const data =
        entries[0]?.part.data?.status === 'success'
          ? ((entries[0].part.data.data ?? {}) as Record<string, unknown>)
          : {};
      const path = typeof data.path === 'string' ? data.path : '';
      return {
        title:
          count === 1
            ? path
              ? t('messages.updatedPath', { path: truncate(path, 60) })
              : t('messages.updatedFile')
            : t('messages.updatedFiles', { count }),
        nodeRefs: emptyRefs,
      };
    }

    return { title: tool, nodeRefs: emptyRefs };
  }, [tool, entries, count, t]);

  const statusIcon = isExecuting ? (
    <Loading layout="inline" size="xs" className="text-info" />
  ) : isError ? (
    <XIcon size={12} className="text-danger" />
  ) : (
    <Check size={12} className="text-fg-muted" />
  );

  // Derive the icon from the first part — all parts in a merged row
  // share the same toolName by construction.
  const iconPart = entries[0]?.part;

  // Single inspect_nodes call that matched a single node → inline badge
  if (
    count === 1 &&
    tool === 'inspect_nodes' &&
    nodeRefs.length === 1 &&
    nodeRefs[0]?.nodeId
  ) {
    return (
      <div className="flex justify-start">
        <div className="w-full">
          <div className="text-fg-muted hover:bg-hover flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs transition-colors">
            {statusIcon}
            {iconPart && (
              <ToolKindIcon part={iconPart} className="text-fg-muted/60" />
            )}
            <span className="flex-1 truncate">
              {t('messages.inspected')}{' '}
              <NodeRef
                nodeId={nodeRefs[0].nodeId}
                fallbackLabel={nodeRefs[0].label}
              />
            </span>
          </div>
        </div>
      </div>
    );
  }

  // Single read → inline "Read <NodeRef | path>" so a lone read is just as
  // addressable as a merged one (node reads become a clickable NodeRef).
  if (count === 1 && tool === 'read' && readEntries[0]) {
    const entry = readEntries[0];
    return (
      <div className="flex justify-start">
        <div className="w-full">
          <div className="text-fg-muted hover:bg-hover flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs transition-colors">
            {statusIcon}
            {iconPart && (
              <ToolKindIcon part={iconPart} className="text-fg-muted/60" />
            )}
            <span className="flex-1 truncate">
              {t('messages.read')}{' '}
              {entry.ok && entry.nodeId ? (
                <NodeRef
                  nodeId={entry.nodeId}
                  fallbackLabel={entry.path || undefined}
                />
              ) : (
                <span
                  className={entry.ok ? '' : 'text-danger/80'}
                  title={entry.text}
                >
                  {entry.text || '?'}
                </span>
              )}
            </span>
          </div>
        </div>
      </div>
    );
  }

  // No expandable content → simple row. Expandability is driven by the
  // number of DETAIL ROWS to show, not the number of calls: a single
  // `inspect_nodes` call can match many nodes (count===1 yet 12 rows), and
  // must still expand. `read` uses its own per-file outcome list.
  const detailCount =
    tool === 'read'
      ? readEntries.length
      : tool === 'inspect_nodes'
        ? nodeRefs.length + failedEntries.length
        : callEntries.length;
  if (detailCount <= 1) {
    return (
      <div className="flex justify-start">
        <div className="w-full">
          <div className="text-fg-muted hover:bg-hover flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs transition-colors">
            {statusIcon}
            {iconPart && (
              <ToolKindIcon part={iconPart} className="text-fg-muted/60" />
            )}
            <span className="flex-1 truncate">{title}</span>
          </div>
        </div>
      </div>
    );
  }

  // Multiple entries with refs → expandable row
  return (
    <div className="flex justify-start">
      <div className="w-full">
        <div className="text-fg-muted hover:bg-hover flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors">
          {statusIcon}
          {iconPart && (
            <ToolKindIcon part={iconPart} className="text-fg-muted/60" />
          )}
          <button
            type="button"
            onClick={() => setIsExpanded(!isExpanded)}
            className="flex flex-1 items-center gap-1 truncate text-left"
          >
            <span>{title}</span>
            <ChevronRight
              size={10}
              className={`text-fg-muted/50 shrink-0 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
            />
          </button>
        </div>
        {isExpanded && (
          <div className="border-edge-default/40 ml-4 flex flex-col gap-1 border-l py-1 pl-3">
            {tool === 'read' ? (
              // read merges N calls; list each file with its outcome —
              // a successful node read renders a clickable NodeRef, a
              // failed one shows the attempted path with an error mark.
              readEntries.map((entry, i) => (
                <div
                  key={`${entry.text}-${i}`}
                  className="text-fg-muted flex items-center gap-1.5 text-xs"
                >
                  {entry.ok ? (
                    <Check size={11} className="text-fg-muted/60 shrink-0" />
                  ) : (
                    <XIcon size={11} className="text-danger shrink-0" />
                  )}
                  {entry.ok && entry.nodeId ? (
                    <NodeRef
                      nodeId={entry.nodeId}
                      fallbackLabel={entry.path || undefined}
                    />
                  ) : (
                    <span
                      className={`truncate ${entry.ok ? '' : 'text-danger/80'}`}
                      title={entry.text}
                    >
                      {entry.text || '?'}
                    </span>
                  )}
                </div>
              ))
            ) : tool === 'inspect_nodes' ? (
              <>
                {/* Failed inspect calls first, as ✗ rows. */}
                {failedEntries.map((msg, i) => (
                  <div
                    key={`fail-${i}`}
                    className="text-fg-muted flex items-center gap-1.5 text-xs"
                  >
                    <XIcon size={11} className="text-danger shrink-0" />
                    <span className="text-danger/80 truncate" title={msg}>
                      {msg}
                    </span>
                  </div>
                ))}
                {/* inspect_nodes flattens matched nodes across calls into
                    nodeRefs; render each as its own ✓ row. */}
                {nodeRefs.map((ref, i) =>
                  ref.nodeId ? (
                    <div
                      key={`${ref.nodeId}-${i}`}
                      className="text-fg-muted flex items-center gap-1.5 text-xs"
                    >
                      <Check size={11} className="text-fg-muted/60 shrink-0" />
                      <span className="truncate">
                        <NodeRef
                          nodeId={ref.nodeId}
                          fallbackLabel={ref.label}
                        />
                      </span>
                    </div>
                  ) : (
                    <div
                      key={`unknown-${i}`}
                      className="text-fg-muted flex items-center gap-1.5 text-xs"
                    >
                      <span className="truncate">{ref.label ?? '?'}</span>
                    </div>
                  ),
                )}
              </>
            ) : (
              // Generic: one row per CALL — a short success summary or the
              // failure message — so every merged tool row can expand.
              callEntries.map((entry, i) => (
                <div
                  key={`call-${i}`}
                  className="text-fg-muted flex items-center gap-1.5 text-xs"
                >
                  {entry.ok ? (
                    <Check size={11} className="text-fg-muted/60 shrink-0" />
                  ) : (
                    <XIcon size={11} className="text-danger shrink-0" />
                  )}
                  <span
                    className={`truncate ${entry.ok ? '' : 'text-danger/80'}`}
                    title={entry.text}
                  >
                    {entry.text || '?'}
                  </span>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
