import clsx from 'clsx';
import { ChevronDown, Download, Redo2, Undo2 } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import { exportCanvas } from '../../api/canvas';
import useCanvasStore from '../../store/canvasStore';
import { DropdownMenuItem } from '../Common/DropdownMenu';
import { IconButton } from '../Common/IconButton';
import { Popover } from '../Common/Popover';
import { toast } from '../Common/Toast';

/**
 * canvas title + dropdown menu.
 * Sits in the header and exposes Export / Import canvas actions.
 */
export const CanvasMenu: React.FC = () => {
  const canvasTitle = useCanvasStore((s) => s.canvasTitle);
  const setCanvasTitle = useCanvasStore((s) => s.setCanvasTitle);
  const canvasId = useCanvasStore((s) => s.canvasId);
  const undo = useCanvasStore((s) => s.undo);
  const redo = useCanvasStore((s) => s.redo);
  const canUndo = useCanvasStore((s) => s.canUndo);
  const canRedo = useCanvasStore((s) => s.canRedo);

  const [isOpen, setIsOpen] = useState(false);

  const triggerRef = useRef<HTMLDivElement>(null);
  const chevronRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const sizerRef = useRef<HTMLSpanElement>(null);

  const justDismissedRef = useRef(false);

  // Keep input width in sync with its content
  useEffect(() => {
    if (sizerRef.current && inputRef.current) {
      inputRef.current.style.width = `${sizerRef.current.offsetWidth}px`;
    }
  }, [canvasTitle]);

  // ─── Export ──────────────────────────────────────────────────────────────

  const handleExport = useCallback(async () => {
    setIsOpen(false);
    try {
      await exportCanvas(canvasId, canvasTitle);
      toast('Export started', { variant: 'success' });
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Export failed', {
        variant: 'error',
      });
    }
  }, [canvasId, canvasTitle]);

  return (
    <>
      {/* Canvas title input + chevron trigger */}
      <div ref={triggerRef} className="flex min-w-0 items-center">
        {/* Hidden sizer span — mirrors input text to measure natural width */}
        <span
          ref={sizerRef}
          aria-hidden
          className="invisible absolute px-1 text-lg font-medium whitespace-pre"
        >
          {canvasTitle || '\u00a0'}
        </span>
        <input
          ref={inputRef}
          className="text-primary focus:shadow-bottom m-0 min-w-8 bg-transparent px-1 py-1 text-lg font-medium outline-none focus:rounded-md"
          value={canvasTitle}
          onChange={(e) => setCanvasTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') inputRef.current?.blur();
          }}
          aria-label="Canvas title"
        />

        <div ref={chevronRef}>
          <IconButton
            onClick={() => {
              if (justDismissedRef.current) return;
              setIsOpen((prev) => !prev);
            }}
            aria-label="Canvas menu"
            aria-expanded={isOpen}
            className="h-7 w-7 shrink-0"
          >
            <ChevronDown
              size={14}
              className={clsx(
                'text-muted-foreground transition-transform duration-150',
                isOpen && 'rotate-180',
              )}
            />
          </IconButton>
        </div>
      </div>

      {/* Dropdown menu */}
      {isOpen && (
        <Popover
          position={(() => {
            if (!chevronRef.current) return { x: 0, y: 0 };
            const rect = chevronRef.current.getBoundingClientRect();
            return { x: rect.left, y: rect.bottom };
          })()}
          onDismiss={() => {
            justDismissedRef.current = true;
            setIsOpen(false);
            requestAnimationFrame(() => {
              justDismissedRef.current = false;
            });
          }}
          offset={{ x: 0, y: 4 }}
          className="flex flex-col overflow-hidden py-1"
        >
          <DropdownMenuItem
            icon={<Undo2 size={14} />}
            disabled={!canUndo}
            onClick={() => {
              setIsOpen(false);
              undo();
            }}
          >
            Undo
          </DropdownMenuItem>
          <DropdownMenuItem
            icon={<Redo2 size={14} />}
            disabled={!canRedo}
            onClick={() => {
              setIsOpen(false);
              redo();
            }}
          >
            Redo
          </DropdownMenuItem>
          <div className="border-border my-1 border-t" />
          <DropdownMenuItem
            icon={<Download size={14} />}
            onClick={() => void handleExport()}
          >
            Export Canvas
          </DropdownMenuItem>
        </Popover>
      )}
    </>
  );
};
