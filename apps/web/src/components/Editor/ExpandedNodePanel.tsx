import {
  ArrowLeft,
  Columns2,
  Expand,
  FileText,
  Globe,
  ImageIcon,
  PlayCircle,
  StickyNote,
  X,
} from 'lucide-react';
import { useEffect, useMemo } from 'react';

import useCanvasStore from '../../store/canvasStore.ts';
import { usePreviewStore } from '../../store/previewStore.ts';
import { GhostButton } from '../Common/GhostButton.tsx';
import { NodePreviewContent } from '../Nodes/NodePreviewContent.tsx';

// Helper to get meta info (icon, title) for the header
const getOverlayMeta = (type: string, data: Record<string, unknown>) => {
  const label = data.label as string;

  const iconMap: Record<string, React.ReactNode> = {
    note: <StickyNote size={14} />,
    web: <Globe size={14} />,
    pdf: <FileText size={14} />,
    image: <ImageIcon size={14} />,
    video: <PlayCircle size={14} />,
  };

  return {
    title: label,
    icon: iconMap[type] || <Expand size={14} />,
  };
};

/* ------------------------------------------------------------------ */
/*  ExpandedNodePanel – inline panel that replaces or sits beside     */
/*  the canvas.                                 */
/* ------------------------------------------------------------------ */

export const ExpandedNodePanel = () => {
  // Canvas Store State
  const expandedNodeId = useCanvasStore((s) => s.expandedNodeId);
  const canvasExpandMode = useCanvasStore((s) => s.expandMode);
  const closeExpandedCanvas = useCanvasStore((s) => s.closeExpanded);
  const setCanvasExpandMode = useCanvasStore((s) => s.setExpandMode);
  const nodes = useCanvasStore((s) => s.nodes);
  const updateNodeData = useCanvasStore((s) => s.updateNodeData);

  // Preview Store State
  const previewType = usePreviewStore((s) => s.previewType);
  const previewData = usePreviewStore((s) => s.previewData);
  const closePreview = usePreviewStore((s) => s.closePreview);
  const previewExpandMode = usePreviewStore((s) => s.expandMode);
  const setPreviewExpandMode = usePreviewStore((s) => s.setExpandMode);

  const node = useMemo(() => {
    if (!expandedNodeId) return null;
    return nodes.find((n) => n.id === expandedNodeId) ?? null;
  }, [expandedNodeId, nodes]);

  // Priority: Preview > Node
  // If preview is open, show it. Otherwise show node (if any).
  const isPreview = !!(previewType && previewData);
  const isNode = !!(expandedNodeId && node);

  // Handling conflicts:
  // If preview is newly opened, we want to ensure canvas expand is closed?
  // Probably better handled at the trigger site (in SourceLibraryTree).
  // Here we just render based on priority.

  const activeItem = useMemo(() => {
    if (isPreview && previewType && previewData) {
      return {
        type: previewType,
        data: previewData,
        readOnly: true,
        isNode: false,
        expandMode: previewExpandMode,
        close: closePreview,
        setMode: setPreviewExpandMode,
      };
    }
    if (isNode && node) {
      return {
        type: node.type || 'text',
        data: node.data as Record<string, unknown>,
        readOnly: false,
        isNode: true,
        expandMode: canvasExpandMode,
        close: closeExpandedCanvas,
        setMode: setCanvasExpandMode,
      };
    }
    return null;
  }, [
    isPreview,
    previewType,
    previewData,
    previewExpandMode,
    closePreview,
    setPreviewExpandMode,
    isNode,
    node,
    canvasExpandMode,
    closeExpandedCanvas,
    setCanvasExpandMode,
  ]);

  // If the node was removed while expanded, close the panel.
  useEffect(() => {
    if (expandedNodeId && !node && !isPreview) {
      closeExpandedCanvas();
    }
  }, [closeExpandedCanvas, expandedNodeId, node, isPreview]);

  // Global Escape key handler.
  useEffect(() => {
    if (!activeItem) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        activeItem.close();
      }
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [activeItem]);

  if (!activeItem) return null;

  const meta = getOverlayMeta(activeItem.type, activeItem.data);
  const isReplace = activeItem.expandMode === 'replace';

  const backTitle = activeItem.isNode ? 'Back to Canvas' : 'Close Preview';

  return (
    <div className="border-border flex h-full w-full flex-col overflow-hidden border-l bg-white">
      {/* Header bar */}
      <div className="border-border flex h-10 shrink-0 items-center justify-between gap-3 border-b bg-white px-3">
        {/* Left: back button (replace mode) + icon + title */}
        <div className="flex min-w-0 items-center gap-2">
          {isReplace && (
            <GhostButton
              className="text-muted-foreground"
              title={backTitle}
              onClick={activeItem.close}
            >
              <ArrowLeft size={14} />
            </GhostButton>
          )}

          <div className="text-muted-foreground flex min-w-0 items-center gap-2 text-xs font-medium">
            <span className="shrink-0">{meta.icon}</span>
            <span className="truncate">{meta.title}</span>
            {activeItem.readOnly && (
              <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-[10px] uppercase">
                Preview
              </span>
            )}
          </div>
        </div>

        {/* Right: mode toggle + close */}
        <div className="text-muted-foreground flex items-center gap-1">
          <GhostButton
            className={
              !isReplace ? 'text-main bg-muted' : 'text-muted-foreground'
            }
            title={isReplace ? 'Split view' : 'Full view'}
            onClick={() => activeItem.setMode(isReplace ? 'split' : 'replace')}
          >
            <Columns2 size={14} />
          </GhostButton>

          <GhostButton
            className="text-muted-foreground"
            title="Close"
            onClick={(e) => {
              e.stopPropagation();
              activeItem.close();
            }}
          >
            <X size={14} />
          </GhostButton>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        <NodePreviewContent
          type={activeItem.type}
          data={activeItem.data}
          readOnly={activeItem.readOnly}
          onContentChange={
            activeItem.isNode && expandedNodeId
              ? (newContent) =>
                  updateNodeData(expandedNodeId, { content: newContent })
              : undefined
          }
        />
      </div>
    </div>
  );
};
