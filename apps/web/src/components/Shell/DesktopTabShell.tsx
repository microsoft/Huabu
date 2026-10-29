// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  closestCenter,
  DndContext,
  DragOverlay,
  useSensor,
  useSensors,
  type Modifier,
} from '@dnd-kit/core';
import {
  arrayMove,
  horizontalListSortingStrategy,
  SortableContext,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Folder, House, Plus, Settings, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { getElectronBridge } from '@/hooks/useElectron';

import { UpdateButton } from './UpdateButton';
import { Button, type Tone } from '../Common/Button';
import { cn } from '../Common/cn';
import { TabPointerSensor } from '../Common/TabPointerSensor';

import type {
  DesktopTab,
  DesktopTabResult,
  DesktopTabsSnapshot,
} from '@huabu/shared/desktop-tabs';
import type { CSSProperties, KeyboardEvent } from 'react';

const NEW_DESKTOP_TAB_ID = 'new-tab';
const horizontalDrag: Modifier = ({ transform }) => ({ ...transform, y: 0 });

function DesktopTabItem({
  tab,
  active,
  disabled,
  onActivate,
  onClose,
  onKeyDown,
}: {
  tab: DesktopTab;
  active: boolean;
  disabled: boolean;
  onActivate: () => void;
  onClose: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}) {
  const { t } = useTranslation();
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: tab.id, disabled: disabled || tab.id === 'home' });
  const title =
    tab.id === NEW_DESKTOP_TAB_ID
      ? t('desktopTabs.newTab')
      : tab.title || t('canvasList.untitled');

  return (
    <div
      ref={setNodeRef}
      data-desktop-tab-id={tab.id}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        'group/tab border-edge-default flex shrink-0 items-center border-r motion-reduce:!transition-none',
        tab.id !== 'home' && 'pr-1',
        active ? 'bg-bg-default' : !disabled && 'hover:bg-hover',
        isDragging && 'opacity-30',
      )}
    >
      <Button
        ref={setActivatorNodeRef}
        {...(tab.id === 'home' ? {} : attributes)}
        {...(tab.id === 'home' ? {} : listeners)}
        role="tab"
        aria-selected={active}
        aria-label={tab.id === 'home' ? t('navigation.home') : title}
        tabIndex={active ? 0 : -1}
        aria-keyshortcuts={
          tab.id === 'home'
            ? undefined
            : 'Alt+Shift+ArrowLeft Alt+Shift+ArrowRight'
        }
        variant="ghost"
        size={tab.id === 'home' ? 'md' : 'sm'}
        iconOnly={tab.id === 'home'}
        aria-disabled={disabled}
        className={cn(
          'h-full touch-none rounded-none enabled:hover:bg-transparent aria-disabled:cursor-not-allowed aria-disabled:opacity-50',
          tab.id === 'home'
            ? 'w-10'
            : 'max-w-48 gap-1.5 px-3 text-[13px] leading-5 font-normal',
        )}
        onClick={() => {
          if (!disabled) onActivate();
        }}
        onKeyDown={onKeyDown}
      >
        {tab.id === 'home' ? (
          <House aria-hidden />
        ) : (
          <span
            className={cn(
              'truncate',
              active ? 'text-fg-default' : 'text-fg-muted',
            )}
          >
            {title}
          </span>
        )}
      </Button>
      {tab.id !== 'home' && (
        <Button
          variant="ghost"
          size="md"
          iconOnly
          className="h-7 w-7 shrink-0 opacity-0 group-hover/tab:opacity-100 group-has-[:focus-visible]/tab:opacity-100 [@media(hover:none)]:opacity-100"
          aria-label={t('desktopTabs.closeTab')}
          disabled={disabled}
          onClick={onClose}
        >
          <X />
        </Button>
      )}
    </div>
  );
}

export default function DesktopTabShell() {
  const bridge = getElectronBridge();
  const tabs = bridge?.tabs;
  const homeMenuSupported = typeof tabs?.onHomeMenu === 'function';
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<DesktopTabsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{
    message: string;
    tone: Tone;
  } | null>(null);
  const onFeedback = useCallback(
    (message: string, tone: Tone) => setFeedback({ message, tone }),
    [],
  );
  const [fullScreen, setFullScreen] = useState(false);
  const [homeMenuOpen, setHomeMenuOpen] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [pendingMove, setPendingMove] = useState<{
    id: string;
    index: number;
  } | null>(null);
  const sensors = useSensors(
    useSensor(TabPointerSensor, {
      activationConstraint: { distance: 5 },
    }),
  );
  const tabList = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!tabs) return;
    let live = true;
    let received = false;
    const unsubscribe = tabs.onState((next) => {
      received = true;
      setSnapshot(next);
    });
    void tabs
      .getState()
      .then((next) => {
        if (live && !received) setSnapshot(next);
      })
      .catch((failure: unknown) => {
        if (live) setError(String(failure));
      });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [tabs]);

  useEffect(() => {
    return tabs?.onHomeMenu?.((position) => setHomeMenuOpen(position !== null));
  }, [tabs]);

  useEffect(() => {
    const api = bridge?.window;
    if (!api) return;
    let live = true;
    const unsubscribe = api.onFullScreenChange(setFullScreen);
    void api
      .isFullScreen()
      .then((next) => {
        if (live) setFullScreen(next);
      })
      .catch((failure: unknown) => setError(String(failure)));
    return () => {
      live = false;
      unsubscribe();
    };
  }, [bridge]);

  useEffect(() => {
    tabList.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [snapshot?.activeId]);

  useEffect(() => {
    if (
      draggingId &&
      (snapshot?.busy || !snapshot?.tabs.some((tab) => tab.id === draggingId))
    )
      document.dispatchEvent(new Event('pointercancel'));
  }, [draggingId, snapshot]);

  if (!tabs || !bridge) return null;

  const displayedTabs = snapshot?.tabs ?? [];
  const from = pendingMove
    ? displayedTabs.findIndex((tab) => tab.id === pendingMove.id)
    : -1;
  const orderedTabs =
    pendingMove && from > 0
      ? arrayMove(
          displayedTabs,
          from,
          Math.min(pendingMove.index, displayedTabs.length - 1),
        )
      : displayedTabs;
  const draggedTab = orderedTabs.find((tab) => tab.id === draggingId);
  const moveTab = (id: string, index: number) => {
    if (snapshot?.busy || pendingMove) return;
    setError(null);
    setPendingMove({ id, index });
    void tabs
      .command({ type: 'move-tab', id, index })
      .then((result) => {
        if (!result.ok && !result.cancelled) setError(result.error);
      })
      .catch((failure: unknown) => setError(String(failure)))
      .finally(() => setPendingMove(null));
  };
  const run = (action: Promise<DesktopTabResult>) => {
    setError(null);
    void action
      .then((result) => {
        if (!result.ok && !result.cancelled) setError(result.error);
      })
      .catch((failure: unknown) => setError(String(failure)));
  };
  const openWorkspaceMenu = (button: HTMLButtonElement) => {
    button.focus();
    run(
      tabs.command({
        type: 'open-home-menu',
        x: button.getBoundingClientRect().left,
      }),
    );
  };
  const onTabKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    if (
      !snapshot ||
      !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)
    )
      return;
    event.preventDefault();
    if (snapshot.busy || pendingMove) return;
    const count = snapshot.tabs.length;
    if (
      event.altKey &&
      event.shiftKey &&
      (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
    ) {
      const next = index + (event.key === 'ArrowLeft' ? -1 : 1);
      if (index > 0 && next > 0 && next < count)
        moveTab(snapshot.tabs[index].id, next);
      return;
    }
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? count - 1
          : (index + (event.key === 'ArrowLeft' ? -1 : 1) + count) % count;
    const nextButton =
      tabList.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[
        next
      ];
    run(
      tabs
        .activate({ id: snapshot.tabs[next].id, focus: 'shell' })
        .then((result) => {
          if (result.ok && nextButton?.isConnected) nextButton.focus();
          return result;
        }),
    );
    nextButton?.focus();
  };

  return (
    <DndContext
      sensors={sensors}
      modifiers={[horizontalDrag]}
      collisionDetection={closestCenter}
      onDragStart={({ active }) => setDraggingId(String(active.id))}
      onDragCancel={() => setDraggingId(null)}
      onDragEnd={({ active, over }) => {
        setDraggingId(null);
        if (!over || active.id === over.id || snapshot?.busy) return;
        const index = orderedTabs.findIndex((tab) => tab.id === over.id);
        if (index > 0) moveTab(String(active.id), index);
      }}
    >
      <div
        className="bg-surface border-edge-default text-fg-default flex items-center border-b pr-2"
        style={
          {
            height: bridge.titleBarHeight,
            paddingLeft: bridge.platform === 'darwin' && !fullScreen ? 76 : 8,
            paddingRight: bridge.platform === 'win32' ? 138 : 8,
            WebkitAppRegion: 'drag',
          } as CSSProperties
        }
      >
        <div
          ref={tabList}
          role="tablist"
          aria-label={t('desktopTabs.label')}
          className="flex h-full min-w-0 items-stretch overflow-x-auto"
          style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
        >
          <SortableContext
            items={orderedTabs
              .filter((tab) => tab.id !== 'home')
              .map((tab) => tab.id)}
            strategy={horizontalListSortingStrategy}
          >
            {orderedTabs.map((tab, index) => (
              <DesktopTabItem
                key={tab.id}
                tab={tab}
                active={tab.id === snapshot?.activeId}
                disabled={!!snapshot?.busy || !!pendingMove}
                onActivate={() => run(tabs.activate(tab.id))}
                onClose={() => run(tabs.close(tab.id))}
                onKeyDown={(event) => onTabKeyDown(event, index)}
              />
            ))}
          </SortableContext>
        </div>
        <div
          className="ml-1 flex shrink-0 items-center gap-1"
          style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
        >
          <UpdateButton onFeedback={onFeedback} showTooltips={false} />
          <Button
            variant="ghost"
            size="md"
            iconOnly
            className="enabled:hover:before:bg-hover relative before:pointer-events-none before:absolute before:inset-0.5 before:rounded-md before:transition-colors enabled:hover:bg-transparent"
            aria-label={t('desktopTabs.newTab')}
            disabled={snapshot?.busy}
            onClick={() => run(tabs.command('new-tab'))}
          >
            <Plus className="relative" />
          </Button>
        </div>
        {error ? (
          <span
            role="alert"
            className="text-danger min-w-0 truncate text-xs"
            title={error}
          >
            {error}
          </span>
        ) : null}
        {!error && feedback ? (
          <span
            role="status"
            className={cn(
              'min-w-0 truncate text-xs',
              feedback.tone === 'danger'
                ? 'text-danger'
                : feedback.tone === 'success'
                  ? 'text-success'
                  : 'text-info',
            )}
            title={feedback.message}
          >
            {feedback.message}
          </span>
        ) : null}
        <Button
          variant="ghost"
          size="md"
          iconOnly
          className="ml-auto shrink-0"
          style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
          aria-label={t('settings.open')}
          disabled={snapshot?.busy}
          onClick={() => run(tabs.command('open-settings'))}
        >
          <Settings aria-hidden />
        </Button>
        {homeMenuSupported && snapshot?.canChangeWorkspace && (
          <Button
            variant="ghost"
            size="md"
            iconOnly
            className="shrink-0"
            style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
            aria-label={t('workspace.switcher')}
            aria-haspopup="menu"
            aria-expanded={homeMenuOpen}
            disabled={snapshot?.busy}
            onClick={(event) => openWorkspaceMenu(event.currentTarget)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                openWorkspaceMenu(event.currentTarget);
              }
            }}
          >
            <Folder aria-hidden />
          </Button>
        )}
      </div>
      {createPortal(
        <DragOverlay dropAnimation={null}>
          {draggedTab && (
            <div
              data-testid="desktop-tab-drag-overlay"
              className="bg-bg-default text-fg-default border-edge-default flex h-full items-center border-r pr-1 text-[13px] leading-5 font-normal shadow-md"
            >
              <span className="min-w-0 flex-1 truncate px-3">
                {draggedTab.id === NEW_DESKTOP_TAB_ID
                  ? t('desktopTabs.newTab')
                  : draggedTab.title || t('canvasList.untitled')}
              </span>
              <span className="flex h-7 w-7 shrink-0 items-center justify-center">
                <X size={16} aria-hidden />
              </span>
            </div>
          )}
        </DragOverlay>,
        document.body,
      )}
    </DndContext>
  );
}
