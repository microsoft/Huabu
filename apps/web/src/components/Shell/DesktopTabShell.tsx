// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Folder, House, Plus, Settings, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { getElectronBridge } from '@/hooks/useElectron';

import { UpdateButton } from './UpdateButton';
import { Button, type Tone } from '../Common/Button';
import { cn } from '../Common/cn';

import type {
  DesktopTabResult,
  DesktopTabsSnapshot,
} from '@huabu/shared/desktop-tabs';
import type { CSSProperties, KeyboardEvent } from 'react';

const NEW_DESKTOP_TAB_ID = 'new-tab';

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

  if (!tabs || !bridge) return null;

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
    const count = snapshot.tabs.length;
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
        {snapshot?.tabs.map((tab, index) => (
          <div
            key={tab.id}
            className={cn(
              'group/tab border-edge-default flex shrink-0 items-center border-r',
              tab.id !== 'home' && 'pr-1',
              tab.id === snapshot.activeId
                ? 'bg-bg-default'
                : !snapshot.busy && 'hover:bg-hover',
            )}
          >
            <Button
              role="tab"
              aria-selected={tab.id === snapshot.activeId}
              aria-label={
                tab.id === NEW_DESKTOP_TAB_ID
                  ? t('desktopTabs.newTab')
                  : tab.canvasId
                    ? tab.title || t('canvasList.untitled')
                    : t('navigation.home')
              }
              tabIndex={tab.id === snapshot.activeId ? 0 : -1}
              variant="ghost"
              size={tab.id === 'home' ? 'md' : 'sm'}
              iconOnly={tab.id === 'home'}
              disabled={snapshot.busy}
              className={cn(
                'h-full rounded-none enabled:hover:bg-transparent',
                tab.id === 'home'
                  ? 'w-10'
                  : 'max-w-48 gap-1.5 px-3 text-[13px] leading-5 font-normal',
              )}
              onClick={() => run(tabs.activate(tab.id))}
              onKeyDown={(event) => onTabKeyDown(event, index)}
            >
              {tab.id !== 'home' ? (
                <span
                  className={cn(
                    'truncate',
                    tab.id === snapshot.activeId
                      ? 'text-fg-default'
                      : 'text-fg-muted',
                  )}
                >
                  {tab.id === NEW_DESKTOP_TAB_ID
                    ? t('desktopTabs.newTab')
                    : tab.title || t('canvasList.untitled')}
                </span>
              ) : (
                <House aria-hidden />
              )}
            </Button>
            {tab.id !== 'home' ? (
              <Button
                variant="ghost"
                size="md"
                iconOnly
                className="h-7 w-7 shrink-0 opacity-0 group-hover/tab:opacity-100 group-has-[:focus-visible]/tab:opacity-100 [@media(hover:none)]:opacity-100"
                aria-label={t('desktopTabs.closeTab')}
                disabled={snapshot.busy}
                onClick={() => run(tabs.close(tab.id))}
              >
                <X />
              </Button>
            ) : null}
          </div>
        ))}
      </div>
      <div
        className="flex shrink-0 items-center gap-1"
        style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
      >
        <UpdateButton onFeedback={onFeedback} showTooltips={false} />
        <Button
          variant="ghost"
          size="md"
          iconOnly
          aria-label={t('desktopTabs.newTab')}
          disabled={snapshot?.busy}
          onClick={() => run(tabs.command('new-tab'))}
        >
          <Plus />
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
      {homeMenuSupported && (
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
  );
}
