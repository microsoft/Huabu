// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import clsx from 'clsx';
import { ChevronDown } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { REQUEST_REPARENT_SPACE } from '@/utils/spaceHierarchy';

import { ApiError } from '../../../api/_client';
import {
  CANVAS_ACCESS_CHANGED_EVENT,
  exportCanvas,
} from '../../../api/canvas.ts';
import useCanvasStore, {
  selectCanManageCanvas,
  selectCanWriteCanvas,
} from '../../../store/canvasStore.ts';
import { useIdentityStore } from '../../../store/identityStore.ts';
import { useWorkspaceStore } from '../../../store/workspaceStore.ts';
import { formatShortcut } from '../../../utils/platform.ts';
import { Button } from '../../Common/Button.tsx';
import { DropdownMenu, DropdownMenuItem } from '../../Common/DropdownMenu.tsx';
import { Input } from '../../Common/Input';
import { MENU_SEPARATOR_CLASS } from '../../Common/menuStyles';
import { toast } from '../../Common/Toast.tsx';
import { useSpaceParentMove } from '../../Space/useSpaceParentMove';

/**
 * canvas title + dropdown menu.
 * Sits in the header and exposes Export / Import canvas actions.
 */
export const CanvasMenu: React.FC = () => {
  const { t } = useTranslation();
  const canvasTitle = useCanvasStore((s) => s.canvasTitle);
  const tryRename = useCanvasStore((s) => s.tryRename);
  const canvasId = useCanvasStore((s) => s.canvasId);
  const canManage = useCanvasStore(selectCanManageCanvas);
  const canWrite = useCanvasStore(selectCanWriteCanvas);
  const bubble = useIdentityStore((s) => s.identity?.provider === 'bubble');
  const isWorld = useWorkspaceStore((s) => s.worldCanvasId === canvasId);
  const parentSpaceId = useWorkspaceStore(
    (s) => s.spaceSummaries[canvasId]?.parentSpaceId,
  );
  const { move, busy, canMove } = useSpaceParentMove();
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
  const menuRef = useRef<HTMLButtonElement>(null);
  const sizerRef = useRef<HTMLSpanElement>(null);

  // Sync the local draft whenever the store title changes (e.g. on canvas
  // switch, undo, or a rejected rename revert).
  useEffect(() => {
    setDraftTitle(canvasTitle);
  }, [canvasTitle, canManage]);

  // The current Space header owns one lightweight permission refresh loop.
  // Foreground checks apply administrator changes promptly; polling bounds
  // changes made elsewhere without replacing unsaved node content.
  useEffect(() => {
    if (!bubble || !canvasId) return;
    const refresh = () => {
      if (document.visibilityState === 'visible')
        void useCanvasStore.getState().refreshCanvasAccess();
    };
    const refused = (event: Event) => {
      if ((event as CustomEvent<string>).detail === canvasId) refresh();
    };
    refresh();
    const timer = window.setInterval(refresh, 15_000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener(CANVAS_ACCESS_CHANGED_EVENT, refused);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener(CANVAS_ACCESS_CHANGED_EVENT, refused);
    };
  }, [bubble, canvasId]);

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
    if (!selectCanManageCanvas(useCanvasStore.getState())) {
      setDraftTitle(useCanvasStore.getState().canvasTitle);
      return;
    }
    const workspaceId = useWorkspaceStore.getState().workspaceId;
    const accepted = await tryRename('canvas', canvasId, draftTitle);
    if (!accepted) {
      // Restore the input to whatever the store currently holds — either
      // the previous title (if reverted) or unchanged.
      setDraftTitle(useCanvasStore.getState().canvasTitle);
    } else if (
      useWorkspaceStore.getState().workspaceId === workspaceId &&
      useCanvasStore.getState().canvasId === canvasId
    ) {
      useWorkspaceStore
        .getState()
        .setSpaceTitle(canvasId, useCanvasStore.getState().canvasTitle);
      void useWorkspaceStore.getState().refreshSpaceTitles([canvasId]);
    }
  }, [canvasId, draftTitle, tryRename]);

  // ─── Export ──────────────────────────────────────────────────────────────

  const handleExport = useCallback(async () => {
    setIsOpen(false);
    try {
      await exportCanvas(canvasId);
      toast(t('canvasList.exportStarted'), { tone: 'success' });
    } catch (err) {
      toast(
        err instanceof ApiError && err.code === 'STORAGE_CAPABILITY_UNAVAILABLE'
          ? t('canvasList.exportUnavailable')
          : err instanceof Error
            ? err.message
            : t('canvasList.exportFailed'),
        { tone: 'danger' },
      );
    }
  }, [canvasId, t]);

  return (
    <div
      role="group"
      aria-label={t('canvasHeader.titleAria')}
      className="group hover:bg-hover flex w-fit max-w-full min-w-0 items-center overflow-hidden rounded-md transition-colors"
    >
      {/* Hidden sizer span — mirrors input text to measure natural width */}
      <span
        ref={sizerRef}
        aria-hidden
        className="invisible absolute pr-0.5 pl-1.5 text-[15px] leading-6 font-medium whitespace-pre"
      >
        {draftTitle || '\u00a0'}
      </span>
      {isWorld ? (
        <span className="text-fg-default h-7 truncate py-0.5 pr-0.5 pl-1.5 text-[15px] leading-6 font-medium">
          {t('world.title')}
        </span>
      ) : (
        <Input
          ref={inputRef}
          name="space-title"
          title={draftTitle}
          autoComplete="off"
          className="text-fg-default focus:shadow-bottom m-0 h-7 max-w-full min-w-8 overflow-hidden bg-transparent py-0.5 pr-0.5 pl-1.5 text-[15px] leading-6 font-medium text-ellipsis outline-none"
          value={draftTitle}
          readOnly={!canManage}
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

      <div className="group-hover:border-edge-default h-7 shrink-0 border-l border-transparent transition-colors">
        <DropdownMenu
          open={isOpen}
          onOpenChange={(open) => {
            setIsOpen(open);
            if (open && !isWorld && !canMove(canvasId))
              void useWorkspaceStore.getState().refreshSpaceTitles();
          }}
          trigger={
            <Button
              ref={menuRef}
              variant="ghost"
              size="sm"
              iconOnly
              className="text-fg-subtle enabled:hover:text-fg-default enabled:hover:bg-inverse/10 h-7 w-6 justify-start rounded-none pr-1.5 pl-0.5"
              aria-label={t('canvasHeader.menuAria')}
            >
              <ChevronDown
                className={clsx(
                  'h-4! w-4! transition-transform duration-150',
                  isOpen && 'rotate-180',
                )}
              />
            </Button>
          }
        >
          <DropdownMenuItem
            shortcut={formatShortcut('Ctrl/Cmd+Z')}
            disabled={!canWrite || !canUndo}
            onClick={() => {
              setIsOpen(false);
              undo();
            }}
          >
            {t('actions.undo')}
          </DropdownMenuItem>
          <DropdownMenuItem
            shortcut={formatShortcut('Ctrl/Cmd+Shift+Z')}
            disabled={!canWrite || !canRedo}
            onClick={() => {
              setIsOpen(false);
              redo();
            }}
          >
            {t('actions.redo')}
          </DropdownMenuItem>
          <div role="separator" className={MENU_SEPARATOR_CLASS} />
          <DropdownMenuItem onClick={() => void handleExport()}>
            {t('canvasHeader.exportCanvas')}
          </DropdownMenuItem>
          {!isWorld && (
            <>
              <DropdownMenuItem
                disabled={!canManage || busy || !canMove(canvasId)}
                onClick={() => {
                  setIsOpen(false);
                  window.dispatchEvent(
                    new CustomEvent(REQUEST_REPARENT_SPACE, {
                      detail: menuRef.current,
                    }),
                  );
                }}
              >
                {t('spaceHierarchy.move')}
              </DropdownMenuItem>
              {parentSpaceId && (
                <DropdownMenuItem
                  disabled={!canManage || busy || !canMove(canvasId)}
                  onClick={() => {
                    setIsOpen(false);
                    void move(canvasId, null, parentSpaceId);
                  }}
                >
                  {t('spaceHierarchy.moveToTopLevel')}
                </DropdownMenuItem>
              )}
            </>
          )}
        </DropdownMenu>
      </div>
    </div>
  );
};
