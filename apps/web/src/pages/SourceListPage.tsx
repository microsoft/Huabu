import {
  FileText,
  Globe,
  FileImage,
  StickyNote,
  Trash2,
  Trash,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import {
  getSources,
  deleteSource,
  deleteUnusedSources,
} from '../api/knowledge';
import { Button } from '../components/Common/Button';
import { EmptyState } from '../components/Common/EmptyState';
import { LoadingState } from '../components/Common/LoadingState';
import { Modal } from '../components/Common/Modal';
import { Spinner } from '../components/Common/Spinner';
import { toast } from '../components/Common/Toast';
import { Header } from '../components/Panels/Header/Header';
import { useWorkspaceStore } from '../store/workspaceStore';

import type { SourceOverview, SourceType } from '@sediment/shared';

const sourceTypeIcon: Record<SourceType, React.ReactNode> = {
  pdf: <FileText className="text-fg-subtle h-5 w-5" />,
  web: <Globe className="text-fg-subtle h-5 w-5" />,
  note: <StickyNote className="text-fg-subtle h-5 w-5" />,
  text: <FileImage className="text-fg-subtle h-5 w-5" />,
};

const sourceTypeLabel: Record<SourceType, string> = {
  pdf: 'PDF',
  web: 'Web',
  note: 'Note',
  text: 'Text',
};

/**
 * Page that shows all source files in the workspace.
 * Users can delete individual sources or purge all unused sources at once.
 */
export default function SourceListPage() {
  const [sources, setSources] = useState<SourceOverview[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [pendingDelete, setPendingDelete] = useState<{
    sourceId: string;
    title: string | null;
  } | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [pendingPurge, setPendingPurge] = useState(false);
  const [isPurging, setIsPurging] = useState(false);
  const confirmDeleteButtonRef = useRef<HTMLButtonElement>(null);
  const confirmPurgeButtonRef = useRef<HTMLButtonElement>(null);
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);

  const fetchSources = useCallback(async () => {
    try {
      setIsLoading(true);
      const data = await getSources();
      setSources(data);
    } catch (error) {
      console.error('Failed to list sources:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchSources();
  }, [fetchSources]);

  // Re-fetch when workspace changes
  useEffect(() => {
    const handler = () => void fetchSources();
    window.addEventListener('workspace-changed', handler);
    return () => window.removeEventListener('workspace-changed', handler);
  }, [fetchSources]);

  const requestDelete = (sourceId: string, title: string | null) => {
    setPendingDelete({ sourceId, title });
  };

  const closeDeleteModal = () => {
    if (isDeleting) return;
    setPendingDelete(null);
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;

    try {
      setIsDeleting(true);
      await deleteSource(pendingDelete.sourceId);
      setSources((prev) =>
        prev.filter((s) => s.sourceId !== pendingDelete.sourceId),
      );
      setPendingDelete(null);
      toast('Source deleted', { variant: 'success' });
    } catch (error) {
      console.error('Failed to delete source:', error);
      toast('Failed to delete source', { variant: 'error' });
    } finally {
      setIsDeleting(false);
    }
  };

  const closePurgeModal = () => {
    if (isPurging) return;
    setPendingPurge(false);
  };

  const confirmPurge = async () => {
    try {
      setIsPurging(true);
      const result = await deleteUnusedSources();
      toast(
        result.deleted > 0
          ? `Deleted ${result.deleted} unused source${result.deleted !== 1 ? 's' : ''}`
          : 'No unused sources found',
        { variant: result.deleted > 0 ? 'success' : 'info' },
      );
      // Re-fetch to reflect changes
      await fetchSources();
      setPendingPurge(false);
    } catch (error) {
      console.error('Failed to delete unused sources:', error);
      toast('Failed to delete unused sources', { variant: 'error' });
    } finally {
      setIsPurging(false);
    }
  };

  return (
    <div className="bg-bg-default flex h-screen flex-col">
      {/* Delete single source modal */}
      <Modal
        isOpen={pendingDelete !== null}
        title="Delete source?"
        description={
          pendingDelete ? (
            <>
              Are you sure you want to delete{' '}
              <span className="text-fg-default font-medium">
                &quot;{pendingDelete.title || pendingDelete.sourceId}&quot;
              </span>
              ? The associated artifact files will also be removed. This action
              cannot be undone.
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
              variant="outline"
              tone="neutral"
              size="sm"
              onClick={closeDeleteModal}
              disabled={isDeleting}
            >
              Cancel
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
                <Spinner size="sm" className="text-fg-inverse" />
              ) : (
                'Delete'
              )}
            </Button>
          </>
        }
      />

      {/* Purge unused sources modal */}
      <Modal
        isOpen={pendingPurge}
        title="Delete unused sources?"
        description="This will permanently delete all sources that are not referenced by any canvas, along with their artifact files. This action cannot be undone."
        onClose={closePurgeModal}
        initialFocusRef={confirmPurgeButtonRef}
        closeOnBackdropClick={!isPurging}
        closeOnEscape={!isPurging}
        footer={
          <>
            <Button
              variant="outline"
              tone="neutral"
              size="sm"
              onClick={closePurgeModal}
              disabled={isPurging}
            >
              Cancel
            </Button>
            <Button
              ref={confirmPurgeButtonRef}
              variant="solid"
              tone="danger"
              size="sm"
              onClick={() => void confirmPurge()}
              disabled={isPurging}
            >
              {isPurging ? (
                <Spinner size="sm" className="text-fg-inverse" />
              ) : (
                'Delete All Unused'
              )}
            </Button>
          </>
        }
      />

      {/* Header */}
      <Header>
        <h1 className="text-fg-default px-1 text-lg font-semibold">Sediment</h1>
        {workspacePath && (
          <span
            className="text-fg-subtle mt-0.5 ml-1 truncate text-xs"
            title={workspacePath}
          >
            {workspacePath.split(/[\\/]/).filter(Boolean).pop()}
          </span>
        )}
      </Header>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <main className="mx-auto w-full max-w-4xl px-6 py-10">
          <div className="mb-8 flex items-center justify-between">
            <div>
              <div className="flex items-baseline gap-2">
                <h2 className="text-fg-default text-2xl font-bold">Sources</h2>
                <span className="text-fg-subtle text-sm">/</span>
                <Link
                  to="/"
                  className="text-fg-subtle hover:text-fg-default text-sm font-medium"
                >
                  Canvases
                </Link>
              </div>
              <p className="text-fg-subtle mt-1 text-sm">
                Manage knowledge sources in this workspace.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                tone="danger"
                onClick={() => setPendingPurge(true)}
                disabled={sources.length === 0}
              >
                <Trash />
                Delete Unused
              </Button>
            </div>
          </div>

          {isLoading ? (
            <LoadingState message="Loading sources…" className="py-20" />
          ) : sources.length === 0 ? (
            <EmptyState
              message="No sources yet."
              className="border-edge-default rounded-xl border-2 border-dashed"
            />
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {sources.map((source) => (
                <div
                  key={source.sourceId}
                  className="group border-edge-default bg-surface hover:border-edge-default relative flex flex-col rounded-xl border p-5 text-left transition-all hover:shadow-md"
                >
                  <div className="flex flex-1 flex-col">
                    <div className="mb-2 flex items-center gap-2">
                      {sourceTypeIcon[source.type]}
                      <span className="text-fg-subtle text-xs font-medium uppercase">
                        {sourceTypeLabel[source.type]}
                      </span>
                    </div>
                    <h3 className="text-fg-default truncate text-sm font-semibold">
                      {source.title || 'Untitled'}
                    </h3>
                    {source.src && (
                      <p
                        className="text-fg-subtle mt-1 truncate text-xs"
                        title={source.src}
                      >
                        {source.src}
                      </p>
                    )}
                  </div>
                  {/* Delete button */}
                  <Button
                    variant="ghost"
                    iconOnly
                    onClick={(e) => {
                      e.stopPropagation();
                      requestDelete(source.sourceId, source.title);
                    }}
                    tooltipWrapperClassName="absolute top-3 right-3 inline-flex opacity-0 transition-opacity group-hover:opacity-100"
                    title="Delete source"
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
