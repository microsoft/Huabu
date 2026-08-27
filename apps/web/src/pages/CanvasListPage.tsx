// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Download, Plus, Trash2, Upload } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { useNavigate, Link } from 'react-router-dom';

import { listCanvases, exportCanvas, deleteCanvasById } from '../api/canvas';
import { Button } from '../components/Common/Button';
import { EmptyState } from '../components/Common/EmptyState';
import { Loading } from '../components/Common/Loading';
import { Modal } from '../components/Common/Modal';
import { toast } from '../components/Common/Toast';
import { Tooltip } from '../components/Common/Tooltip';
import { Header } from '../components/Panels/Header/Header';
import { APP_NAME } from '../config/app';
import { useCanvasActions } from '../hooks/useCanvasActions';
import { isElectron } from '../hooks/useElectron';
import { deleteWorkspace } from '../store/previewWorkspace/persistence';
import { useWorkspaceLabel, useWorkspaceStore } from '../store/workspaceStore';

import type { CanvasSummary } from '@huabu/shared';

/**
 * Home page that shows all canvases in the workspace.
 * Users can create a new canvas or click one to open it.
 */
export default function CanvasListPage() {
  const { t, i18n } = useTranslation();
  const [canvases, setCanvases] = useState<CanvasSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [pendingDelete, setPendingDelete] = useState<{
    canvasId: string;
    title: string | null;
  } | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [exportingId, setExportingId] = useState<string | null>(null);
  const confirmDeleteButtonRef = useRef<HTMLButtonElement>(null);
  const navigate = useNavigate();
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
  const setCanvasCount = useWorkspaceStore((s) => s.setCanvasCount);
  const isElectronApp = isElectron();

  const fetchCanvases = useCallback(async () => {
    try {
      setIsLoading(true);
      const response = await listCanvases();
      setCanvases(response.canvases);
      setCanvasCount(response.canvases.length);
    } catch (error) {
      console.error('Failed to list canvases:', error);
    } finally {
      setIsLoading(false);
    }
  }, [setCanvasCount]);

  useEffect(() => {
    void fetchCanvases();
  }, [fetchCanvases]);

  // Re-fetch when workspace changes
  useEffect(() => {
    const handler = () => void fetchCanvases();
    window.addEventListener('workspace-changed', handler);
    return () => window.removeEventListener('workspace-changed', handler);
  }, [fetchCanvases]);

  const handleOpen = (canvasId: string) => {
    navigate(`/canvas/${canvasId}`);
  };

  const handleExport = async (canvasId: string) => {
    setExportingId(canvasId);
    try {
      await exportCanvas(canvasId);
      toast(t('canvasList.exportStarted'), { tone: 'success' });
    } catch (error) {
      toast(
        error instanceof Error ? error.message : t('canvasList.exportFailed'),
        {
          tone: 'danger',
        },
      );
    } finally {
      setExportingId(null);
    }
  };

  const requestDelete = (canvasId: string, title: string | null) => {
    setPendingDelete({ canvasId, title });
  };

  const closeDeleteModal = () => {
    if (isDeleting) return;
    setPendingDelete(null);
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;

    try {
      setIsDeleting(true);
      await deleteCanvasById(pendingDelete.canvasId);
      deleteWorkspace(pendingDelete.canvasId);
      setCanvases((prev) => {
        const next = prev.filter((c) => c.canvasId !== pendingDelete.canvasId);
        setCanvasCount(next.length);
        return next;
      });
      setPendingDelete(null);
    } catch (error) {
      console.error('Failed to delete canvas:', error);
    } finally {
      setIsDeleting(false);
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

  return (
    <div className="bg-bg-default flex h-full flex-col">
      <Modal
        isOpen={pendingDelete !== null}
        title={t('canvasList.deleteTitle')}
        description={
          pendingDelete ? (
            <Trans
              i18nKey="canvasList.deleteDescriptionRich"
              values={{
                title: pendingDelete.title || pendingDelete.canvasId,
              }}
              components={{
                name: (
                  // The Trans component injects the translated title here.
                  <span className="text-fg-default font-medium" />
                ),
              }}
            />
          ) : null
        }
        onClose={closeDeleteModal}
        initialFocusRef={confirmDeleteButtonRef}
        closeOnBackdropClick={!isDeleting}
        closeOnEscape={!isDeleting}
        footer={
          <>
            <Button
              variant="outline"
              tone="neutral"
              size="sm"
              onClick={closeDeleteModal}
              disabled={isDeleting}
            >
              {t('actions.cancel')}
            </Button>
            <Button
              ref={confirmDeleteButtonRef}
              variant="solid"
              tone="danger"
              size="sm"
              onClick={() => void confirmDelete()}
              disabled={isDeleting}
            >
              {isDeleting ? (
                <Loading
                  layout="inline"
                  size="sm"
                  className="text-fg-inverse"
                />
              ) : (
                t('actions.delete')
              )}
            </Button>
          </>
        }
      />

      {/* Hidden file input for import */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".zip,application/zip"
        className="hidden"
        onChange={(e) => void handleFileChange(e)}
      />

      {/* Header — hidden in Electron, where WindowChrome already shows the
          workspace folder name + switcher tooltip in the title bar. */}
      {!isElectronApp && (
        <Header>
          <h1 className="text-fg-default -ml-1 text-lg font-semibold">
            {APP_NAME}
          </h1>
          {workspaceLabel && (
            <Tooltip
              content={
                <div className="text-center">
                  <div>
                    {workspacePath
                      ? t('workspace.path', { path: workspacePath })
                      : t('workspace.workspace', { workspace: workspaceLabel })}
                  </div>
                  <div>
                    {t('canvasList.canvasCount', { count: canvases.length })}
                  </div>
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
                  {workspacePath
                    ? t('workspace.pathPrefix')
                    : t('workspace.workspacePrefix')}
                  {workspaceLabel}
                </Link>
              ) : (
                <span className="text-fg-subtle mt-0.5 ml-1 cursor-default truncate text-xs">
                  {workspacePath
                    ? t('workspace.pathPrefix')
                    : t('workspace.workspacePrefix')}
                  {workspaceLabel}
                </span>
              )}
            </Tooltip>
          )}
        </Header>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <main className="mx-auto w-full max-w-4xl px-6 py-10">
          <div className="mb-8 flex items-center justify-between">
            <div>
              <h2 className="text-fg-default text-2xl font-bold">
                {t('canvasList.title')}
              </h2>
              <p className="text-fg-muted mt-1 text-sm">
                {t('canvasList.subtitle')}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                tone="neutral"
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
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {canvases.map((canvas) => (
                <div
                  key={canvas.canvasId}
                  className="group border-edge-default bg-surface hover:border-edge-default relative flex flex-col rounded-xl border p-5 text-left transition-all hover:shadow-md"
                >
                  <button
                    onClick={() => handleOpen(canvas.canvasId)}
                    className="flex flex-1 flex-col text-left"
                  >
                    <h3 className="text-fg-default group-hover:text-fg-default truncate text-sm font-semibold">
                      {canvas.title || t('canvasList.untitled')}
                    </h3>
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
                  </button>
                  {/* Export button */}
                  <Button
                    variant="ghost"
                    iconOnly
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleExport(canvas.canvasId);
                    }}
                    tooltipWrapperClassName="absolute top-3 right-10 inline-flex opacity-0 transition-opacity group-hover:opacity-100"
                    title={
                      exportingId === canvas.canvasId
                        ? t('canvasList.exporting')
                        : t('canvasList.exportCanvas')
                    }
                    disabled={exportingId === canvas.canvasId}
                  >
                    {exportingId === canvas.canvasId ? (
                      <Loading
                        layout="inline"
                        size="sm"
                        className="text-fg-subtle"
                      />
                    ) : (
                      <Download className="text-fg-subtle" />
                    )}
                  </Button>
                  {/* Delete button */}
                  <Button
                    variant="ghost"
                    iconOnly
                    onClick={(e) => {
                      e.stopPropagation();
                      requestDelete(canvas.canvasId, canvas.title);
                    }}
                    tooltipWrapperClassName="absolute top-3 right-3 inline-flex opacity-0 transition-opacity group-hover:opacity-100"
                    title={t('canvasList.deleteCanvas')}
                  >
                    <Trash2 className="text-fg-subtle" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
