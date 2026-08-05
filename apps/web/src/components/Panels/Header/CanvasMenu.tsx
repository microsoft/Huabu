// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import clsx from 'clsx';
import { ChevronDown } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { exportCanvas } from '../../../api/canvas.ts';
import useCanvasStore from '../../../store/canvasStore.ts';
import { useWorkspaceStore } from '../../../store/workspaceStore.ts';
import { formatShortcut } from '../../../utils/platform.ts';
import { Button } from '../../Common/Button.tsx';
import { DropdownMenu, DropdownMenuItem } from '../../Common/DropdownMenu.tsx';
import { toast } from '../../Common/Toast.tsx';

interface CanvasMenuProps {
  /**
   * Opens the Keyboard Shortcuts modal. Wired from `CanvasPage`, which owns
   * the modal state. When omitted (e.g. on standalone-page headers that do
   * not host the modal), the menu item is hidden.
   */
  onOpenShortcuts?: () => void;
}

/**
 * canvas title + dropdown menu.
 * Sits in the header and exposes Export / Import canvas actions.
 */
export const CanvasMenu: React.FC<CanvasMenuProps> = ({ onOpenShortcuts }) => {
  const { t } = useTranslation();
  const canvasTitle = useCanvasStore((s) => s.canvasTitle);
  const tryRename = useCanvasStore((s) => s.tryRename);
  const canvasId = useCanvasStore((s) => s.canvasId);
  const isWorld = useWorkspaceStore((s) => s.worldCanvasId === canvasId);
  const undo = useCanvasStore((s) => s.undo);
  const redo = useCanvasStore((s) => s.redo);
  const canUndo = useCanvasStore((s) => s.canUndo);
  const canRedo = useCanvasStore((s) => s.canRedo);

  const [isOpen, setIsOpen] = useState(false);
  // Local draft of the title shown in the input. We only commit to the
  // store via `tryRename` on blur / Enter, so a rejected name (collision)
  // can be reverted without ever flowing through autosave.
  const [draftTitle, setDraftTitle] = useState(canvasTitle);

  const inputRef = useRef<HTMLInputElement>(null);
  const sizerRef = useRef<HTMLSpanElement>(null);

  // Sync the local draft whenever the store title changes (e.g. on canvas
  // switch, undo, or a rejected rename revert).
  useEffect(() => {
    setDraftTitle(canvasTitle);
  }, [canvasTitle]);

  // Keep input width in sync with its content. The +4px buffer compensates
  // for subpixel rendering differences between <span> measurement (sizer)
  // and how <input> lays out its text — browsers reserve a small slice for
  // the caret that the sizer doesn't see, so without the buffer the last
  // character is consistently clipped by `text-ellipsis` even for short
  // titles that should fit comfortably.
  useEffect(() => {
    if (sizerRef.current && inputRef.current) {
      inputRef.current.style.width = `${sizerRef.current.offsetWidth + 4}px`;
    }
  }, [draftTitle]);

  const commitTitle = useCallback(async () => {
    const accepted = await tryRename('canvas', canvasId, draftTitle);
    if (!accepted) {
      // Restore the input to whatever the store currently holds — either
      // the previous title (if reverted) or unchanged.
      setDraftTitle(useCanvasStore.getState().canvasTitle);
    }
  }, [canvasId, draftTitle, tryRename]);

  // ─── Export ──────────────────────────────────────────────────────────────

  const handleExport = useCallback(async () => {
    setIsOpen(false);
    try {
      await exportCanvas(canvasId);
      toast(t('canvasList.exportStarted'), { tone: 'success' });
    } catch (err) {
      toast(err instanceof Error ? err.message : t('canvasList.exportFailed'), {
        tone: 'danger',
      });
    }
  }, [canvasId, t]);

  return (
    <div className="flex w-full min-w-0 items-center">
      {/* Hidden sizer span — mirrors input text to measure natural width */}
      <span
        ref={sizerRef}
        aria-hidden
        className="invisible absolute px-1 text-base font-medium whitespace-pre"
      >
        {draftTitle || '\u00a0'}
      </span>
      {isWorld ? (
        <span className="text-fg-default truncate px-1 py-1 text-base font-medium">
          {t('world.title')}
        </span>
      ) : (
        <input
          ref={inputRef}
          name="space-title"
          autoComplete="off"
          className="text-fg-default focus:shadow-bottom m-0 max-w-full min-w-8 overflow-hidden bg-transparent px-1 py-1 text-base font-medium text-ellipsis outline-none focus:rounded-md"
          value={draftTitle}
          onChange={(e) => setDraftTitle(e.target.value)}
          onBlur={() => void commitTitle()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              inputRef.current?.blur();
            } else if (e.key === 'Escape') {
              setDraftTitle(canvasTitle);
              inputRef.current?.blur();
            }
          }}
          aria-label={t('canvasHeader.titleAria')}
        />
      )}

      <DropdownMenu
        open={isOpen}
        onOpenChange={setIsOpen}
        trigger={
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label={t('canvasHeader.menuAria')}
          >
            <ChevronDown
              className={clsx(
                'text-fg-subtle transition-transform duration-150',
                isOpen && 'rotate-180',
              )}
            />
          </Button>
        }
      >
        <DropdownMenuItem
          shortcut={formatShortcut('Ctrl/Cmd+Z')}
          disabled={!canUndo}
          onClick={() => {
            setIsOpen(false);
            undo();
          }}
        >
          {t('actions.undo')}
        </DropdownMenuItem>
        <DropdownMenuItem
          shortcut={formatShortcut('Ctrl/Cmd+Shift+Z')}
          disabled={!canRedo}
          onClick={() => {
            setIsOpen(false);
            redo();
          }}
        >
          {t('actions.redo')}
        </DropdownMenuItem>
        <div className="border-edge-default my-1 border-t" />
        <DropdownMenuItem onClick={() => void handleExport()}>
          {t('canvasHeader.exportCanvas')}
        </DropdownMenuItem>
        {onOpenShortcuts && (
          <DropdownMenuItem
            shortcut="?"
            onClick={() => {
              setIsOpen(false);
              onOpenShortcuts();
            }}
          >
            {t('shortcuts.title')}
          </DropdownMenuItem>
        )}
      </DropdownMenu>
    </div>
  );
};
