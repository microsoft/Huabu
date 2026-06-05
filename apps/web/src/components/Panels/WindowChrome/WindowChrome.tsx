import { BookOpen, House } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';

import { APP_NAME } from '../../../config/app';
import { getElectronBridge } from '../../../hooks/useElectron';
import useCanvasStore from '../../../store/canvasStore';
import {
  useWorkspaceLabel,
  useWorkspaceStore,
} from '../../../store/workspaceStore';
import { Button } from '../../Common/Button';
import { Tooltip } from '../../Common/Tooltip';
import { SettingsPopover } from '../Header/SettingsPopover';

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
  const bridge = getElectronBridge();
  const location = useLocation();
  const canvasTitle = useCanvasStore((s) => s.canvasTitle);
  const workspaceLabel = useWorkspaceLabel();
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const canChangeWorkspace = useWorkspaceStore(
    (s) => s.capabilities?.canChangeWorkspace ?? true,
  );
  const canvasCount = useWorkspaceStore((s) => s.canvasCount);

  // Browser mode: leave the page chrome untouched.
  if (!bridge) return null;

  const isMac = bridge.platform === 'darwin';

  // Pick the centre label based on the current route:
  //   - On the canvas list ("/"): show the workspace folder name so the
  //     user can see and switch their workspace right from the title
  //     bar. This replaces the secondary "Huabu | Path: ..." strip that
  //     CanvasListPage used to render below.
  //   - Inside a canvas ("/canvas/:id"): show the live canvas title.
  //   - Anywhere else (setup, playgrounds, docs): fall back to APP_NAME
  //     so the bar never looks empty.
  const onCanvasListRoute = location.pathname === '/';
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
          paddingLeft: isMac ? LEFT_GUTTER_MAC_PX : 8,
          // Windows caption buttons float over the right edge via
          // titleBarOverlay; reserve their width here so our settings
          // button doesn't slip under them.
          paddingRight: isMac ? 8 : RIGHT_OVERLAY_WIDTH_PX,
        } as React.CSSProperties
      }
    >
      {/* Left: home / back-to-canvas-list. Wrapped in our own Tooltip
          (placement="bottom") instead of relying on the browser-native
          `title` attribute so it matches the rest of the title bar and
          renders below the trigger — there is no room above. Box and
          icon sizes mirror the md `<Button iconOnly>` used on the right
          (28px hit area, 16px icon) so all three controls sit on the
          same baseline. */}
      <div style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <Tooltip content="Home" placement="bottom">
          <Link
            to="/"
            aria-label="Back to home"
            className="text-fg-muted hover:bg-hover hover:text-fg-default flex h-7 w-7 items-center justify-center rounded-md transition-colors"
          >
            <House className="h-4 w-4" />
          </Link>
        </Tooltip>
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
                    ? `Path: ${workspacePath}`
                    : `Workspace: ${workspaceLabel}`}
                </div>
                {canvasCount !== null && (
                  <div>
                    {canvasCount} canvas{canvasCount !== 1 ? 'es' : ''}
                  </div>
                )}
                {canChangeWorkspace && (
                  <div className="text-fg-subtle mt-1">Click to switch</div>
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
        <Button
          variant="ghost"
          size="md"
          iconOnly
          title="User Handbook"
          tooltipPlacement="bottom"
          aria-label="Open user handbook"
          onClick={() => window.open('/docs', '_blank', 'noopener')}
        >
          <BookOpen />
        </Button>
        <SettingsPopover variant="ghost" size="md" tooltipPlacement="bottom" />
      </div>
    </div>
  );
}
