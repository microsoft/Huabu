import { ArrowLeft, Columns2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef } from 'react';

import { getNodeIcon } from '../../../config/nodeIcons.ts';
import useCanvasStore from '../../../store/canvasStore.ts';
import { useChatStore } from '../../../store/chatStore.ts';
import { usePreviewStore } from '../../../store/previewStore.ts';
import { Button } from '../../Common/Button.tsx';
import { NodePreviewContent } from '../../Nodes/NodePreviewContent.tsx';

// Helper to get meta info (icon, title) for the header
const getOverlayMeta = (type: string, data: Record<string, unknown>) => {
  const label = data.label as string;
  const Icon = getNodeIcon(type);

  return {
    title: label,
    icon: <Icon size={14} />,
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
  // Bubble phase (no capture flag) so child components (e.g. BlockNote menus)
  // can call stopPropagation() to handle Escape themselves without closing the
  // panel. Note: Escape inside a cross-origin iframe won't reach this handler
  // due to browser security boundaries – that's an acceptable limitation.
  useEffect(() => {
    if (!activeItem) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        activeItem.close();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeItem]);

  const panelRef = useRef<HTMLDivElement>(null);
  const setSelectionAttachment = useChatStore((s) => s.setSelectionAttachment);

  // Listen for text selection inside the panel and auto-attach as pending
  const handleSelectionChange = useCallback(() => {
    const sel = window.getSelection();

    // If selection is collapsed (e.g. user clicked elsewhere like chat input),
    // only clear if the focus is still inside this panel — otherwise keep the
    // attachment so the user can type in chat input without losing it.
    if (!sel || sel.isCollapsed || !panelRef.current) {
      const active = document.activeElement;
      if (active && panelRef.current?.contains(active)) {
        setSelectionAttachment(null);
      }
      return;
    }

    // Check that the selection is inside this panel
    const anchor = sel.anchorNode;
    if (!anchor || !panelRef.current.contains(anchor)) {
      return;
    }

    const text = sel.toString().trim();
    if (!text) {
      setSelectionAttachment(null);
      return;
    }

    setSelectionAttachment({
      type: 'text',
      source: 'excerpt',
      originSourceId: expandedNodeId ?? undefined,
      content: text,
      label: text.length > 12 ? text.slice(0, 12) + '…' : text,
    });
  }, [setSelectionAttachment, expandedNodeId]);

  useEffect(() => {
    document.addEventListener('selectionchange', handleSelectionChange);
    return () => {
      document.removeEventListener('selectionchange', handleSelectionChange);
      // Clear selection attachment when panel unmounts or item changes
      useChatStore.getState().setSelectionAttachment(null);
    };
  }, [handleSelectionChange]);

  if (!activeItem) return null;

  const meta = getOverlayMeta(activeItem.type, activeItem.data);
  const isReplace = activeItem.expandMode === 'replace';

  const backTitle = activeItem.isNode ? 'Back to Canvas' : 'Close Preview';

  return (
    <div
      ref={panelRef}
      className="border-edge-default bg-surface flex h-full w-full flex-col overflow-hidden border-l"
    >
      {/* Header bar */}
      <div className="border-edge-default bg-surface flex h-12 shrink-0 items-center justify-between gap-3 border-b px-3">
        {/* Left: back button (replace mode) + icon + title */}
        <div className="flex min-w-0 items-center gap-2">
          {isReplace && (
            <Button
              variant="ghost"
              iconOnly
              size="sm"
              title={backTitle}
              onClick={activeItem.close}
            >
              <ArrowLeft />
            </Button>
          )}

          <div className="text-fg-muted flex min-w-0 items-center gap-2 text-sm font-medium">
            <span className="truncate">{meta.title}</span>
            {activeItem.readOnly && (
              <span className="bg-bg-default text-fg-muted rounded px-1.5 py-0.5 text-xs uppercase">
                Preview
              </span>
            )}
          </div>
        </div>

        {/* Right: mode toggle + close */}
        <div className="text-fg-muted flex items-center gap-1">
          <Button
            variant="ghost"
            iconOnly
            size="sm"
            className={!isReplace ? 'text-fg-default bg-bg-default' : ''}
            title={isReplace ? 'Split view' : 'Full view'}
            onClick={() => activeItem.setMode(isReplace ? 'split' : 'replace')}
          >
            <Columns2 />
          </Button>

          <Button
            variant="ghost"
            iconOnly
            size="sm"
            title="Close"
            onClick={(e) => {
              e.stopPropagation();
              activeItem.close();
            }}
          >
            <X />
          </Button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        <NodePreviewContent
          key={expandedNodeId ?? previewType}
          id={expandedNodeId ?? undefined}
          type={activeItem.type}
          data={activeItem.data}
          readOnly={activeItem.readOnly}
          onDataChange={
            activeItem.isNode && expandedNodeId
              ? (patch) => updateNodeData(expandedNodeId, patch)
              : undefined
          }
        />
      </div>
    </div>
  );
};
