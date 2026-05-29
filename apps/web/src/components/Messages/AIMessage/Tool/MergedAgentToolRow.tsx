/**
 * MergedAgentToolRow — collapsible row that merges N adjacent calls
 * to the same built-in agent tool (`read`, `grep`, `find`, `ls`,
 * `inspect_nodes`, `get_canvas_outline`) into a single self-describing
 * summary, expanding to per-call detail on click.
 */

import { Check, ChevronRight, X as XIcon } from 'lucide-react';
import { useMemo, useState } from 'react';

import { partIsExecuting, truncate, type ToolPart } from './helpers';
import { ToolKindIcon } from './ToolKindIcon';
import { NodeRef } from '../../../Common/NodeRef';
import { Spinner } from '../../../Common/Spinner';

import type { AgentToolPart } from '@sediment/shared';

export function MergedAgentToolRow({
  tool,
  entries,
}: {
  tool: string;
  entries: ToolPart<AgentToolPart>[];
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const count = entries.length;

  const isExecuting = entries.some((e) => partIsExecuting(e.part));
  const isError = entries.some((e) => e.part.status === 'failed');

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
              ? 'Inspected 1 node'
              : `Inspected ${totalMatched} nodes`
            : `Inspected nodes (×${count})`,
        nodeRefs: refs,
      };
    }

    if (tool === 'read') {
      const tr = entries[0]?.part.data;
      const first =
        tr?.status === 'success'
          ? ((tr.data ?? {}) as Record<string, unknown>)
          : {};
      const firstPath = (first.path as string) || '';
      return {
        title:
          count === 1
            ? firstPath
              ? `Read ${truncate(firstPath, 60)}`
              : 'Read file'
            : `Read ${count} files`,
        nodeRefs: emptyRefs,
      };
    }

    if (tool === 'grep') {
      // grep returns `{ matches, count, limitReached }`. Sum match counts
      // across calls for a self-describing title.
      const totalMatches = entries.reduce((sum, e) => {
        const tr = e.part.data;
        const d =
          tr?.status === 'success'
            ? ((tr.data ?? {}) as Record<string, unknown>)
            : {};
        return sum + (typeof d.count === 'number' ? d.count : 0);
      }, 0);
      const matchLabel = totalMatches === 1 ? 'match' : 'matches';
      return {
        title:
          count === 1
            ? `Grep — ${totalMatches} ${matchLabel}`
            : `Grep (×${count}) — ${totalMatches} ${matchLabel}`,
        nodeRefs: emptyRefs,
      };
    }

    if (tool === 'find') {
      // find returns `{ paths, count, limitReached }`.
      const totalPaths = entries.reduce((sum, e) => {
        const tr = e.part.data;
        const d =
          tr?.status === 'success'
            ? ((tr.data ?? {}) as Record<string, unknown>)
            : {};
        return sum + (typeof d.count === 'number' ? d.count : 0);
      }, 0);
      const fileLabel = totalPaths === 1 ? 'file' : 'files';
      return {
        title:
          count === 1
            ? `Find — ${totalPaths} ${fileLabel}`
            : `Find (×${count}) — ${totalPaths} ${fileLabel}`,
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
      const entryLabel = firstCount === 1 ? 'entry' : 'entries';
      return {
        title:
          count === 1
            ? firstPath
              ? `Ls ${truncate(firstPath, 40)} — ${firstCount} ${entryLabel}`
              : `Ls — ${firstCount} ${entryLabel}`
            : `Ls (×${count})`,
        nodeRefs: emptyRefs,
      };
    }

    if (tool === 'get_canvas_outline') {
      return {
        title:
          count === 1
            ? 'Read canvas outline'
            : `Read canvas outline (×${count})`,
        nodeRefs: emptyRefs,
      };
    }

    return { title: tool, nodeRefs: emptyRefs };
  }, [tool, entries, count]);

  const statusIcon = isExecuting ? (
    <Spinner size="xs" className="text-info" />
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
              Inspected{' '}
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

  // No expandable content → simple row
  if (nodeRefs.length === 0 || count === 1) {
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
            {tool === 'inspect_nodes'
              ? // inspect_nodes flattens nodes across calls into nodeRefs;
                // render each matched node as its own row.
                nodeRefs.map((ref, i) =>
                  ref.nodeId ? (
                    <div
                      key={`${ref.nodeId}-${i}`}
                      className="text-fg-muted flex items-center gap-1.5 text-xs"
                    >
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
                )
              : null}
          </div>
        )}
      </div>
    </div>
  );
}
