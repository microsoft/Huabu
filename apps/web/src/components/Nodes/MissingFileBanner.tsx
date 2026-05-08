import { FileWarning, Trash2 } from 'lucide-react';
import { memo, useCallback } from 'react';

import { Button } from '@/components/Common/Button';
import useCanvasStore from '@/store/canvasStore';

type Variant = 'fill' | 'inline';

export interface MissingFileBannerProps {
  /** Node ID — used by the Remove button to delete this node from the canvas. */
  nodeId: string;
  /** One-line headline shown to the user. */
  title: string;
  /** Optional secondary description (kept short — the banner is small). */
  description?: string;
  /**
   * `fill` (default): occupy the full available area as a card replacement
   * (used by media nodes when the artifact file is gone).
   * `inline`: a compact strip rendered above existing content (used by
   * note / text nodes whose markdown file is gone but the node body is
   * still editable so the user can recreate it by typing).
   */
  variant?: Variant;
}

/**
 * Renders a non-blocking placeholder when a node's backing file (markdown
 * for note/text, artifact for pdf/image/video) has been deleted or
 * renamed outside the app. Always offers a Remove button so the user can
 * clean up the orphaned node with a single click.
 */
export const MissingFileBanner = memo(
  ({
    nodeId,
    title,
    description,
    variant = 'fill',
  }: MissingFileBannerProps) => {
    const deleteNodes = useCanvasStore((s) => s.deleteNodes);

    const handleRemove = useCallback(
      (e: React.MouseEvent) => {
        e.stopPropagation();
        deleteNodes([nodeId]);
      },
      [nodeId, deleteNodes],
    );

    if (variant === 'inline') {
      return (
        <div className="border-warning-light bg-surface text-fg-muted flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs">
          <FileWarning className="text-warning h-3.5 w-3.5 shrink-0" />
          <span className="flex-1 truncate" title={description ?? title}>
            {title}
          </span>
          <Button
            size="sm"
            variant="ghost"
            tone="danger"
            iconOnly
            title="Remove node"
            onClick={handleRemove}
          >
            <Trash2 />
          </Button>
        </div>
      );
    }

    return (
      <div className="border-warning-light bg-surface text-fg-muted flex h-full w-full flex-col items-center justify-center gap-3 rounded border border-dashed p-4 text-center">
        <FileWarning className="text-warning h-8 w-8 opacity-80" />
        <div className="flex flex-col gap-1">
          <div className="text-fg-default text-sm font-medium">{title}</div>
          {description ? (
            <div className="text-fg-subtle line-clamp-3 text-xs">
              {description}
            </div>
          ) : null}
        </div>
        <Button
          size="sm"
          variant="outline"
          tone="danger"
          onClick={handleRemove}
        >
          <Trash2 />
          Remove from canvas
        </Button>
      </div>
    );
  },
);

MissingFileBanner.displayName = 'MissingFileBanner';
