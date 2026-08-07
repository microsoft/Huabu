// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useTranslation } from 'react-i18next';

import { Tooltip } from './Tooltip';
import { NODE_ICON } from '../../config/nodeIcons';
import useCanvasStore from '../../store/canvasStore';

import type { CanvasNodeType, ChatAttachment } from '@huabu/shared';

interface NodeRefProps {
  /** Existing canvas node ID to focus. */
  nodeId?: string;
  /** Attachment to reference. */
  attachment?: ChatAttachment;
  fallbackLabel?: string;
  /**
   * Snapshot label captured at extraction time.
   * When provided, the label is stable and never read from the live store.
   */
  snapshotLabel?: string;
  /** When true, the badge shows a blinking highlight (used during preview). */
  previewing?: boolean;
  /**
   * When set, this ref covers only a PARTIAL stroke selection of the
   * sketch node (the count recorded at send time). Rendered as a small
   * suffix (“N strokes”) so the chip reads as a subset, not the whole
   * node. This is a historical count — not recomputed against the live
   * node — so it stays meaningful even after strokes are edited.
   */
  strokeCount?: number;
}

const ATTACHMENT_TYPE_TO_NODE: Record<string, CanvasNodeType> = {
  image: 'image',
  pdf: 'pdf',
  text: 'text',
  file: 'note',
  web: 'web',
};

/**
 * Clickable reference badge — works for both canvas nodes and attachments.
 * If the referenced node exists on canvas, clicking focuses it.
 * Disabled state when the node no longer exists.
 */
export function NodeRef({
  nodeId,
  attachment,
  fallbackLabel,
  snapshotLabel,
  previewing,
  strokeCount,
}: NodeRefProps) {
  const { t } = useTranslation();
  const nodes = useCanvasStore((s) => s.nodes);
  const selectNodes = useCanvasStore((s) => s.selectNodes);
  const rfInstance = useCanvasStore((s) => s.rfInstance);

  // Resolve the effective node ID: explicit prop or attachment's originNodeId
  const resolvedNodeId = nodeId ?? attachment?.originNodeId;

  const node = resolvedNodeId
    ? nodes.find((n) => n.id === resolvedNodeId)
    : undefined;

  const nodeData = node?.data as Record<string, unknown> | undefined;

  // Disabled (struck-through "Node deleted" chip) whenever the referenced
  // node no longer exists on the canvas. `snapshotLabel` only freezes the
  // *label text* for history rows — it does NOT keep a dead ref clickable,
  // so a deleted node still reads as deleted even with a frozen label.
  // Attachment refs are always valid.
  const isDisabled = !!resolvedNodeId && !node && !attachment;

  // Label priority: snapshotLabel (frozen) > live store > fallback > truncated ID
  const label = snapshotLabel
    ? snapshotLabel
    : attachment
      ? (attachment.filename ?? attachment.label ?? 'file')
      : ((nodeData?.label as string) ??
        fallbackLabel ??
        nodeId?.slice(0, 8) ??
        '?');

  // Determine icon
  const nodeType = attachment
    ? (ATTACHMENT_TYPE_TO_NODE[attachment.type] ?? 'note')
    : ((nodeData?.type ?? node?.type) as string) || 'note';
  const Icon = NODE_ICON[nodeType as CanvasNodeType] ?? NODE_ICON.note;

  const focusNode = (id: string) => {
    selectNodes([id]);
    rfInstance?.fitView({
      nodes: [{ id }],
      duration: 300,
      padding: 0.3,
    });
  };

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isDisabled || previewing) return;
    if (node) {
      focusNode(node.id);
    } else if (resolvedNodeId) {
      focusNode(resolvedNodeId);
    }
  };

  const tooltipContent = isDisabled
    ? 'Node deleted'
    : node
      ? `Focus: ${label}`
      : label;

  const badge = (
    <div
      role="button"
      tabIndex={isDisabled ? -1 : 0}
      className={
        previewing
          ? 'border-info bg-info-bg text-info animate-preview-blink inline-flex cursor-default items-center gap-0.5 rounded border px-1 py-px align-middle text-[10px] leading-tight font-normal'
          : isDisabled
            ? 'border-edge-default/40 text-fg-subtle/40 inline-flex cursor-not-allowed items-center gap-0.5 rounded border bg-transparent px-1 py-px align-middle text-[10px] leading-tight font-normal line-through opacity-60'
            : 'border-edge-default/60 hover:bg-info-bg text-fg-subtle inline-flex cursor-pointer items-center gap-0.5 rounded border bg-transparent px-1 py-px align-middle text-[10px] leading-tight font-normal'
      }
      onClick={handleClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          handleClick(e as unknown as React.MouseEvent);
        }
      }}
    >
      <Icon size={9} className="flex-shrink-0" />
      <span className="max-w-[100px] truncate">{label}</span>
      {strokeCount != null && strokeCount > 0 && (
        <span className="opacity-70">
          · {t('chat.partialStrokeCount', { count: strokeCount })}
        </span>
      )}
    </div>
  );

  return <Tooltip content={tooltipContent}>{badge}</Tooltip>;
}
