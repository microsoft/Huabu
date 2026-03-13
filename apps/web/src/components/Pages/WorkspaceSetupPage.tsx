import { FolderOpen } from 'lucide-react';
import { useState } from 'react';

import { pickFolder } from '../../api/workspace';
import { useWorkspaceStore } from '../../store/workspaceStore';

/**
 * First-launch page shown when no workspace folder has been configured.
 * Lets the user pick a folder via native OS dialog.
 */
export default function WorkspaceSetupPage() {
  const selectWorkspace = useWorkspaceStore((s) => s.selectWorkspace);
  const isSyncing = useWorkspaceStore((s) => s.isSyncing);

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
