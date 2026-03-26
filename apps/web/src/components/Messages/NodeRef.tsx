import { NODE_ICON } from '../../config/nodeIcons';
import useCanvasStore from '../../store/canvasStore';

import type { CanvasNodeType, ChatAttachment } from '@sediment/shared';

interface NodeRefProps {
  /** Existing canvas node ID to focus. */
  nodeId?: string;
  /** Attachment to reference. */
  attachment?: ChatAttachment;
  fallbackLabel?: string;
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
 */
export function NodeRef({ nodeId, attachment, fallbackLabel }: NodeRefProps) {
  const nodes = useCanvasStore((s) => s.nodes);
  const selectNodes = useCanvasStore((s) => s.selectNodes);
  const rfInstance = useCanvasStore((s) => s.rfInstance);

  // Resolve the effective node ID: explicit prop or attachment's originSourceId
  const resolvedNodeId = nodeId ?? attachment?.originSourceId;

  const node = resolvedNodeId
    ? nodes.find((n) => n.id === resolvedNodeId)
    : undefined;

  const nodeData = node?.data as Record<string, unknown> | undefined;

  // Determine label
  const label = attachment
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
    if (node) {
      focusNode(node.id);
    } else if (resolvedNodeId) {
      focusNode(resolvedNodeId);
    }
  };

  const title = node
    ? `Focus: ${label}`
    : resolvedNodeId
      ? `Focus: ${label}`
      : label;

  return (
    <div
      role="button"
      tabIndex={0}
      className="border-border/60 hover:bg-info-bg text-text-muted inline-flex cursor-pointer items-center gap-0.5 rounded border bg-transparent px-1 py-px align-middle text-[10px] leading-tight font-normal"
      onClick={handleClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          handleClick(e as unknown as React.MouseEvent);
        }
      }}
      title={title}
    >
      <Icon size={9} className="flex-shrink-0" />
      <span className="max-w-[100px] truncate">{label}</span>
    </div>
  );
}
