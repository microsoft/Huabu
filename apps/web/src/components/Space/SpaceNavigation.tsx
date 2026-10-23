// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { ArrowLeft } from 'lucide-react';
import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate } from 'react-router-dom';

import { Button } from '@/components/Common/Button';
import {
  DropdownMenu,
  DropdownMenuLink,
} from '@/components/Common/DropdownMenu';
import useCanvasStore from '@/store/canvasStore';
import { useWorkspaceStore } from '@/store/workspaceStore';
import { spaceAncestorIds } from '@/utils/spaceHierarchy';

export function SpaceNavigation({
  children,
  widthBoundary,
}: {
  children: ReactNode;
  widthBoundary?: RefObject<HTMLElement | null>;
}) {
  const { t } = useTranslation();
  const canvasId = useCanvasStore((state) => state.canvasId);
  const canvasTitle = useCanvasStore((state) => state.canvasTitle);
  const titles = useWorkspaceStore((state) => state.spaceTitles);
  const summaries = useWorkspaceStore((state) => state.spaceSummaries);
  const error = useWorkspaceStore((state) => state.spaceTitlesError);
  const refresh = useWorkspaceStore((state) => state.refreshSpaceTitles);
  const [ancestorsOpen, setAncestorsOpen] = useState(false);
  const [hiddenCount, setHiddenCount] = useState(0);
  const navRef = useRef<HTMLElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    void refresh();
  }, [canvasId, refresh]);
  const ancestors = spaceAncestorIds(canvasId, summaries).slice(0, -1);
  const label = (id: string) => titles[id] || t('canvasList.untitled');
  const pathKey = JSON.stringify(ancestors.map(label));
  useLayoutEffect(() => {
    const nav = navRef.current;
    const measure = measureRef.current;
    if (!nav || !measure) return;
    const update = () => {
      const widths = Array.from(
        measure.children,
        (child) => child.getBoundingClientRect().width,
      );
      const current = widths.pop() ?? 64;
      const navWidth = nav.getBoundingClientRect().width;
      const header = nav.closest('header');
      const boundary = widthBoundary?.current;
      const available =
        (header && boundary
          ? boundary.getBoundingClientRect().width -
            header.getBoundingClientRect().width +
            navWidth
          : navWidth) - (error ? 28 : 0);
      // Each ancestor includes its following separator and gap. Keep the root
      // and remove middle ancestors first, then the direct parent if necessary.
      const separator = 12;
      const overflow = 32;
      let total =
        current + widths.reduce((sum, width) => sum + width + separator, 0);
      let count = 0;
      while (total > available && count < widths.length - 1) {
        if (count === 0) total += overflow;
        total -= widths[count + 1] + separator;
        count++;
      }
      setHiddenCount(count);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(nav);
    if (widthBoundary?.current) observer.observe(widthBoundary.current);
    for (const child of measure.children) observer.observe(child);
    return () => observer.disconnect();
  }, [pathKey, canvasTitle, error, widthBoundary]);
  const hidden = ancestors.slice(1, hiddenCount + 1);
  const visible = ancestors.filter(
    (_, index) => index === 0 || index > hiddenCount,
  );
  return (
    <nav
      ref={navRef}
      aria-label={t('spaceHierarchy.breadcrumb')}
      className="relative h-7 min-w-0 text-[15px]"
    >
      <div
        ref={measureRef}
        aria-hidden
        className="pointer-events-none invisible absolute flex h-0 w-max whitespace-nowrap"
      >
        {ancestors.map((id) => (
          <span key={id} className="max-w-32 shrink-0 truncate px-1">
            {label(id)}
          </span>
        ))}
        <span className="max-w-60 min-w-16 shrink-0 truncate pr-9 pl-1.5 text-[15px] font-medium">
          {canvasTitle || label(canvasId)}
        </span>
      </div>
      <div className="flex h-full min-w-0 items-center gap-0.5">
        {visible.map((id, index) => (
          <Fragment key={id}>
            <Link
              to={`/canvas/${id}`}
              title={label(id)}
              className="text-fg-muted hover:text-fg-default max-w-32 min-w-0 truncate rounded px-1 py-0.5"
            >
              {label(id)}
            </Link>
            <span className="text-fg-subtle shrink-0" aria-hidden>
              /
            </span>
            {index === 0 && hidden.length > 0 && (
              <>
                <DropdownMenu
                  open={ancestorsOpen}
                  onOpenChange={setAncestorsOpen}
                  trigger={
                    <Button
                      variant="ghost"
                      iconOnly
                      size="sm"
                      className="min-w-5 px-0.5"
                      title={t('spaceHierarchy.ancestors')}
                    >
                      <span aria-hidden className="text-base leading-4">
                        …
                      </span>
                    </Button>
                  }
                >
                  {hidden.map((id) => (
                    <DropdownMenuLink
                      key={id}
                      to={`/canvas/${id}`}
                      onClick={() => setAncestorsOpen(false)}
                    >
                      {label(id)}
                    </DropdownMenuLink>
                  ))}
                </DropdownMenu>
                <span className="text-fg-subtle shrink-0" aria-hidden>
                  /
                </span>
              </>
            )}
          </Fragment>
        ))}
        <div aria-current="page" className="max-w-60 min-w-16 shrink">
          {children}
        </div>
        {error && (
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            className="text-warning"
            title={`${error} — ${t('spacePreview.retry')}`}
            onClick={() => void refresh()}
          >
            !
          </Button>
        )}
      </div>
    </nav>
  );
}

export function SpaceReturnButton() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const canvasId = useCanvasStore((state) => state.canvasId);
  const workspaceId = useWorkspaceStore((state) => state.workspaceId);
  const worldId = useWorkspaceStore((state) => state.worldCanvasId);
  const titles = useWorkspaceStore((state) => state.spaceTitles);
  const navigationState: unknown = location.state;
  const returnTo =
    typeof navigationState === 'object' &&
    navigationState !== null &&
    'workspaceId' in navigationState &&
    navigationState.workspaceId === workspaceId &&
    'returnToSpace' in navigationState &&
    typeof navigationState.returnToSpace === 'string' &&
    navigationState.returnToSpace !== canvasId
      ? navigationState.returnToSpace
      : null;
  if (!returnTo) return null;
  return (
    <Button
      variant="ghost"
      size="sm"
      iconOnly
      className="text-fg-subtle enabled:hover:text-fg-default"
      tooltipWrapperClassName="inline-flex shrink-0"
      title={t('spaceHierarchy.backTo', {
        name:
          returnTo === worldId
            ? t('world.title')
            : titles[returnTo] || t('canvasList.untitled'),
      })}
      onClick={() => navigate(-1)}
    >
      <ArrowLeft aria-hidden className="h-4! w-4!" />
    </Button>
  );
}
