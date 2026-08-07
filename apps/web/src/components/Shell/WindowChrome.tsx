// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { BookOpen, House } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router-dom';

import { SettingsPopover } from '@/components/Settings/SettingsPopover';

import { UpdateButton } from './UpdateButton';
import { APP_NAME } from '../../config/app';
import { openUserHandbook } from '../../config/handbook';
import { getElectronBridge } from '../../hooks/useElectron';
import useCanvasStore from '../../store/canvasStore';
import {
  useWorkspaceLabel,
  useWorkspaceStore,
} from '../../store/workspaceStore';
import { Button } from '../Common/Button';
import { Tooltip } from '../Common/Tooltip';
import { AppMenu } from '../Panels/Header/AppMenu';

/**
 * Width (in px) reserved on the right edge of the title bar for the
 * native window controls (minimize / maximize / close) that the OS
 * paints on top of our overlay region on Windows. Empirically ~138px
 * covers both Windows 10 and 11 caption button widths with breathing
 * room; macOS doesn't need this (controls live on the left) but we
 * pad the left gutter via `LEFT_GUTTER_MAC_PX` instead.
 */
const RIGHT_OVERLAY_WIDTH_PX = 138;
const LEFT_GUTTER_MAC_PX = 76;

/**
 * Custom window chrome rendered above the application router. Replaces
 * the default Electron application menu (`File / Edit / View / Window /
 * Help`) with a single 36px strip containing:
 *
 *   home  ·  current page label  ·  settings  ·  [ OS min/max/close ]
 *
 * The strip itself acts as the window drag handle (CSS
 * `-webkit-app-region: drag`); every interactive child opts back out
 * via `appRegion: 'no-drag'` so clicks behave normally.
 *
 * Rendered **only inside the Electron shell** — in a plain browser the
 * component returns `null` and the existing in-page headers stay
 * unchanged. The main process configures `titleBarStyle` / overlay so
 * the OS-drawn caption controls float above the right edge of this row.
 */
export function WindowChrome() {
  const { t } = useTranslation();
  const bridge = getElectronBridge();
  const location = useLocation();
  const canvasTitle = useCanvasStore((s) => s.canvasTitle);
  const workspaceLabel = useWorkspaceLabel();
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const canChangeWorkspace = useWorkspaceStore(
    (s) => s.capabilities?.canChangeWorkspace ?? true,
  );
  const canvasCount = useWorkspaceStore((s) => s.canvasCount);

  const [isFullScreen, setIsFullScreen] = useState(false);
  useEffect(() => {
    const windowApi = bridge?.window;
    if (!windowApi) return;
    let cancelled = false;
    void windowApi.isFullScreen().then((value) => {
      if (!cancelled) setIsFullScreen(value);
    });
    const unsubscribe = windowApi.onFullScreenChange((value) => {
      setIsFullScreen(value);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [bridge]);

  const HIDE_DEBOUNCE_MS = 180;
  const FADE_IN_MS = 180;
  const [transitioning, setTransitioning] = useState(false);
  const isMacBridge = bridge?.platform === 'darwin';
  useEffect(() => {
    if (!isMacBridge || typeof window === 'undefined') return;
    let stableTimer: ReturnType<typeof setTimeout> | null = null;
    const onResize = () => {
      setTransitioning(true);
      if (stableTimer) clearTimeout(stableTimer);
      stableTimer = setTimeout(() => setTransitioning(false), HIDE_DEBOUNCE_MS);
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      if (stableTimer) clearTimeout(stableTimer);
    };
  }, [isMacBridge]);

  // Browser mode: leave the page chrome untouched.
  if (!bridge) return null;

  const isMac = bridge.platform === 'darwin';
  // macOS hides the traffic-lights in immersive fullscreen, so the
  // gutter would just be dead space. Other platforms keep their
  // padding unchanged.
  const macLeftPadding = isFullScreen ? 8 : LEFT_GUTTER_MAC_PX;

  // Pick the centre label based on the current route:
  //   - On the canvas list ("/"): show the workspace folder name so the
  //     user can see and switch their workspace right from the title
  //     bar. This replaces the secondary "Huabu | Path: ..." strip that
  //     CanvasListPage used to render below.
  //   - Inside a canvas ("/canvas/:id"): show the live canvas title.
  //   - Anywhere else (setup, playgrounds, docs): fall back to APP_NAME
  //     so the bar never looks empty.
  const onCanvasListRoute = location.pathname === '/spaces';
  const onWorkspaceSetupRoute = location.pathname === '/setup';
  const showAppMenu = onCanvasListRoute || onWorkspaceSetupRoute;
  const onCanvasRoute = location.pathname.startsWith('/canvas/');
  const showWorkspaceSwitcher = onCanvasListRoute && !!workspaceLabel;
  const centerLabel = showWorkspaceSwitcher
    ? workspaceLabel
    : onCanvasRoute && canvasTitle
      ? canvasTitle
      : APP_NAME;

  return (
    <div
      // Note: no `border-b` here on purpose. On Windows the system
      // paints the caption buttons via `titleBarOverlay` on top of our
      // HTML, which would hide the right-most ~138px of any border we
      // drew — leaving an obviously broken hairline. We rely on the
      // page chrome below (canvas header / route container) to provide
      // its own top edge instead.
      className="bg-surface relative flex w-full shrink-0 items-center gap-2 px-2"
      style={
        {
          // Sourced from the preload bridge so a change to
          // `TITLE_BAR_HEIGHT` in the desktop main process propagates
          // here automatically, keeping the Windows `titleBarOverlay`
          // and our HTML row pixel-aligned.
          height: bridge.titleBarHeight,
          // The whole strip is draggable; interactive children opt out
          // individually so clicks register as clicks instead of starting
          // a window drag.
          WebkitAppRegion: 'drag',
          // macOS traffic-lights sit on the left edge of the window. Push
          // our home button to the right of them so they don't overlap.
          // In immersive fullscreen the OS hides the traffic-lights, so
          // collapse the gutter to avoid a visible gap to the window edge.
          paddingLeft: isMac ? macLeftPadding : 8,
          // Windows caption buttons float over the right edge via
          // titleBarOverlay; reserve their width here so our settings
          // button doesn't slip under them.
          paddingRight: isMac ? 8 : RIGHT_OVERLAY_WIDTH_PX,
        } as React.CSSProperties
      }
    >
      {/* Left: AppMenu on workspace-level pages; Home elsewhere. The Home
          link uses our own Tooltip (placement="bottom") instead of the
          browser-native `title` attribute so it matches the rest of the
          title bar and renders below the trigger. Control sizes align with
          the md `<Button iconOnly>` used on the right. While the macOS
          fullscreen animation is running the wrapper is hidden instantly
          (no transition out)
          and fades back in only once the window dimensions settle —
          see the `transitioning` effect above. */}
      <div
        style={
          {
            WebkitAppRegion: 'no-drag',
            opacity: transitioning ? 0 : 1,
            // Instant hide on the way out, soft fade on the way in.
            // Setting transition to `none` while transitioning means
            // the opacity 1 → 0 step is a hard snap (the user never
            // perceives a fade-out); the `else` branch arms a smooth
            // fade-in for the next render after `transitioning`
            // flips back to false.
            transition: transitioning ? 'none' : `opacity ${FADE_IN_MS}ms ease`,
          } as React.CSSProperties
        }
      >
        {showAppMenu ? (
          // On workspace-level pages, the left slot hosts the app menu.
          // Inside a canvas the House button below keeps its back-to-list
          // navigation and the app menu lives in the canvas header.
          //
          // macOS is the exception: its workspace-level actions live in
          // the native menu bar (see `NativeMenuBridge`), so we leave the
          // left slot empty here rather than crowd a logo dropdown next
          // to the traffic-lights.
          isMac ? null : (
            <AppMenu compact />
          )
        ) : (
          <Tooltip content={t('navigation.home')} placement="bottom">
            <Link
              to="/"
              aria-label={t('navigation.backHome')}
              className="text-fg-muted hover:bg-hover hover:text-fg-default flex h-7 w-7 items-center justify-center rounded-md transition-colors"
            >
              <House className="h-4 w-4" />
            </Link>
          </Tooltip>
        )}
      </div>

      {/* Center: page / canvas title, or the workspace folder name on
          the canvas list page. Absolutely positioned at the window's
          true horizontal center (`left-1/2 -translate-x-1/2`) so the
          label stays centred relative to the whole window rather than
          the space left between the asymmetric side gutters (macOS
          traffic-lights on the left, Windows caption buttons on the
          right). `max-w-[50%]` keeps long canvas / folder names from
          sliding under the side controls; they truncate with ellipsis. */}
      <div className="pointer-events-none absolute left-1/2 flex max-w-[50%] min-w-0 -translate-x-1/2 items-center justify-center">
        {showWorkspaceSwitcher ? (
          <Tooltip
            placement="bottom"
            content={
              <div className="text-center">
                <div>
                  {workspacePath
                    ? t('workspace.path', { path: workspacePath })
                    : t('workspace.workspace', { workspace: workspaceLabel })}
                </div>
                {canvasCount !== null && (
                  <div>
                    {t('canvasList.canvasCount', { count: canvasCount })}
                  </div>
                )}
                {canChangeWorkspace && (
                  <div className="text-fg-subtle mt-1">
                    {t('workspace.clickToSwitch')}
                  </div>
                )}
              </div>
            }
          >
            {canChangeWorkspace ? (
              <Link
                to="/setup"
                // Opt out of the title bar's drag region so this click
                // navigates instead of starting a window drag. Re-enable
                // pointer events disabled on the wrapper so the link stays
                // clickable.
                style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
                className="text-fg-muted hover:text-fg-default hover:bg-hover pointer-events-auto max-w-full truncate rounded-md px-2 py-0.5 text-sm font-medium transition-colors"
              >
                {workspaceLabel}
              </Link>
            ) : (
              <span
                className="text-fg-muted truncate text-sm font-medium"
                title={centerLabel ?? undefined}
              >
                {centerLabel}
              </span>
            )}
          </Tooltip>
        ) : (
          <span
            className="text-fg-muted truncate text-sm font-medium"
            title={centerLabel ?? undefined}
          >
            {centerLabel}
          </span>
        )}
      </div>

      {/* Right: persistent global controls (handbook + settings). Both
          are duplicated here so the user can reach them from anywhere
          in the desktop app without hunting through the canvas chrome;
          the in-canvas floating versions hide themselves in Electron.
          Tooltips are forced to `bottom` because there is no room
          above the title bar. The buttons are sized `md` so they
          visually match the OS-drawn caption buttons on Windows. */}
      <div
        className="ml-auto flex items-center gap-1"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <UpdateButton />
        <Button
          variant="ghost"
          size="md"
          iconOnly
          title={t('navigation.userHandbook')}
          tooltipPlacement="bottom"
          aria-label={t('navigation.openUserHandbook')}
          onClick={openUserHandbook}
        >
          <BookOpen />
        </Button>
        <SettingsPopover variant="ghost" size="md" tooltipPlacement="bottom" />
      </div>
    </div>
  );
}
