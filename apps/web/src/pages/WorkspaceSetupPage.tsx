import { FolderOpen, X } from 'lucide-react';
import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';

import { pickFolder } from '../api/workspace';
import { Button } from '../components/Common/Button';
import { Spinner } from '../components/Common/Spinner';
import { APP_NAME } from '../config/app';
import { useWorkspaceStore } from '../store/workspaceStore';

/**
 * First-launch / "switch workspace" page.
 *
 * Only meaningful in free mode. In managed mode the workspace is locked
 * at the server, so we redirect home (no UI to render).
 *
 * Renders one of two free-mode variants based on server capabilities:
 *   - native picker available → folder picker button + recents
 *   - headless server (no GUI) → manual absolute-path input + recents
 */
export default function WorkspaceSetupPage() {
  const navigate = useNavigate();
  const mode = useWorkspaceStore((s) => s.mode);
  const capabilities = useWorkspaceStore((s) => s.capabilities);
  const isSyncing = useWorkspaceStore((s) => s.isSyncing);
  const recentWorkspaces = useWorkspaceStore((s) => s.recentWorkspaces);
  const removeRecentWorkspace = useWorkspaceStore(
    (s) => s.removeRecentWorkspace,
  );
  const selectWorkspace = useWorkspaceStore((s) => s.selectWorkspace);
  const storeError = useWorkspaceStore((s) => s.error);

  // Managed mode: workspace is locked by the server, nothing to choose.
  if (mode === 'managed') {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="bg-bg-default flex min-h-full items-center justify-center">
      <div className="w-full max-w-md px-6">
        {/* Logo + Title */}
        <div className="mb-10 text-center">
          <img
            src="/favicon.svg"
            alt={APP_NAME}
            className="mx-auto mb-4 h-16 w-16"
          />
          <h1 className="text-fg-default text-2xl font-bold">
            Welcome to {APP_NAME}
          </h1>
          <p className="text-fg-subtle mt-2 text-sm">
            Choose a folder to store your canvases, notes, and artifacts.
          </p>
        </div>

        <FreeSetup
          // While the first GET /workspace is in flight `capabilities` is null;
          // assume native picker is available so the UI doesn't flash a
          // less-capable variant unnecessarily.
          nativePicker={capabilities?.nativePicker ?? true}
          isSyncing={isSyncing}
          recentWorkspaces={recentWorkspaces}
          removeRecentWorkspace={removeRecentWorkspace}
          selectWorkspace={selectWorkspace}
          onActivated={() => navigate('/', { replace: true })}
        />

        {storeError && (
          <p className="text-danger mt-3 text-center text-xs">{storeError}</p>
        )}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Free-mode UI
// ──────────────────────────────────────────────────────────────────────

interface FreeSetupProps {
  nativePicker: boolean;
  isSyncing: boolean;
  recentWorkspaces: string[];
  removeRecentWorkspace: (path: string) => void;
  selectWorkspace: (path: string) => Promise<void>;
  onActivated: () => void;
}

function FreeSetup({
  nativePicker,
  isSyncing,
  recentWorkspaces,
  removeRecentWorkspace,
  selectWorkspace,
  onActivated,
}: FreeSetupProps) {
  const [isPicking, setIsPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showInput, setShowInput] = useState(!nativePicker);
  const [pathInput, setPathInput] = useState('');

  const isLoading = isPicking || isSyncing;

  const handlePickFolder = async () => {
    setIsPicking(true);
    setError(null);
    try {
      const result = await pickFolder();
      if (!result.ok) {
        if (result.reason === 'no-picker') {
          // Server has no GUI — fall back to manual input.
          setShowInput(true);
        }
        setIsPicking(false);
        return;
      }
      await selectWorkspace(result.path);
      onActivated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to pick folder');
      setIsPicking(false);
    }
  };

  const handleSubmitPath = async () => {
    const p = pathInput.trim();
    if (!p) return;
    setError(null);
    try {
      await selectWorkspace(p);
      onActivated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to open path');
    }
  };

  const handleSelectRecent = async (path: string) => {
    setError(null);
    try {
      await selectWorkspace(path);
      onActivated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to open workspace');
    }
  };

  return (
    <>
      {/* Folder picker (when supported) */}
      {nativePicker && !showInput && (
        <Button
          variant="outline"
          tone="neutral"
          onClick={() => void handlePickFolder()}
          disabled={isLoading}
          className="w-full justify-center rounded-lg py-2.5"
        >
          {isPicking ? (
            <Spinner size="sm" className="text-fg-subtle" />
          ) : (
            <FolderOpen size={18} className="text-fg-subtle" />
          )}
          <span className="text-fg-default text-sm font-medium">
            {isPicking ? 'Waiting for selection…' : 'Select Folder'}
          </span>
        </Button>
      )}

      {/* Manual path input (headless server fallback) */}
      {showInput && (
        <div>
          <label className="text-fg-subtle mb-1.5 block text-xs font-medium">
            Absolute path
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleSubmitPath();
              }}
              placeholder="/var/lib/sediment/workspace"
              disabled={isLoading}
              className="border-edge-default bg-surface text-fg-default placeholder:text-fg-subtle focus:border-edge-strong min-w-0 flex-1 rounded border px-2.5 py-1.5 text-sm focus:outline-none"
            />
            <Button
              variant="solid"
              tone="info"
              onClick={() => void handleSubmitPath()}
              disabled={isLoading || !pathInput.trim()}
            >
              Open
            </Button>
          </div>
          {nativePicker && (
            <Button
              variant="ghost"
              tone="neutral"
              size="sm"
              onClick={() => setShowInput(false)}
              className="mt-2 px-0 underline"
            >
              ← back to folder picker
            </Button>
          )}
        </div>
      )}

      {/* Recent workspaces */}
      {recentWorkspaces.length > 0 && (
        <div className="mt-6">
          <div className="text-fg-subtle mb-2 flex items-center gap-1.5 text-xs font-medium">
            <span>Recent Workspaces</span>
          </div>
          <ul className="space-y-1">
            {recentWorkspaces.map((path) => (
              <li key={path} className="group flex items-center gap-1">
                <Button
                  variant="ghost"
                  tone="neutral"
                  size="sm"
                  onClick={() => void handleSelectRecent(path)}
                  disabled={isLoading}
                  className="min-w-0 flex-1 justify-start rounded-lg text-left"
                >
                  <FolderOpen size={14} className="text-fg-subtle shrink-0" />
                  <span className="text-fg-muted truncate text-sm">{path}</span>
                </Button>
                <Button
                  variant="ghost"
                  iconOnly
                  size="sm"
                  onClick={() => removeRecentWorkspace(path)}
                  className="opacity-0 transition-all group-hover:opacity-100"
                  title="Remove from recent"
                >
                  <X size={14} />
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {error && <p className="text-danger mt-3 text-center text-xs">{error}</p>}
    </>
  );
}
