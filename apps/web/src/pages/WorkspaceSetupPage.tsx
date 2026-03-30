import { FolderOpen, History, X } from 'lucide-react';
import { useState } from 'react';

import { pickFolder } from '../api/workspace';
import { Button } from '../components/Common/Button';
import { Spinner } from '../components/Common/Spinner';
import { useWorkspaceStore } from '../store/workspaceStore';

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
    <div className="bg-bg-default flex min-h-screen items-center justify-center">
      <div className="w-full max-w-md px-6">
        {/* Logo + Title */}
        <div className="mb-10 text-center">
          <img
            src="/favicon.svg"
            alt="Sediment"
            className="mx-auto mb-4 h-16 w-16"
          />
          <h1 className="text-fg-default text-2xl font-bold">
            Welcome to Sediment
          </h1>
          <p className="text-fg-subtle mt-2 text-sm">
            Choose a folder to store your canvases, notes, and artifacts.
          </p>
        </div>

        {/* Main action: folder picker */}
        <Button
          variant="outline"
          tone="neutral"
          onClick={() => void handlePickFolder()}
          disabled={isLoading}
          className="w-full rounded-xl border-2 border-dashed px-6 py-8"
        >
          {isLoading ? (
            <Spinner size="sm" className="text-fg-subtle" />
          ) : (
            <FolderOpen size={24} className="text-fg-subtle" />
          )}
          <span className="text-sm font-medium">
            {isPicking ? 'Waiting for selection…' : 'Select Folder'}
          </span>
        </Button>

        {/* Recent workspaces */}
        {recentWorkspaces.length > 0 && (
          <div className="mt-6">
            <div className="text-fg-subtle mb-2 flex items-center gap-1.5 text-xs font-medium">
              <History size={12} />
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
                    <span className="text-fg-muted truncate text-sm">
                      {path}
                    </span>
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

        {/* Error */}
        {error && (
          <p className="text-danger mt-3 text-center text-xs">{error}</p>
        )}

        {/* Hint */}
        <p className="text-fg-subtle mt-8 text-center text-[11px] leading-relaxed">
          This folder will contain your canvas files, knowledge sources, and
          artifacts. You can change it later in Settings.
        </p>
      </div>
    </div>
  );
}
