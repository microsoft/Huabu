// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  Download,
  FolderInput,
  FolderUp,
  MoreHorizontal,
  Plus,
  Search,
  Trash2,
  Upload,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

import { WorkspaceLoadingScreen } from './WorkspaceLoadingScreen';
import { ApiError } from '../api/_client';
import { listCanvases, exportCanvas } from '../api/canvas';
import { Button } from '../components/Common/Button';
import {
  DropdownMenu,
  DropdownMenuItem,
} from '../components/Common/DropdownMenu';
import { EmptyState } from '../components/Common/EmptyState';
import { Loading } from '../components/Common/Loading';
import { TabGroup } from '../components/Common/TabGroup';
import { TextInput } from '../components/Common/TextInput';
import { toast } from '../components/Common/Toast';
import { Tooltip } from '../components/Common/Tooltip';
import { Header } from '../components/Panels/Header/Header';
import { SpaceDeletionDialog } from '../components/Space/SpaceDeletionDialog';
import { SpaceOrganizationPopover } from '../components/Space/SpaceOrganizationPopover';
import { useSpaceParentMove } from '../components/Space/useSpaceParentMove';
import { APP_NAME } from '../config/app';
import { useCanvasActions } from '../hooks/useCanvasActions';
import {
  getElectronBridge,
  isElectron,
  requireDesktopTabSuccess,
} from '../hooks/useElectron';
import { i18n as translations } from '../i18n';
import { useWorkspaceLabel, useWorkspaceStore } from '../store/workspaceStore';
import { spaceAncestorIds } from '../utils/spaceHierarchy';

import type { CanvasSummary } from '@huabu/shared';
import type { DesktopTabsSnapshot } from '@huabu/shared/desktop-tabs';

/**
 * Home page that shows all canvases in the workspace.
 * Users can create a new canvas or click one to open it.
 */
export default function CanvasListPage() {
  const { t, i18n } = useTranslation();
  const { move, busy: moving, canMove } = useSpaceParentMove();
  const [canvases, setCanvases] = useState<CanvasSummary[]>([]);
  const [listedWorkspaceId, setListedWorkspaceId] = useState<string | null>(
    null,
  );
  const [desktopWorkspaceId, setDesktopWorkspaceId] = useState<string | null>(
    null,
  );
  const [isLoading, setIsLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [menuSpaceId, setMenuSpaceId] = useState<string | null>(null);
  const menuRef = useRef<HTMLButtonElement>(null);
  const [movingSpace, setMovingSpace] = useState<{
    canvasId: string;
    reference: HTMLElement | null;
  } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{
    canvasId: string;
    title: string | null;
  } | null>(null);
  const [showAll, setShowAll] = useState(
    () => localStorage.getItem('huabu.spaces.showAll') === 'true',
  );
  const byId = Object.fromEntries(
    canvases.map((canvas) => [canvas.canvasId, canvas]),
  );
  const query = search.trim().toLocaleLowerCase();
  const pathLabel = (canvasId: string) =>
    spaceAncestorIds(canvasId, byId)
      .map((id) => byId[id]?.title || t('canvasList.untitled'))
      .join(' / ');
  const [exportingId, setExportingId] = useState<string | null>(null);
  const listRequestRef = useRef({ version: 0 });
  const {
    create: handleCreate,
    isCreating,
    openImportDialog: handleImportClick,
    isImporting,
    fileInputRef,
    onFileChange: handleFileChange,
  } = useCanvasActions();
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const workspaceLabel = useWorkspaceLabel();
  const canChangeWorkspace = useWorkspaceStore(
    (s) => s.capabilities?.canChangeWorkspace ?? true,
  );
  const namedWorkspaces = useWorkspaceStore(
    (s) => s.capabilities?.namedWorkspaces === true,
  );
  const setCanvasCount = useWorkspaceStore((s) => s.setCanvasCount);
  const setSpaceTitle = useWorkspaceStore((s) => s.setSpaceTitle);
  const workspaceSyncing = useWorkspaceStore((s) => s.isSyncing);
  const workspaceId = useWorkspaceStore((s) => s.workspaceId);
  useEffect(() => {
    setMenuSpaceId(null);
    setMovingSpace(null);
  }, [workspaceId]);
  const isElectronApp = isElectron() && !getElectronBridge()?.tabs;
  const isDesktopHome = getElectronBridge()?.tabs?.context.role === 'home';

  const fetchCanvases = useCallback(
    async (showLoading = true) => {
      const workspace = useWorkspaceStore.getState();
      if (workspace.isSyncing) return;
      const requestId = ++listRequestRef.current.version;
      const isCurrent = () => {
        const current = useWorkspaceStore.getState();
        return (
          requestId === listRequestRef.current.version &&
          !current.isSyncing &&
          current.workspaceId === workspace.workspaceId &&
          current.workspacePath === workspace.workspacePath
        );
      };
      try {
        if (showLoading) setIsLoading(true);
        const response = await listCanvases();
        if (!isCurrent()) return;
        setCanvases(response.canvases);
        setListedWorkspaceId(workspace.workspaceId);
        setCanvasCount(response.canvases.length);
      } catch (error) {
        if (isCurrent()) {
          console.error('Failed to list canvases:', error);
          toast(
            error instanceof Error
              ? error.message
              : translations.t('spaceHierarchy.failed'),
            { tone: 'danger' },
          );
        }
      } finally {
        if (isCurrent()) setIsLoading(false);
      }
    },
    [setCanvasCount],
  );

  useEffect(() => {
    const requests = listRequestRef.current;
    void fetchCanvases();
    return () => {
      requests.version++;
    };
  }, [fetchCanvases]);

  // Re-fetch when workspace changes
  useEffect(() => {
    const handler = () => void fetchCanvases();
    const refresh = () => void fetchCanvases(false);
    window.addEventListener('workspace-changed', handler);
    window.addEventListener('canvas-list-changed', refresh);
    return () => {
      window.removeEventListener('workspace-changed', handler);
      window.removeEventListener('canvas-list-changed', refresh);
    };
  }, [fetchCanvases]);

  useEffect(() => {
    const tabs = getElectronBridge()?.tabs;
    if (!tabs || tabs.context.role !== 'home') return;
    let active = true;
    let live = true;
    let received = false;
    let previousId: string | undefined;
    const update = (state: DesktopTabsSnapshot) => {
      setDesktopWorkspaceId(state.busy ? null : state.workspaceId);
      if (state.activeId !== previousId) setSearch('');
      previousId = state.activeId;
      const nextActive =
        (state.activeId === 'home' || state.activeId === 'new-tab') &&
        !state.busy;
      if (nextActive && !active) void fetchCanvases(false);
      active = nextActive;
    };
    const unsubscribe = tabs.onState((state) => {
      received = true;
      update(state);
    });
    void tabs
      .getState()
      .then((state) => {
        if (live && !received) update(state);
      })
      .catch((error: unknown) => {
        if (!live) return;
        console.error('[desktop-tabs] Could not read Home state:', error);
        toast(error instanceof Error ? error.message : String(error), {
          tone: 'danger',
        });
      });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [fetchCanvases]);

  useEffect(() => {
    const tabs = getElectronBridge()?.tabs;
    if (
      !tabs ||
      tabs.context.role !== 'home' ||
      workspaceSyncing ||
      !listedWorkspaceId ||
      listedWorkspaceId !== desktopWorkspaceId ||
      listedWorkspaceId !== useWorkspaceStore.getState().workspaceId
    )
      return;
    let live = true;
    void tabs
      .command({
        type: 'sync-space-titles',
        workspaceId: listedWorkspaceId,
        titles: Object.fromEntries(
          canvases.map((canvas) => [canvas.canvasId, canvas.title ?? '']),
        ),
      })
      .then(requireDesktopTabSuccess)
      .catch((error: unknown) => {
        if (!live) return;
        console.error(
          '[desktop-tabs] Could not synchronize Space titles:',
          error,
        );
        toast(error instanceof Error ? error.message : String(error), {
          tone: 'danger',
        });
      });
    return () => {
      live = false;
    };
  }, [canvases, listedWorkspaceId, desktopWorkspaceId, workspaceSyncing]);

  const handleExport = async (canvasId: string) => {
    setExportingId(canvasId);
    try {
      await exportCanvas(canvasId);
      toast(t('canvasList.exportStarted'), { tone: 'success' });
    } catch (error) {
      toast(
        error instanceof ApiError &&
          error.code === 'STORAGE_CAPABILITY_UNAVAILABLE'
          ? t('canvasList.exportUnavailable')
          : error instanceof Error
            ? error.message
            : t('canvasList.exportFailed'),
        {
          tone: 'danger',
        },
      );
    } finally {
      setExportingId(null);
    }
  };

  const reportDeleteError = (error: unknown) => {
    console.error('Failed to delete canvas:', error);
    toast(error instanceof Error ? error.message : String(error), {
      tone: 'danger',
    });
  };

  const canDeleteSpace = async (canvasId: string): Promise<boolean> => {
    const tabs = getElectronBridge()?.tabs;
    if (!tabs) return true;
    const state = await tabs.getState();
    if (!state.tabs.some((tab) => tab.canvasId === canvasId)) return true;
    toast(t('desktopTabs.closeBeforeDeleting'), { tone: 'warning' });
    return false;
  };

  const requestDelete = async (canvasId: string, title: string | null) => {
    try {
      if (await canDeleteSpace(canvasId)) setPendingDelete({ canvasId, title });
    } catch (error) {
      reportDeleteError(error);
    }
  };

  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleDateString(i18n.language, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };
  const visibleCanvases = canvases.filter((canvas) =>
    query
      ? (canvas.title || t('canvasList.untitled'))
          .toLocaleLowerCase()
          .includes(query)
      : showAll || !canvas.parentSpaceId,
  );

  const workspaceName = (
    <>
      <span>
        {workspacePath
          ? t('workspace.pathPrefix')
          : namedWorkspaces
            ? t('workspace.namedPrefix')
            : t('workspace.workspacePrefix')}
        {workspaceLabel}
      </span>
    </>
  );
  const workspaceSwitcher =
    !isDesktopHome && workspaceLabel ? (
      <Tooltip
        content={
          <div className="text-center">
            <div>
              {workspacePath
                ? t('workspace.path', { path: workspacePath })
                : namedWorkspaces
                  ? t('workspace.named', { workspace: workspaceLabel })
                  : t('workspace.workspace', { workspace: workspaceLabel })}
            </div>
            <div>{t('canvasList.canvasCount', { count: canvases.length })}</div>
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
            className="text-fg-subtle hover:text-fg-default mt-0.5 ml-1 truncate text-xs transition-colors"
          >
            {workspaceName}
          </Link>
        ) : (
          <span className="text-fg-subtle mt-0.5 ml-1 cursor-default truncate text-xs">
            {workspaceName}
          </span>
        )}
      </Tooltip>
    ) : null;

  if (isDesktopHome && workspaceSyncing) return <WorkspaceLoadingScreen />;

  return (
    <div className="bg-bg-default flex h-full flex-col">
      {movingSpace && (
        <SpaceOrganizationPopover
          key={`${workspaceId}:${movingSpace.canvasId}`}
          canvasId={movingSpace.canvasId}
          reference={movingSpace.reference}
          onClose={() => setMovingSpace(null)}
        />
      )}
      {pendingDelete && (
        <SpaceDeletionDialog
          canvasId={pendingDelete.canvasId}
          onClose={() => {
            setPendingDelete(null);
            void fetchCanvases();
          }}
          onDeleted={(ids, failure) => {
            listRequestRef.current.version++;
            setCanvases((current) => {
              const remaining = current.filter(
                (canvas) => !ids.includes(canvas.canvasId),
              );
              setCanvasCount(remaining.length);
              return remaining;
            });
            if (!failure) setPendingDelete(null);
            void fetchCanvases(false);
          }}
        />
      )}

      {/* Hidden file input for import */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".zip,application/zip"
        className="hidden"
        onChange={(e) => void handleFileChange(e)}
      />

      {!isElectronApp && !isDesktopHome && (
        <Header>
          <h1 className="text-fg-default -ml-1 text-lg font-semibold">
            {APP_NAME}
          </h1>
          {workspaceSwitcher}
        </Header>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <main className="mx-auto w-full max-w-7xl px-6 py-8 sm:px-8">
          <div className="mb-8 flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
            <div>
              {isDesktopHome ? (
                <h1 className="text-fg-default text-3xl font-semibold tracking-tight">
                  {t('canvasList.title')}
                </h1>
              ) : (
                <h2 className="text-fg-default text-3xl font-semibold tracking-tight">
                  {t('canvasList.title')}
                </h2>
              )}
              <p className="text-fg-muted mt-1 text-sm">
                {t('canvasList.subtitle')}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <div className="relative w-full sm:w-64">
                <Search
                  aria-hidden
                  className="text-fg-subtle pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2"
                />
                <TextInput
                  type="search"
                  size="md"
                  className="h-9 w-full pl-9"
                  aria-label={t('spaceHierarchy.search')}
                  placeholder={t('spaceHierarchy.searchPlaceholder')}
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </div>
              <Button
                variant="outline"
                tone="neutral"
                className="h-9 shrink-0"
                onClick={handleImportClick}
                disabled={isImporting}
              >
                {isImporting ? (
                  <Loading
                    layout="inline"
                    size="sm"
                    className="text-fg-subtle"
                  />
                ) : (
                  <Upload />
                )}
                {t('actions.importCanvas')}
              </Button>
              <Button
                variant="solid"
                className="h-9 shrink-0"
                onClick={handleCreate}
                disabled={isCreating}
              >
                {isCreating ? (
                  <Loading
                    layout="inline"
                    size="sm"
                    className="text-fg-inverse"
                  />
                ) : (
                  <Plus />
                )}
                {t('actions.newCanvas')}
              </Button>
            </div>
          </div>

          <div className="mb-6 flex items-center">
            <TabGroup
              size="sm"
              aria-label={t('canvasList.title')}
              className="bg-hover [&_[aria-selected=true]]:bg-surface [&_[aria-selected=true]]:ring-edge-default [&_[aria-selected=true]:enabled:hover]:bg-surface gap-0 rounded-lg p-0.5 [&_[aria-selected=true]]:shadow-sm [&_[aria-selected=true]]:ring-1"
              value={showAll ? 'all' : 'topLevel'}
              options={[
                { value: 'topLevel', label: t('spaceHierarchy.topLevel') },
                { value: 'all', label: t('spaceHierarchy.all') },
              ]}
              onChange={(value) => {
                const all = value === 'all';
                setShowAll(all);
                localStorage.setItem('huabu.spaces.showAll', String(all));
              }}
            />
          </div>

          {isLoading ? (
            <Loading
              variant="spinner"
              layout="block"
              size="md"
              message={t('canvasList.loading')}
              className="py-20"
              indicatorClassName="text-fg-subtle"
            />
          ) : canvases.length === 0 ? (
            <EmptyState
              message={t('canvasList.empty')}
              className="border-edge-default rounded-xl border-2 border-dashed"
              action={
                <Button
                  variant="ghost"
                  tone="neutral"
                  onClick={handleCreate}
                  disabled={isCreating}
                  className="text-fg-default hover:text-fg-muted text-sm font-medium underline"
                >
                  {t('canvasList.createFirst')}
                </Button>
              }
            />
          ) : visibleCanvases.length === 0 ? (
            <EmptyState message={t('desktopTabs.noMatchingSpaces')} />
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {visibleCanvases.map((canvas) => (
                <div
                  key={canvas.canvasId}
                  className="group border-edge-default bg-surface hover:border-edge-default relative flex flex-col rounded-xl border p-5 text-left transition-all hover:shadow-md"
                >
                  <Link
                    to={`/canvas/${canvas.canvasId}`}
                    onClick={() =>
                      setSpaceTitle(
                        canvas.canvasId,
                        canvas.title || t('canvasList.untitled'),
                      )
                    }
                    className="flex flex-1 flex-col text-left"
                  >
                    <h3 className="text-fg-default group-hover:text-fg-default truncate pr-7 text-sm font-semibold">
                      {canvas.title || t('canvasList.untitled')}
                    </h3>
                    {canvas.parentSpaceId && (
                      <p
                        title={pathLabel(canvas.canvasId)}
                        className="text-fg-subtle truncate text-xs"
                      >
                        {pathLabel(canvas.parentSpaceId)} /
                      </p>
                    )}
                    <p className="text-fg-subtle mt-1 text-xs">
                      {t('canvasList.nodeCount', {
                        count: canvas.nodeCount,
                      })}
                    </p>
                    <div className="text-fg-subtle mt-auto pt-4 text-xs">
                      {t('canvasList.updated', {
                        date: formatDate(canvas.updatedAt),
                      })}
                    </div>
                  </Link>
                  <DropdownMenu
                    open={menuSpaceId === canvas.canvasId}
                    onOpenChange={(open) => {
                      setMenuSpaceId(open ? canvas.canvasId : null);
                      if (open && !canMove(canvas.canvasId))
                        void useWorkspaceStore.getState().refreshSpaceTitles();
                    }}
                    triggerWrapperClassName="absolute top-3 right-3"
                    align="bottom-right"
                    trigger={
                      <Button
                        ref={
                          menuSpaceId === canvas.canvasId ? menuRef : undefined
                        }
                        variant="ghost"
                        iconOnly
                        aria-label={t('canvasList.spaceActions', {
                          name: canvas.title || t('canvasList.untitled'),
                        })}
                      >
                        <MoreHorizontal className="text-fg-subtle" />
                      </Button>
                    }
                  >
                    <DropdownMenuItem
                      icon={<FolderInput />}
                      disabled={moving || !canMove(canvas.canvasId)}
                      onClick={() => {
                        setMenuSpaceId(null);
                        setMovingSpace({
                          canvasId: canvas.canvasId,
                          reference: menuRef.current,
                        });
                      }}
                    >
                      {t('spaceHierarchy.move')}
                    </DropdownMenuItem>
                    {canvas.parentSpaceId && (
                      <DropdownMenuItem
                        icon={<FolderUp />}
                        disabled={moving || !canMove(canvas.canvasId)}
                        onClick={() => {
                          setMenuSpaceId(null);
                          void move(
                            canvas.canvasId,
                            null,
                            canvas.parentSpaceId ?? null,
                          );
                        }}
                      >
                        {t('spaceHierarchy.moveToTopLevel')}
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem
                      icon={<Download />}
                      disabled={exportingId === canvas.canvasId}
                      onClick={() => {
                        setMenuSpaceId(null);
                        void handleExport(canvas.canvasId);
                      }}
                    >
                      {t(
                        exportingId === canvas.canvasId
                          ? 'canvasList.exporting'
                          : 'canvasList.exportCanvas',
                      )}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      icon={<Trash2 />}
                      onClick={() => {
                        setMenuSpaceId(null);
                        void requestDelete(canvas.canvasId, canvas.title);
                      }}
                    >
                      {t('canvasList.deleteCanvas')}
                    </DropdownMenuItem>
                  </DropdownMenu>
                </div>
              ))}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
