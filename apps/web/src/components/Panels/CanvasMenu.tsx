import clsx from 'clsx';
import { ChevronDown, Download, Redo2, Undo2 } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import { exportCanvas } from '../../api/canvas';
import useCanvasStore from '../../store/canvasStore';
import { DropdownMenu, DropdownMenuItem } from '../Common/DropdownMenu';
import { GhostButton } from '../Common/GhostButton';

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
  const [statusMessage, setStatusMessage] = useState('');

  const triggerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const sizerRef = useRef<HTMLSpanElement>(null);

  // Keep input width in sync with its content
  useEffect(() => {
    if (sizerRef.current && inputRef.current) {
      inputRef.current.style.width = `${sizerRef.current.offsetWidth}px`;
    }
  }, [canvasTitle]);

  // ─── Export ──────────────────────────────────────────────────────────────

  const handleExport = useCallback(async () => {
    setIsOpen(false);
    setStatusMessage('Exporting…');
    try {
      const blob = await exportCanvas(canvasId);
      const safeName = canvasTitle.replace(/[^a-z0-9_-]/gi, '_') || canvasId;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${safeName}.sediment.json`;
      a.click();
      URL.revokeObjectURL(url);
      setStatusMessage('Export complete');
    } catch (err) {
      setStatusMessage(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setTimeout(() => setStatusMessage(''), 3000);
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
          className="text-main focus:shadow-bottom m-0 min-w-8 bg-transparent px-1 py-1 text-lg font-medium outline-none focus:rounded-md"
          value={canvasTitle}
          onChange={(e) => setCanvasTitle(e.target.value)}
          aria-label="Canvas title"
        />

        <GhostButton
          onClick={() => setIsOpen((prev) => !prev)}
          aria-label="Workspace menu"
          aria-expanded={isOpen}
          className="h-7 w-7 shrink-0"
        >
          <ChevronDown
            size={15}
            className={clsx(
              'text-gray-500 transition-transform duration-150',
              isOpen && 'rotate-180',
            )}
          />
        </GhostButton>

        {/* Inline status message */}
        {statusMessage && (
          <span className="ml-2 text-xs text-gray-500">{statusMessage}</span>
        )}
      </div>

      {/* Dropdown menu */}
      <DropdownMenu
        triggerRef={triggerRef}
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
      >
        <DropdownMenuItem
          icon={<Undo2 size={14} />}
          shortcut="⌘Z"
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
          shortcut="⇧⌘Z"
          disabled={!canRedo}
          onClick={() => {
            setIsOpen(false);
            redo();
          }}
        >
          Redo
        </DropdownMenuItem>
        <div className="my-1 border-t border-gray-200" />
        <DropdownMenuItem
          icon={<Download size={14} />}
          onClick={() => void handleExport()}
        >
          Export Canvas
        </DropdownMenuItem>
      </DropdownMenu>
    </>
  );
};
