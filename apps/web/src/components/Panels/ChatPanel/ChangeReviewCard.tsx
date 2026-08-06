// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * ChangeReviewCard — the "what the agent changed" review card shown
 * above the chat input for a conversation thread (built-in chat, question
 * node, or ACP).
 *
 * Lists the canvas changes attributed to this thread (one row per
 * change) with per-item Keep / Revert, plus Keep all / Revert all.
 * Revert is blocked (greyed) when the target node was modified after the
 * agent's change, so it never clobbers a newer human / agent edit.
 */

import { AlertTriangle, Check, ChevronRight, Eye, Undo2 } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { applyDeltas } from '@huabu/shared/canvas-engine';

import {
  useAcpThreadChangesStore,
  isChangeStale,
} from '@/store/acpThreadChangesStore';
import useCanvasStore from '@/store/canvasStore';

import { Button } from '../../Common/Button';
import { NodeRef } from '../../Common/NodeRef';
import { Tooltip } from '../../Common/Tooltip';

import type { CanvasChangeRecord, Delta } from '@huabu/shared/canvas-engine';
import type { Node, Edge } from '@xyflow/react';

interface ChangeReviewCardProps {
  canvasId: string;
  threadId: string;
}

const EMPTY: CanvasChangeRecord[] = [];
const EMPTY_IDS: string[] = [];

const EDGE_KINDS = new Set(['connect', 'disconnect', 'edge-update']);

export function ChangeReviewCard({
  canvasId,
  threadId,
}: ChangeReviewCardProps) {
  const { t } = useTranslation();
  const records = useAcpThreadChangesStore(
    (s) => s.byThread[threadId] ?? EMPTY,
  );
  const conflictedNodeIds = useAcpThreadChangesStore(
    (s) => s.conflictedByThread[threadId] ?? EMPTY_IDS,
  );
  const accept = useAcpThreadChangesStore((s) => s.accept);
  const acceptAll = useAcpThreadChangesStore((s) => s.acceptAll);
  const revert = useAcpThreadChangesStore((s) => s.revert);
  const revertAll = useAcpThreadChangesStore((s) => s.revertAll);
  // Subscribe to the live canvas so staleness recomputes (and rows
  // re-disable) the moment a target node / edge is added or removed.
  const nodes = useCanvasStore((s) => s.nodes);
  const edges = useCanvasStore((s) => s.edges);

  const [collapsed, setCollapsed] = useState(true);

  // Press-and-hold preview: temporarily apply a record's inverse deltas
  // (the "before" state) without autosave; restore the snapshot on
  // release. Only one preview is active at a time.
  const snapshotRef = useRef<{ nodes: Node[]; edges: Edge[] } | null>(null);

  const startPreviewDeltas = useCallback((deltas: Delta[]) => {
    if (snapshotRef.current) return;
    const { nodes, edges } = useCanvasStore.getState();
    snapshotRef.current = { nodes, edges };
    const next = applyDeltas({ nodes, edges }, deltas);
    useCanvasStore.getState()._setStateNoAutosave({
      nodes: next.nodes as Node[],
      edges: next.edges as Edge[],
    });
  }, []);

  const startPreview = useCallback(
    (record: CanvasChangeRecord) => startPreviewDeltas(record.revertDeltas),
    [startPreviewDeltas],
  );

  const endPreview = useCallback(() => {
    const snap = snapshotRef.current;
    if (!snap) return;
    snapshotRef.current = null;
    useCanvasStore
      .getState()
      ._setStateNoAutosave({ nodes: snap.nodes, edges: snap.edges });
  }, []);

  if (records.length === 0) return null;

  // Only non-stale changes can be previewed / reverted. When every change
  // is stale (its target was deleted or changed since), the "all" actions
  // have nothing to act on and are disabled.
  const revertable = records.filter((r) => !isChangeStale(r, nodes, edges));
  const hasRevertable = revertable.length > 0;

  // Combined inverse deltas for "preview all" — reverse record order so
  // dependent changes are undone before their prerequisites. Stale
  // records are skipped (their inverse would target a missing entity).
  const previewAll = () => {
    const deltas: Delta[] = [];
    for (let i = revertable.length - 1; i >= 0; i--) {
      deltas.push(...revertable[i].revertDeltas);
    }
    startPreviewDeltas(deltas);
  };

  const title = t('chat.changeCount', { count: records.length });

  return (
    <div className="border-edge-default bg-surface -mb-px rounded-t-2xl border border-b-0 text-xs">
      <div className="flex items-center gap-1.5 px-3 py-1.5">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="flex min-w-0 flex-1 items-center gap-1 text-left"
        >
          <ChevronRight
            size={12}
            className={`text-fg-subtle shrink-0 transition-transform ${collapsed ? '' : 'rotate-90'}`}
          />
          <span className="text-fg-muted truncate">{title}</span>
        </button>
        <Button
          onPointerDown={previewAll}
          onPointerUp={endPreview}
          onPointerLeave={endPreview}
          variant="ghost"
          size="sm"
          iconOnly
          disabled={!hasRevertable}
          title={
            hasRevertable
              ? t('chat.previewAllChanges')
              : t('chat.previewNoRevertableChanges')
          }
          className="h-5 w-5 rounded-sm"
        >
          <Eye size={12} />
        </Button>
        <Button
          onClick={() => void acceptAll(canvasId, threadId)}
          variant="outline"
          size="sm"
          className="h-5 rounded-sm"
        >
          {t('chat.keepAllChanges')}
        </Button>
        <Button
          onClick={() => void revertAll(canvasId, threadId)}
          variant="outline"
          size="sm"
          disabled={!hasRevertable}
          title={hasRevertable ? undefined : t('chat.noRevertableChanges')}
          className="h-5 rounded-sm"
        >
          {t('chat.revertAllChanges')}
        </Button>
      </div>
      {!collapsed && (
        <ul className="border-edge-default max-h-48 overflow-y-auto border-t py-0.5">
          {records.map((rec) => (
            <ChangeRow
              key={rec.id}
              record={rec}
              stale={isChangeStale(rec, nodes, edges)}
              conflicted={
                !!rec.nodeId && conflictedNodeIds.includes(rec.nodeId)
              }
              onPreviewStart={() => startPreview(rec)}
              onPreviewEnd={endPreview}
              onKeep={() => void accept(canvasId, threadId, rec.id)}
              onRevert={() => void revert(canvasId, threadId, rec.id)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function ChangeRow({
  record,
  stale,
  conflicted,
  onPreviewStart,
  onPreviewEnd,
  onKeep,
  onRevert,
}: {
  record: CanvasChangeRecord;
  stale: boolean;
  conflicted: boolean;
  onPreviewStart: () => void;
  onPreviewEnd: () => void;
  onKeep: () => void;
  onRevert: () => void;
}) {
  const { t } = useTranslation();
  const isEdge = EDGE_KINDS.has(record.kind);

  return (
    <li className="group hover:bg-hover flex items-center gap-1.5 px-2 py-1">
      <div className="flex min-w-0 flex-1 items-center gap-1">
        {conflicted && (
          <AlertTriangle
            size={12}
            className="text-warning shrink-0"
            aria-label={t('chat.skippedConflictAria')}
          />
        )}
        {isEdge ? (
          // Edge change: verb (e.g. "Connected") + source → target chips.
          // `label` is now a full "Verb: source → target" string, so we
          // take the verb prefix the same way as node rows and let the
          // clickable chips carry the endpoints.
          <span className="inline-flex min-w-0 items-center gap-1">
            <span className="text-fg-muted">{record.label.split(':')[0]}:</span>
            <NodeRef
              nodeId={record.sourceNodeId}
              snapshotLabel={record.sourceNodeLabel}
              fallbackLabel={record.sourceNodeLabel}
            />
            <span className="text-fg-subtle">→</span>
            <NodeRef
              nodeId={record.targetNodeId}
              snapshotLabel={record.targetNodeLabel}
              fallbackLabel={record.targetNodeLabel}
            />
          </span>
        ) : record.nodeId ? (
          // Node change: show the verb prefix (e.g. "Created:") + a single
          // clickable chip — the node name lives in the chip, not the text.
          <span className="inline-flex min-w-0 items-center gap-1">
            <span className="text-fg-muted">{record.label.split(':')[0]}:</span>
            <NodeRef
              nodeId={record.nodeId}
              snapshotLabel={record.nodeLabel}
              fallbackLabel={record.nodeLabel}
            />
          </span>
        ) : (
          <span className="text-fg-muted truncate">{record.label}</span>
        )}
        {conflicted && (
          <Tooltip content={t('chat.skippedConflictTooltip')}>
            <span className="text-warning shrink-0 cursor-help whitespace-nowrap">
              · {t('chat.skipped')}
            </span>
          </Tooltip>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <Button
          onPointerDown={onPreviewStart}
          onPointerUp={onPreviewEnd}
          onPointerLeave={onPreviewEnd}
          variant="ghost"
          size="sm"
          iconOnly
          disabled={stale}
          title={
            conflicted
              ? t('chat.previewSkippedConflict')
              : stale
                ? t('chat.previewStaleChange')
                : t('chat.previewChange')
          }
          className="h-5 w-5 rounded-sm"
        >
          <Eye size={12} />
        </Button>
        <Button
          onClick={onKeep}
          variant="ghost"
          size="sm"
          iconOnly
          title={
            conflicted ? t('chat.dismissSkippedChange') : t('chat.keepChange')
          }
          className="h-5 w-5 rounded-sm"
        >
          <Check size={12} />
        </Button>
        <Button
          onClick={onRevert}
          variant="ghost"
          size="sm"
          iconOnly
          disabled={stale}
          title={
            conflicted
              ? t('chat.nothingToRevertSkipped')
              : stale
                ? t('chat.revertStaleChange')
                : t('chat.revertChange')
          }
          className="h-5 w-5 rounded-sm"
        >
          <Undo2 size={12} />
        </Button>
      </div>
    </li>
  );
}
