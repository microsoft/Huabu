import {
  Bot,
  Check,
  ChevronDown,
  ClipboardCopy,
  FolderOpen,
  History,
  Key,
  LogIn,
  LogOut,
  Settings,
  X,
} from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import { pickFolder } from '../../api/workspace';
import useCanvasStore from '../../store/canvasStore';
import { useLLMStore } from '../../store/llmStore';
import { useWorkspaceStore } from '../../store/workspaceStore';
import { Button } from '../Common/Button';
import { IconButton } from '../Common/IconButton';
import { Popover } from '../Common/Popover';

/** Popover width in px (w-80 = 20rem = 320px). */
const POPOVER_WIDTH = 320;

/**
 * A minimal settings popover that lets the user view and change
 * the server-side workspace directory path via native folder picker.
 */
export const SettingsPopover: React.FC = () => {
  const loadCanvas = useCanvasStore((s) => s.loadCanvas);
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const selectWorkspace = useWorkspaceStore((s) => s.selectWorkspace);
  const recentWorkspaces = useWorkspaceStore((s) => s.recentWorkspaces);
  const removeRecentWorkspace = useWorkspaceStore(
    (s) => s.removeRecentWorkspace,
  );

  // LLM store
  const llmConfig = useLLMStore((s) => s.config);
  const llmProviders = useLLMStore((s) => s.providers);
  const llmModels = useLLMStore((s) => s.models);
  const llmSaving = useLLMStore((s) => s.saving);
  const llmError = useLLMStore((s) => s.error);
  const llmInit = useLLMStore((s) => s.init);
  const llmLoadModels = useLLMStore((s) => s.loadModels);
  const llmUpdateConfig = useLLMStore((s) => s.updateConfig);

  // OAuth store
  const oauthPending = useLLMStore((s) => s.oauthPending);
  const oauthUserCode = useLLMStore((s) => s.oauthUserCode);
  const oauthVerificationUri = useLLMStore((s) => s.oauthVerificationUri);
  const startOAuth = useLLMStore((s) => s.startOAuth);
  const cancelOAuth = useLLMStore((s) => s.cancelOAuth);
  const llmLogoutOAuth = useLLMStore((s) => s.logoutOAuth);

  const [isOpen, setIsOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [isPicking, setIsPicking] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  // LLM UI state
  const [showApiKeyInput, setShowApiKeyInput] = useState(false);
  const [apiKeyValue, setApiKeyValue] = useState('');
  const [llmSuccess, setLlmSuccess] = useState(false);
  const llmSuccessRef = useRef<number | null>(null);

  const triggerRef = useRef<HTMLDivElement>(null);
  const successTimeoutRef = useRef<number | null>(null);

  // Prevents Popover's outside-click dismiss from immediately re-opening
  // when the trigger button is clicked while the popover is open.
  const justDismissedRef = useRef(false);

  const handleClose = useCallback(() => {
    setIsOpen(false);
    setError('');
    setSuccess(false);
    if (successTimeoutRef.current !== null) {
      clearTimeout(successTimeoutRef.current);
      successTimeoutRef.current = null;
    }
  }, []);

  const handleDismiss = useCallback(() => {
    justDismissedRef.current = true;
    handleClose();
    requestAnimationFrame(() => {
      justDismissedRef.current = false;
    });
  }, [handleClose]);

  const handleToggle = useCallback(() => {
    if (justDismissedRef.current) return;
    setIsOpen((prev) => {
      const next = !prev;
      if (next) void llmInit();
      return next;
    });
  }, [llmInit]);

  // Clear any pending success timeout on unmount
  useEffect(() => {
    return () => {
      if (successTimeoutRef.current !== null) {
        clearTimeout(successTimeoutRef.current);
        successTimeoutRef.current = null;
      }
      if (llmSuccessRef.current !== null) {
        clearTimeout(llmSuccessRef.current);
        llmSuccessRef.current = null;
      }
    };
  }, []);

  const handlePickFolder = async () => {
    setIsPicking(true);
    setError('');
    setSuccess(false);

    try {
      const result = await pickFolder();
      if (result.cancelled || !result.path) {
        setIsPicking(false);
        return;
      }

      setSaving(true);
      setIsPicking(false);

      await selectWorkspace(result.path);
      setSuccess(true);

      if (successTimeoutRef.current !== null) {
        clearTimeout(successTimeoutRef.current);
      }
      successTimeoutRef.current = window.setTimeout(() => {
        setSuccess(false);
        successTimeoutRef.current = null;
      }, 2000);

      // Reload canvas and notify other panels about workspace change
      await loadCanvas();
      window.dispatchEvent(new Event('workspace-changed'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to change folder');
    } finally {
      setSaving(false);
      setIsPicking(false);
    }
  };

  const handleSelectRecent = async (path: string) => {
    setError('');
    setSuccess(false);
    setSaving(true);

    try {
      await selectWorkspace(path);
      setSuccess(true);

      if (successTimeoutRef.current !== null) {
        clearTimeout(successTimeoutRef.current);
      }
      successTimeoutRef.current = window.setTimeout(() => {
        setSuccess(false);
        successTimeoutRef.current = null;
      }, 2000);

      await loadCanvas();
      window.dispatchEvent(new Event('workspace-changed'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to open workspace');
    } finally {
      setSaving(false);
    }
  };

  // LLM handlers
  const handleProviderChange = async (
    e: React.ChangeEvent<HTMLSelectElement>,
  ) => {
    const providerId = e.target.value;
    await llmLoadModels(providerId);
    setShowApiKeyInput(false);
    setApiKeyValue('');
  };

  const handleModelChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const modelId = e.target.value;
    const selectedProvider =
      document.querySelector<HTMLSelectElement>('#llm-provider-select')
        ?.value ??
      llmConfig?.provider ??
      '';

    await llmUpdateConfig({ provider: selectedProvider, model: modelId });
    flashLlmSuccess();
  };

  const handleSaveApiKey = async () => {
    if (!apiKeyValue.trim()) return;
    const provider = llmConfig?.provider ?? '';
    const model = llmConfig?.model ?? llmModels[0]?.id ?? '';
    await llmUpdateConfig({ provider, model, apiKey: apiKeyValue.trim() });
    setApiKeyValue('');
    setShowApiKeyInput(false);
    flashLlmSuccess();
  };

  const flashLlmSuccess = () => {
    setLlmSuccess(true);
    if (llmSuccessRef.current !== null) clearTimeout(llmSuccessRef.current);
    llmSuccessRef.current = window.setTimeout(() => {
      setLlmSuccess(false);
      llmSuccessRef.current = null;
    }, 2000);
  };

  const getPopoverPosition = () => {
    if (!triggerRef.current) return { x: 0, y: 0 };
    const rect = triggerRef.current.getBoundingClientRect();
    return {
      x: rect.right - POPOVER_WIDTH,
      y: rect.bottom,
    };
  };

  const isLoading = saving || isPicking;

  return (
    <>
      <div ref={triggerRef}>
        <IconButton
          variant="outline"
          title="Settings"
          onClick={handleToggle}
          aria-label="Open settings"
        >
          <Settings size={18} />
        </IconButton>
      </div>

      {isOpen && (
        <Popover
          position={getPopoverPosition()}
          onDismiss={handleDismiss}
          offset={{ x: 0, y: 6 }}
          className="w-80 p-4"
        >
          <h3 className="mb-3 text-sm font-semibold text-gray-800">
            Workspace Settings
          </h3>

          <label className="mb-1.5 block text-xs font-medium text-gray-600">
            <FolderOpen size={12} className="mr-1 inline" />
            Workspace Folder
          </label>

          {/* Current path display */}
          <div className="border-border mb-2 flex items-center gap-2 rounded border bg-gray-50 px-2.5 py-2">
            <span className="flex-1 truncate text-sm text-gray-700">
              {workspacePath || 'Not configured'}
            </span>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void handlePickFolder()}
              disabled={isLoading}
            >
              {isPicking ? 'Waiting…' : 'Change'}
            </Button>
          </div>

          {error && <p className="mb-2 text-xs text-red-500">{error}</p>}
          {success && (
            <p className="mb-2 text-xs text-green-600">Workspace changed!</p>
          )}

          <p className="mb-3 text-[11px] leading-relaxed text-gray-400">
            The folder where canvas, sources, and artifacts are stored. Changes
            take effect immediately.
          </p>

          {/* Recent workspaces */}
          {recentWorkspaces.filter((p) => p !== workspacePath).length > 0 && (
            <div className="mb-3">
              <div className="mb-1.5 flex items-center gap-1 text-[11px] font-medium text-gray-400">
                <History size={10} />
                <span>Recent</span>
              </div>
              <ul className="space-y-0.5">
                {recentWorkspaces
                  .filter((p) => p !== workspacePath)
                  .map((path) => (
                    <li key={path} className="group flex items-center gap-0.5">
                      <Button
                        variant="ghost"
                        onClick={() => void handleSelectRecent(path)}
                        disabled={isLoading}
                        className="flex-1 gap-1.5 text-left"
                      >
                        <FolderOpen
                          size={12}
                          className="shrink-0 text-gray-300"
                        />
                        <span className="truncate text-xs text-gray-500">
                          {path}
                        </span>
                      </Button>
                      <IconButton
                        onClick={() => removeRecentWorkspace(path)}
                        className="shrink-0 p-0.5 text-gray-300 opacity-0 transition-all group-hover:opacity-100 hover:text-gray-500"
                        title="Remove from recent"
                      >
                        <X size={12} />
                      </IconButton>
                    </li>
                  ))}
              </ul>
            </div>
          )}

          {/* ── LLM Provider / Model ── */}
          <div className="border-border mb-3 border-t pt-3">
            <label className="mb-1.5 block text-xs font-medium text-gray-600">
              <Bot size={12} className="mr-1 inline" />
              LLM Provider
            </label>

            {/* Provider select */}
            <div className="relative mb-2">
              <select
                id="llm-provider-select"
                className="border-border w-full appearance-none rounded border bg-gray-50 py-1.5 pr-8 pl-2.5 text-sm text-gray-700 focus:ring-1 focus:ring-blue-300 focus:outline-none"
                value={llmConfig?.provider ?? ''}
                onChange={(e) => void handleProviderChange(e)}
                disabled={llmSaving}
              >
                {!llmConfig?.provider && (
                  <option value="" disabled>
                    Select provider…
                  </option>
                )}
                {llmProviders.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <ChevronDown
                size={14}
                className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-gray-400"
              />
            </div>

            {/* Model select */}
            {llmModels.length > 0 && (
              <>
                <label className="mb-1.5 block text-xs font-medium text-gray-600">
                  Model
                </label>
                <div className="relative mb-2">
                  <select
                    className="border-border w-full appearance-none rounded border bg-gray-50 py-1.5 pr-8 pl-2.5 text-sm text-gray-700 focus:ring-1 focus:ring-blue-300 focus:outline-none"
                    value={llmConfig?.model ?? ''}
                    onChange={(e) => void handleModelChange(e)}
                    disabled={llmSaving}
                  >
                    {llmModels.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name || m.id}
                      </option>
                    ))}
                  </select>
                  <ChevronDown
                    size={14}
                    className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-gray-400"
                  />
                </div>
              </>
            )}

            {/* Auth status — varies by provider auth type */}
            {llmConfig &&
              (() => {
                const selectedProvider = llmProviders.find(
                  (p) => p.id === llmConfig.provider,
                );
                const isOAuth = selectedProvider?.authType === 'oauth';

                if (isOAuth) {
                  return (
                    <>
                      {/* OAuth device code flow */}
                      {oauthPending && oauthUserCode ? (
                        <div className="mb-2 rounded border border-blue-200 bg-blue-50 p-2.5">
                          <p className="mb-1.5 text-xs text-blue-700">
                            Enter this code at the opened page:
                          </p>
                          <div className="mb-1.5 flex items-center gap-2">
                            <code className="rounded bg-white px-2 py-1 font-mono text-lg font-bold text-blue-900">
                              {oauthUserCode}
                            </code>
                            <IconButton
                              title="Copy code"
                              onClick={() =>
                                void navigator.clipboard.writeText(
                                  oauthUserCode,
                                )
                              }
                              className="text-blue-500 hover:text-blue-700"
                            >
                              <ClipboardCopy size={14} />
                            </IconButton>
                          </div>
                          {oauthVerificationUri && (
                            <p className="mb-1.5 text-[11px] text-blue-600">
                              Or visit:{' '}
                              <a
                                href={oauthVerificationUri}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="underline"
                              >
                                {oauthVerificationUri}
                              </a>
                            </p>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-[11px] text-blue-600"
                            onClick={cancelOAuth}
                          >
                            Cancel
                          </Button>
                        </div>
                      ) : (
                        <div className="mb-2 flex items-center gap-1.5 text-xs">
                          {llmConfig.authenticated ? (
                            <>
                              <Check size={12} className="text-green-500" />
                              <span className="text-green-600">
                                Authenticated via GitHub
                              </span>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="ml-auto text-[11px]"
                                onClick={() => void llmLogoutOAuth()}
                              >
                                <LogOut size={11} className="mr-0.5" />
                                Logout
                              </Button>
                            </>
                          ) : (
                            <>
                              <Key size={12} className="text-amber-500" />
                              <span className="text-amber-600">
                                Login required
                              </span>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="ml-auto text-[11px]"
                                onClick={() => void startOAuth()}
                                disabled={oauthPending}
                              >
                                <LogIn size={11} className="mr-0.5" />
                                Login with GitHub
                              </Button>
                            </>
                          )}
                        </div>
                      )}
                    </>
                  );
                }

                // Standard API key auth
                return (
                  <>
                    <div className="mb-2 flex items-center gap-1.5 text-xs">
                      {llmConfig.authenticated ? (
                        <>
                          <Check size={12} className="text-green-500" />
                          <span className="text-green-600">Authenticated</span>
                        </>
                      ) : (
                        <>
                          <Key size={12} className="text-amber-500" />
                          <span className="text-amber-600">
                            API key required
                          </span>
                        </>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="ml-auto text-[11px]"
                        onClick={() => setShowApiKeyInput(!showApiKeyInput)}
                      >
                        {showApiKeyInput ? 'Cancel' : 'Set API Key'}
                      </Button>
                    </div>

                    {/* API key input */}
                    {showApiKeyInput && (
                      <div className="mb-2 flex gap-1.5">
                        <input
                          type="password"
                          placeholder="sk-…"
                          value={apiKeyValue}
                          onChange={(e) => setApiKeyValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void handleSaveApiKey();
                          }}
                          className="border-border flex-1 rounded border bg-white px-2 py-1.5 text-xs text-gray-700 focus:ring-1 focus:ring-blue-300 focus:outline-none"
                          autoFocus
                        />
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => void handleSaveApiKey()}
                          disabled={!apiKeyValue.trim() || llmSaving}
                        >
                          Save
                        </Button>
                      </div>
                    )}
                  </>
                );
              })()}

            {llmError && (
              <p className="mb-2 text-xs text-red-500">{llmError}</p>
            )}
            {llmSuccess && (
              <p className="mb-2 text-xs text-green-600">LLM config updated!</p>
            )}
          </div>

          <div className="flex justify-end">
            <Button variant="secondary" size="sm" onClick={handleClose}>
              Close
            </Button>
          </div>
        </Popover>
      )}
    </>
  );
};
