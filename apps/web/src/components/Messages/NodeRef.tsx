import { NODE_ICON } from '../../config/nodeIcons';
import useCanvasStore from '../../store/canvasStore';

import type { CanvasNodeType, ChatAttachment } from '@sediment/shared';

interface NodeRefProps {
  /** Existing canvas node ID to focus. */
  nodeId?: string;
  /** Attachment to reference — if the node doesn't exist on canvas, clicking creates it. */
  attachment?: ChatAttachment;
  fallbackLabel?: string;
}

const ATTACHMENT_TYPE_TO_NODE: Record<string, CanvasNodeType> = {
  image: 'image',
  pdf: 'pdf',
  file: 'note',
};

/**
 * Clickable reference badge — works for both canvas nodes and attachments.
 * - If the referenced node exists on canvas → click focuses it.
 * - If it doesn't exist but attachment data is provided → click creates the node, then focuses it.
 */
export function NodeRef({ nodeId, attachment, fallbackLabel }: NodeRefProps) {
  const nodes = useCanvasStore((s) => s.nodes);
  const selectNodes = useCanvasStore((s) => s.selectNodes);
  const addNode = useCanvasStore((s) => s.addNode);
  const rfInstance = useCanvasStore((s) => s.rfInstance);

  // Try to find an existing node: by nodeId, or by matching src URL from attachment
  const node = nodeId
    ? nodes.find((n) => n.id === nodeId)
    : attachment
      ? nodes.find((n) => {
          const data = n.data as Record<string, unknown> | undefined;
          return data?.src === attachment.url;
        })
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
      // Node exists on canvas — focus it
      focusNode(node.id);
    } else if (attachment) {
      // Node doesn't exist — create it from attachment data
      const newNodeType = ATTACHMENT_TYPE_TO_NODE[attachment.type] ?? 'note';
      const data: Record<string, unknown> = {
        label: attachment.label ?? attachment.filename,
        origin: { type: 'user-drag-chat' as const },
      };
      if (newNodeType === 'image' || newNodeType === 'pdf') {
        data.src = attachment.url;
      } else {
        data.content = attachment.label ?? attachment.filename ?? '';
      }
      addNode({ nodeType: newNodeType, data });
    } else if (nodeId) {
      // nodeId provided but node not on canvas — try focusing anyway
      focusNode(nodeId);
    }
  };

  const title = node
    ? `Focus: ${label}`
    : attachment
      ? `Add to canvas: ${label}`
      : `Focus: ${label}`;

  return (
    <div
      role="button"
      tabIndex={0}
      className="border-border/60 hover:bg-theme-50 inline-flex cursor-pointer items-center gap-0.5 rounded border bg-transparent px-1 py-px align-middle text-[10px] leading-tight font-normal text-gray-400"
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
