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
        if (!result.ok) setError(result.error);
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
    run(tabs.activate(snapshot.tabs[next].id));
    tabList.current
      ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
      [next]?.focus();
  };

  return (
    <div
      className="bg-surface border-edge-default text-fg-default flex items-center gap-1 border-b px-2"
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
        className="flex min-w-0 items-center gap-1 overflow-x-auto"
        style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
      >
        {snapshot?.tabs.map((tab, index) => (
          <div
            key={tab.id}
            className={cn(
              'flex shrink-0 items-center rounded-md',
              tab.id === snapshot.activeId && 'bg-hover',
            )}
          >
            <Button
              role="tab"
              aria-selected={tab.id === snapshot.activeId}
              aria-label={tab.canvasId ? tab.title : t('navigation.home')}
              tabIndex={tab.id === snapshot.activeId ? 0 : -1}
              variant="ghost"
              size={tab.canvasId ? 'sm' : 'md'}
              iconOnly={!tab.canvasId}
              disabled={snapshot.busy}
              className={cn(
                'h-7',
                tab.canvasId ? 'max-w-48 gap-1.5 px-2' : 'w-7',
              )}
              onClick={() => run(tabs.activate(tab.id))}
              onKeyDown={(event) => onTabKeyDown(event, index)}
            >
              {tab.canvasId ? (
                <span
                  className={cn(
                    'truncate',
                    tab.id === snapshot.activeId
                      ? 'text-fg-default'
                      : 'text-fg-muted',
                  )}
                >
                  {tab.title}
                </span>
              ) : (
                <House aria-hidden />
              )}
            </Button>
            {tab.canvasId ? (
              <Button
                variant="ghost"
                size="md"
                iconOnly
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
          aria-label={t('desktopTabs.openSpace')}
          disabled={snapshot?.busy}
          onClick={() => run(tabs.open({ canvasId: null }))}
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
