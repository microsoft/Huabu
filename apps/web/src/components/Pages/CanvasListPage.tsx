import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { listCanvases, createCanvas } from '../../api/canvas';
import { useWorkspaceStore } from '../../store/workspaceStore';
import { SettingsPopover } from '../Panels/SettingsPopover';

import type { CanvasSummary } from '@sediment/shared';

/**
 * Home page that shows all canvases in the workspace.
 * Users can create a new canvas or click one to open it.
 */
export default function CanvasListPage() {
  const [canvases, setCanvases] = useState<CanvasSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
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
      {/* Header */}
      <header className="border-border flex h-14 items-center border-b bg-white px-6">
        <img src="/favicon.svg" alt="Logo" className="mr-3 h-8 w-8" />
        <h1 className="text-lg font-semibold text-gray-900">Sediment</h1>
        {workspacePath && (
          <span className="ml-3 max-w-xs truncate text-xs text-gray-400">
            {workspacePath}
          </span>
        )}
        <div className="flex-1" />
        <SettingsPopover />
      </header>

      {/* Content */}
      <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-10">
        <div className="mb-8 flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold text-gray-900">Canvases</h2>
            <p className="mt-1 text-sm text-gray-500">
              Select a canvas to open, or create a new one.
            </p>
          </div>
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
              <button
                key={canvas.canvasId}
                onClick={() => handleOpen(canvas.canvasId)}
                className="group flex flex-col rounded-xl border border-gray-200 bg-white p-5 text-left transition-all hover:border-gray-300 hover:shadow-md"
              >
                <h3 className="truncate text-sm font-semibold text-gray-900 group-hover:text-black">
                  {canvas.title || canvas.canvasId}
                </h3>
                <p className="mt-1 text-xs text-gray-400">
                  {canvas.nodeCount} node{canvas.nodeCount !== 1 ? 's' : ''}
                </p>
                <div className="mt-auto pt-4 text-xs text-gray-400">
                  Updated {formatDate(canvas.updatedAt)}
                </div>
              </button>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
