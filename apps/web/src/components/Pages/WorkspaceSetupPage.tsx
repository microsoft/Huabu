import { FolderOpen, History, X } from 'lucide-react';
import { useState } from 'react';

import { pickFolder } from '../../api/workspace';
import { useWorkspaceStore } from '../../store/workspaceStore';

/**
 * First-launch page shown when no workspace folder has been configured.
 * Lets the user pick a folder via native OS dialog or select a recent workspace.
 */
export default function WorkspaceSetupPage() {
  const selectWorkspace = useWorkspaceStore((s) => s.selectWorkspace);
  const isSyncing = useWorkspaceStore((s) => s.isSyncing);
  const recentWorkspaces = useWorkspaceStore((s) => s.recentWorkspaces);
  const removeRecentWorkspace = useWorkspaceStore(
    (s) => s.removeRecentWorkspace,
  );

  const [isPicking, setIsPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handlePickFolder = async () => {
    setIsPicking(true);
    setError(null);
    try {
      const result = await pickFolder();
      if (result.cancelled || !result.path) {
        setIsPicking(false);
        return;
      }
      await selectWorkspace(result.path);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to pick folder');
      setIsPicking(false);
    }
  };

  const handleSelectRecent = async (path: string) => {
    setError(null);
    try {
      await selectWorkspace(path);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to open workspace');
    }
  };

  const isLoading = isPicking || isSyncing;

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <div className="w-full max-w-md px-6">
        {/* Logo + Title */}
        <div className="mb-10 text-center">
          <img
            src="/favicon.svg"
            alt="Sediment"
            className="mx-auto mb-4 h-16 w-16"
          />
          <h1 className="text-2xl font-bold text-gray-900">
            Welcome to Sediment
          </h1>
          <p className="mt-2 text-sm text-gray-500">
            Choose a folder to store your canvases, notes, and artifacts.
          </p>
        </div>

        {/* Main action: folder picker */}
        <button
          onClick={() => void handlePickFolder()}
          disabled={isLoading}
          className="flex w-full items-center justify-center gap-3 rounded-xl border-2 border-dashed border-gray-300 bg-white px-6 py-8 text-gray-700 transition-all hover:border-gray-400 hover:bg-gray-50 disabled:opacity-50"
        >
          {isLoading ? (
            <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-gray-400 border-t-transparent" />
          ) : (
            <FolderOpen size={24} className="text-gray-400" />
          )}
          <span className="text-sm font-medium">
            {isPicking ? 'Waiting for selection…' : 'Select Folder'}
          </span>
        </button>

        {/* Recent workspaces */}
        {recentWorkspaces.length > 0 && (
          <div className="mt-6">
            <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-gray-400">
              <History size={12} />
              <span>Recent Workspaces</span>
            </div>
            <ul className="space-y-1">
              {recentWorkspaces.map((path) => (
                <li key={path} className="group flex items-center gap-1">
                  <button
                    onClick={() => void handleSelectRecent(path)}
                    disabled={isLoading}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors hover:bg-gray-100 disabled:opacity-50"
                  >
                    <FolderOpen size={14} className="shrink-0 text-gray-300" />
                    <span className="truncate text-sm text-gray-600">
                      {path}
                    </span>
                  </button>
                  <button
                    onClick={() => removeRecentWorkspace(path)}
                    className="shrink-0 rounded p-1 text-gray-300 opacity-0 transition-all group-hover:opacity-100 hover:bg-gray-100 hover:text-gray-500"
                    title="Remove from recent"
                  >
                    <X size={14} />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Error */}
        {error && (
          <p className="mt-3 text-center text-xs text-red-500">{error}</p>
        )}

        {/* Hint */}
        <p className="mt-8 text-center text-[11px] leading-relaxed text-gray-400">
          This folder will contain your canvas files, knowledge sources, and
          artifacts. You can change it later in Settings.
        </p>
      </div>
    </div>
  );
}
