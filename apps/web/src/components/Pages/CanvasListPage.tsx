import { Download, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import {
  listCanvases,
  createCanvas,
  exportCanvas,
  importCanvas,
  deleteCanvasById,
} from '../../api/canvas';
import { useWorkspaceStore } from '../../store/workspaceStore';
import { Button } from '../Common/Button';
import { GhostButton } from '../Common/GhostButton';
import { Modal } from '../Common/Modal';
import { Header } from '../Panels/Header';

import type { CanvasExportBundle, CanvasSummary } from '@sediment/shared';

/**
 * Home page that shows all canvases in the workspace.
 * Users can create a new canvas or click one to open it.
 */
export default function CanvasListPage() {
  const [canvases, setCanvases] = useState<CanvasSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<{
    canvasId: string;
    title: string | null;
  } | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const confirmDeleteButtonRef = useRef<HTMLButtonElement>(null);
  const navigate = useNavigate();
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);

  const fetchCanvases = useCallback(async () => {
    try {
      setIsLoading(true);
      const response = await listCanvases();
      setCanvases(response.canvases);
    } catch (error) {
      console.error('Failed to list canvases:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchCanvases();
  }, [fetchCanvases]);

  // Re-fetch when workspace changes
  useEffect(() => {
    const handler = () => void fetchCanvases();
    window.addEventListener('workspace-changed', handler);
    return () => window.removeEventListener('workspace-changed', handler);
  }, [fetchCanvases]);

  const handleCreate = async () => {
    try {
      setIsCreating(true);
      const response = await createCanvas();
      navigate(`/canvas/${response.canvasId}`);
    } catch (error) {
      console.error('Failed to create canvas:', error);
    } finally {
      setIsCreating(false);
    }
  };

  const handleOpen = (canvasId: string) => {
    navigate(`/canvas/${canvasId}`);
  };

  const handleExport = async (canvasId: string, title: string | null) => {
    try {
      const blob = await exportCanvas(canvasId);
      const safeName =
        (title ?? canvasId).replace(/[^a-z0-9_-]/gi, '_') || canvasId;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${safeName}.sediment.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Failed to export canvas:', error);
    }
  };

  const handleImportClick = () => {
    fileInputRef.current?.click();
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
      setCanvases((prev) =>
        prev.filter((c) => c.canvasId !== pendingDelete.canvasId),
      );
      setPendingDelete(null);
    } catch (error) {
      console.error('Failed to delete canvas:', error);
    } finally {
      setIsDeleting(false);
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Reset so the same file can be re-selected if needed
    e.target.value = '';

    setIsImporting(true);

    try {
      const text = await file.text();
      const bundle = JSON.parse(text) as CanvasExportBundle;
      const result = await importCanvas(bundle);
      // Navigate to the newly created canvas
      navigate(`/canvas/${result.canvasId}`);
    } catch (err) {
      console.error('Failed to import canvas:', err);
    } finally {
      setIsImporting(false);
    }
  };

  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <div className="flex min-h-screen flex-col bg-gray-50">
      <Modal
        isOpen={pendingDelete !== null}
        title="Delete canvas?"
        description={
          pendingDelete ? (
            <>
              Are you sure you want to delete{' '}
              <span className="text-main font-medium">
                “{pendingDelete.title || pendingDelete.canvasId}”
              </span>
              ? This action cannot be undone.
            </>
          ) : null
        }
        onClose={closeDeleteModal}
        initialFocusRef={confirmDeleteButtonRef}
        closeOnBackdropClick={!isDeleting}
        closeOnEscape={!isDeleting}
        footer={
          <>
            <Button
              variant="secondary"
              size="md"
              onClick={closeDeleteModal}
              disabled={isDeleting}
            >
              Cancel
            </Button>
            <Button
              ref={confirmDeleteButtonRef}
              variant="danger"
              size="md"
              onClick={() => void confirmDelete()}
              disabled={isDeleting}
            >
              {isDeleting ? (
                <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
              ) : (
                'Delete'
              )}
            </Button>
          </>
        }
      />

      {/* Hidden file input for import */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={(e) => void handleFileChange(e)}
      />

      {/* Header */}
      <Header>
        <h1 className="px-1 text-lg font-semibold text-gray-900">Sediment</h1>
        {workspacePath && (
          <span
            className="mt-0.5 ml-1 truncate text-xs text-gray-400"
            title={workspacePath}
          >
            {workspacePath.split(/[\\/]/).filter(Boolean).pop()}
          </span>
        )}
      </Header>

      {/* Content */}
      <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-10">
        <div className="mb-8 flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold text-gray-900">Canvases</h2>
            <p className="mt-1 text-sm text-gray-500">
              Select a canvas to open, or create a new one.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleImportClick}
              disabled={isImporting}
              className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50"
            >
              {isImporting ? (
                <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-gray-500 border-t-transparent" />
              ) : (
                <svg
                  className="h-4 w-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={2}
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5"
                  />
                </svg>
              )}
              Import
            </button>
            <button
              onClick={handleCreate}
              disabled={isCreating}
              className="inline-flex items-center gap-2 rounded-lg bg-gray-900 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-gray-800 disabled:opacity-50"
            >
              {isCreating ? (
                <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
              ) : (
                <svg
                  className="h-4 w-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={2}
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M12 4.5v15m7.5-7.5h-15"
                  />
                </svg>
              )}
              New Canvas
            </button>
          </div>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-20">
            <div className="text-sm text-gray-400">Loading canvases…</div>
          </div>
        ) : canvases.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-gray-200 py-20">
            <p className="text-sm text-gray-400">No canvases yet.</p>
            <button
              onClick={handleCreate}
              disabled={isCreating}
              className="mt-4 text-sm font-medium text-gray-900 underline hover:text-gray-700"
            >
              Create your first canvas
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {canvases.map((canvas) => (
              <div
                key={canvas.canvasId}
                className="group relative flex flex-col rounded-xl border border-gray-200 bg-white p-5 text-left transition-all hover:border-gray-300 hover:shadow-md"
              >
                <button
                  onClick={() => handleOpen(canvas.canvasId)}
                  className="flex flex-1 flex-col text-left"
                >
                  <h3 className="truncate text-sm font-semibold text-gray-900 group-hover:text-black">
                    {canvas.title || 'Untitled'}
                  </h3>
                  <p className="mt-1 text-xs text-gray-400">
                    {canvas.nodeCount} node
                    {canvas.nodeCount !== 1 ? 's' : ''}
                  </p>
                  <div className="mt-auto pt-4 text-xs text-gray-400">
                    Updated {formatDate(canvas.updatedAt)}
                  </div>
                </button>
                {/* Export button */}
                <GhostButton
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleExport(canvas.canvasId, canvas.title);
                  }}
                  tooltipWrapperClassName="absolute top-3 right-10 inline-flex opacity-0 transition-opacity group-hover:opacity-100"
                  title="Export canvas"
                >
                  <Download size={16} className="text-gray-400" />
                </GhostButton>
                {/* Delete button */}
                <GhostButton
                  onClick={(e) => {
                    e.stopPropagation();
                    requestDelete(canvas.canvasId, canvas.title);
                  }}
                  tooltipWrapperClassName="absolute top-3 right-3 inline-flex opacity-0 transition-opacity group-hover:opacity-100"
                  title="Delete canvas"
                >
                  <Trash2 size={16} className="text-gray-400" />
                </GhostButton>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
