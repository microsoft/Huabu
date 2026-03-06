import clsx from 'clsx';
import { ChevronDown, Download, Redo2, Undo2, Upload } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import { exportCanvas, importCanvas } from '../../api/canvas';
import useCanvasStore from '../../store/canvasStore';
import { DropdownMenu, DropdownMenuItem } from '../Common/DropdownMenu';
import { GhostButton } from '../Common/GhostButton';

import type { CanvasExportBundle } from '@sediment/shared';

type MenuState = 'idle' | 'exporting' | 'importing';

/**
 * Figma-style workspace title + dropdown menu.
 * Sits in the header and exposes Export / Import canvas actions.
 */
export const WorkspaceMenu: React.FC = () => {
  const workspaceName = useCanvasStore((s) => s.workspaceName);
  const setWorkspaceName = useCanvasStore((s) => s.setWorkspaceName);
  const canvasId = useCanvasStore((s) => s.canvasId);
  const loadCanvas = useCanvasStore((s) => s.loadCanvas);
  const undo = useCanvasStore((s) => s.undo);
  const redo = useCanvasStore((s) => s.redo);
  const canUndo = useCanvasStore((s) => s.canUndo);
  const canRedo = useCanvasStore((s) => s.canRedo);

  const [isOpen, setIsOpen] = useState(false);
  const [menuState, setMenuState] = useState<MenuState>('idle');
  const [statusMessage, setStatusMessage] = useState('');

  const triggerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const sizerRef = useRef<HTMLSpanElement>(null);

  // Keep input width in sync with its content
  useEffect(() => {
    if (sizerRef.current && inputRef.current) {
      inputRef.current.style.width = `${sizerRef.current.offsetWidth}px`;
    }
  }, [workspaceName]);

  // ─── Export ──────────────────────────────────────────────────────────────

  const handleExport = useCallback(async () => {
    setIsOpen(false);
    setMenuState('exporting');
    setStatusMessage('Exporting…');
    try {
      const blob = await exportCanvas(canvasId);
      const safeName = workspaceName.replace(/[^a-z0-9_-]/gi, '_') || canvasId;
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
      setMenuState('idle');
      setTimeout(() => setStatusMessage(''), 3000);
    }
  }, [canvasId, workspaceName]);

  // ─── Import ──────────────────────────────────────────────────────────────

  const handleImportClick = useCallback(() => {
    setIsOpen(false);
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      // Reset so the same file can be re-selected if needed
      e.target.value = '';

      setMenuState('importing');
      setStatusMessage('Importing…');

      try {
        const text = await file.text();
        const bundle = JSON.parse(text) as CanvasExportBundle;
        const result = await importCanvas(bundle);
        await loadCanvas();
        setStatusMessage(
          `Imported ${result.importedSources} source(s), ${result.importedArtifacts} artifact(s)`,
        );
      } catch (err) {
        setStatusMessage(err instanceof Error ? err.message : 'Import failed');
      } finally {
        setMenuState('idle');
        setTimeout(() => setStatusMessage(''), 4000);
      }
    },
    [loadCanvas],
  );

  const isBusy = menuState !== 'idle';

  return (
    <>
      {/* Hidden file input for import */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={(e) => void handleFileChange(e)}
      />

      {/* Workspace name input + chevron trigger */}
      <div ref={triggerRef} className="flex min-w-0 items-center">
        {/* Hidden sizer span — mirrors input text to measure natural width */}
        <span
          ref={sizerRef}
          aria-hidden
          className="invisible absolute px-2 text-lg font-medium whitespace-pre"
        >
          {workspaceName || '\u00a0'}
        </span>
        <input
          ref={inputRef}
          className="text-main focus:shadow-bottom m-0 min-w-8 bg-transparent px-2 py-1 text-lg font-medium outline-none focus:rounded-md"
          value={workspaceName}
          onChange={(e) => setWorkspaceName(e.target.value)}
          aria-label="Workspace name"
          disabled={isBusy}
        />

        <GhostButton
          onClick={() => setIsOpen((prev) => !prev)}
          disabled={isBusy}
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
        <DropdownMenuItem
          icon={<Upload size={14} />}
          onClick={handleImportClick}
        >
          Import Canvas
        </DropdownMenuItem>
      </DropdownMenu>
    </>
  );
};
