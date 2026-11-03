// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Check, FolderOpen, Layers, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useNavigate } from 'react-router-dom';

import { WorkspaceLoadingScreen } from './WorkspaceLoadingScreen';
import { Button } from '../components/Common/Button';
import { PathInput } from '../components/Common/PathInput';
import { TextInput } from '../components/Common/TextInput';
import { toast } from '../components/Common/Toast';
import { APP_NAME } from '../config/app';
import { useWorkspaceStore } from '../store/workspaceStore';

import type { WorkspaceDescriptor } from '../api/workspace';

/**
 * First-launch / "switch workspace" page.
 *
 * Only meaningful in free mode. In managed mode the workspace is locked
 * at the server, so we redirect home (no UI to render).
 *
 * The free-mode UI always exposes a manual absolute-path input so a
 * remote/headless server still works. When the server reports a native
 * picker is available (`capabilities.nativePicker`) an extra folder
 * button sits beside the input — the same input-plus-picker layout used
 * by the external-agent settings form.
 */
export default function WorkspaceSetupPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const mode = useWorkspaceStore((s) => s.mode);
  const isSyncing = useWorkspaceStore((s) => s.isSyncing);
  const recentWorkspaces = useWorkspaceStore((s) => s.recentWorkspaces);
  const removeRecentWorkspace = useWorkspaceStore(
    (s) => s.removeRecentWorkspace,
  );
  const activateRecentWorkspace = useWorkspaceStore(
    (s) => s.activateRecentWorkspace,
  );
  const selectWorkspace = useWorkspaceStore((s) => s.selectWorkspace);
  const createWorkspace = useWorkspaceStore((s) => s.createWorkspace);
  const named = useWorkspaceStore(
    (s) => s.capabilities?.namedWorkspaces === true,
  );
  const storeError = useWorkspaceStore((s) => s.error);

  // Managed mode: workspace is locked by the server, nothing to choose.
  if (mode === 'managed') {
    return <Navigate to="/" replace />;
  }

  if (isSyncing) {
    return <WorkspaceLoadingScreen />;
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
            {t('workspace.welcome', { appName: APP_NAME })}
          </h1>
          <p className="text-fg-subtle mt-2 text-sm">
            {t(named ? 'workspace.introNamed' : 'workspace.intro')}
          </p>
        </div>

        {named ? (
          <NamedSetup
            isSyncing={isSyncing}
            workspaces={recentWorkspaces}
            activateWorkspace={activateRecentWorkspace}
            createWorkspace={createWorkspace}
            onActivated={() => navigate('/', { replace: true })}
          />
        ) : (
          <FreeSetup
            isSyncing={isSyncing}
            storeError={storeError}
            recentWorkspaces={recentWorkspaces}
            activateRecentWorkspace={activateRecentWorkspace}
            removeRecentWorkspace={removeRecentWorkspace}
            selectWorkspace={selectWorkspace}
            onActivated={() => navigate('/', { replace: true })}
          />
        )}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Named Workspaces: each signed-in person's own, chosen and created by name
// ──────────────────────────────────────────────────────────────────────

interface NamedSetupProps {
  isSyncing: boolean;
  workspaces: WorkspaceDescriptor[];
  activateWorkspace: (workspaceId: string) => Promise<void>;
  createWorkspace: (name: string) => Promise<void>;
  onActivated: () => void;
}

function NamedSetup({
  isSyncing,
  workspaces,
  activateWorkspace,
  createWorkspace,
  onActivated,
}: NamedSetupProps) {
  const { t } = useTranslation();
  const [name, setName] = useState('');

  const run = async (action: () => Promise<void>) => {
    try {
      await action();
      onActivated();
    } catch (error) {
      console.error('[workspace-setup] Could not open Workspace:', error);
      toast(useWorkspaceStore.getState().error ?? t('workspace.switchFailed'), {
        tone: 'danger',
      });
    }
  };

  const create = () => {
    const trimmed = name.trim();
    if (trimmed) void run(() => createWorkspace(trimmed));
  };

  return (
    <>
      {workspaces.length > 0 && (
        <div className="mb-6">
          <div className="text-fg-subtle mb-2 text-xs font-medium">
            {t('workspace.yourWorkspaces')}
          </div>
          <ul className="space-y-1">
            {workspaces.map((workspace) => (
              <li key={workspace.workspaceId}>
                <Button
                  variant="ghost"
                  tone="neutral"
                  size="sm"
                  onClick={() =>
                    void run(() => activateWorkspace(workspace.workspaceId))
                  }
                  disabled={isSyncing}
                  className="w-full justify-start rounded-lg text-left"
                >
                  <Layers size={14} className="text-fg-subtle shrink-0" />
                  <span className="text-fg-muted min-w-0 flex-1 truncate text-sm">
                    {workspace.name}
                  </span>
                  {workspace.active && (
                    <span className="text-fg-subtle flex shrink-0 items-center gap-1 text-xs">
                      <Check size={12} />
                      {t('workspace.current')}
                    </span>
                  )}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <label
        htmlFor="new-workspace-name"
        className="text-fg-subtle mb-1.5 block text-xs font-medium"
      >
        {t('workspace.newWorkspace')}
      </label>
      <div className="flex gap-2">
        <TextInput
          id="new-workspace-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') create();
          }}
          placeholder={t('workspace.namePlaceholder')}
          disabled={isSyncing}
          className="min-w-0 flex-1"
        />
        <Button onClick={create} disabled={isSyncing || !name.trim()}>
          {t('workspace.create')}
        </Button>
      </div>
    </>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Free-mode UI
// ──────────────────────────────────────────────────────────────────────

interface FreeSetupProps {
  isSyncing: boolean;
  storeError: string | null;
  recentWorkspaces: WorkspaceDescriptor[];
  activateRecentWorkspace: (workspaceId: string) => Promise<void>;
  removeRecentWorkspace: (workspaceId: string) => void;
  selectWorkspace: (path: string) => Promise<void>;
  onActivated: () => void;
}

function FreeSetup({
  isSyncing,
  storeError,
  recentWorkspaces,
  activateRecentWorkspace,
  removeRecentWorkspace,
  selectWorkspace,
  onActivated,
}: FreeSetupProps) {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const [pathInput, setPathInput] = useState('');

  const isLoading = isSyncing;

  const reportError = (error: unknown) => {
    console.error('[workspace-setup] Could not open Workspace:', error);
    toast(useWorkspaceStore.getState().error ?? t('workspace.switchFailed'), {
      tone: 'danger',
    });
  };

  /** Activate a path (typed, picked or recent) and navigate on success. */
  const activate = async (path: string) => {
    const p = path.trim();
    if (!p) return;
    setError(null);
    try {
      await selectWorkspace(p);
      onActivated();
    } catch (error) {
      reportError(error);
    }
  };

  const handleSubmitPath = async () => {
    void activate(pathInput);
  };

  const handleSelectRecent = async (workspaceId: string) => {
    setError(null);
    try {
      await activateRecentWorkspace(workspaceId);
      onActivated();
    } catch (error) {
      reportError(error);
    }
  };

  return (
    <>
      {/* Path input + optional native folder picker */}
      <label className="text-fg-subtle mb-1.5 block text-xs font-medium">
        {t('workspace.folder')}
      </label>
      <PathInput
        value={pathInput}
        onChange={setPathInput}
        onPicked={(path) => void activate(path)}
        onError={setError}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void handleSubmitPath();
        }}
        placeholder={t('workspace.pathPlaceholder')}
        disabled={isLoading}
        className="gap-2"
      />

      {/* Recent workspaces */}
      {recentWorkspaces.length > 0 && (
        <div className="mt-6">
          <div className="text-fg-subtle mb-2 flex items-center gap-1.5 text-xs font-medium">
            <span>{t('workspace.recent')}</span>
          </div>
          <ul className="space-y-1">
            {recentWorkspaces.map((workspace) => (
              <li
                key={workspace.workspaceId}
                className="group flex items-center gap-1"
              >
                <Button
                  variant="ghost"
                  tone="neutral"
                  size="sm"
                  onClick={() => void handleSelectRecent(workspace.workspaceId)}
                  disabled={isLoading}
                  className="min-w-0 flex-1 justify-start rounded-lg text-left"
                >
                  <FolderOpen size={14} className="text-fg-subtle shrink-0" />
                  <span className="text-fg-muted truncate text-sm">
                    {workspace.path ?? workspace.name}
                  </span>
                </Button>
                {!workspace.active && (
                  <Button
                    variant="ghost"
                    iconOnly
                    size="sm"
                    onClick={() => removeRecentWorkspace(workspace.workspaceId)}
                    className="opacity-0 transition-all group-hover:opacity-100"
                    title={t('workspace.removeRecent')}
                  >
                    <X size={14} />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {(error ?? storeError) && (
        <p
          className="text-danger-fg mt-3 text-center text-xs"
          role="alert"
          aria-live="assertive"
        >
          {error ?? storeError}
        </p>
      )}
    </>
  );
}
