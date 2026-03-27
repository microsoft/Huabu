import { FolderOpen, Settings, X } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import { LLMSettings } from './LLMSettings';
import { pickFolder } from '../../api/workspace';
import useCanvasStore from '../../store/canvasStore';
import { useLLMStore } from '../../store/llmStore';
import { useWorkspaceStore } from '../../store/workspaceStore';
import { Button } from '../Common/Button';
import { Popover } from '../Common/Popover';

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

  // LLM store — only used for init on open
  const llmInit = useLLMStore((s) => s.init);

  const [isOpen, setIsOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [isPicking, setIsPicking] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

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

  const getPopoverPosition = () => {
    if (!triggerRef.current) return { x: 0, y: 0 };
    const rect = triggerRef.current.getBoundingClientRect();
    return {
      x: rect.right,
      y: rect.bottom,
    };
  };

  const isLoading = saving || isPicking;

  return (
    <>
      <div ref={triggerRef}>
        <Button
          variant="outline"
          shape="pill"
          iconOnly
          title="Settings"
          onClick={handleToggle}
          aria-label="Open settings"
        >
          <Settings />
        </Button>
      </div>

      {isOpen && (
        <Popover
          position={getPopoverPosition()}
          onDismiss={handleDismiss}
          anchor="top-right"
          offset={{ x: 0, y: 6 }}
          className="w-80 p-4"
        >
          <h3 className="text-fg-default mb-3 text-sm font-semibold">
            Workspace Settings
          </h3>

          <label className="text-fg-muted mb-1.5 block text-xs font-medium"></label>

          {/* Current path display */}
          <div className="border-edge-default bg-surface mb-2 flex items-center gap-2 rounded border px-2.5 py-1">
            <span className="text-fg-muted flex-1 truncate text-sm">
              {workspacePath || 'Not configured'}
            </span>
            <Button
              variant="ghost"
              tone="neutral"
              size="sm"
              onClick={() => void handlePickFolder()}
              disabled={isLoading}
            >
              {isPicking ? 'Waiting…' : 'Change'}
            </Button>
          </div>

          {error && <p className="text-danger mb-2 text-xs">{error}</p>}
          {success && (
            <p className="text-success mb-2 text-xs">Workspace changed!</p>
          )}

          <p className="text-fg-subtle mb-3 text-[11px] leading-relaxed">
            The folder where canvas, sources, and artifacts are stored. Changes
            take effect immediately.
          </p>

          {/* Recent workspaces */}
          {recentWorkspaces.filter((p) => p !== workspacePath).length > 0 && (
            <div className="mb-3 overflow-hidden">
              <div className="text-fg-muted mb-1 flex items-center gap-1 text-xs font-medium">
                <FolderOpen size={12} />
                <span>Recent</span>
              </div>
              <ul className="space-y-0.5 overflow-hidden">
                {recentWorkspaces
                  .filter((p) => p !== workspacePath)
                  .map((path) => (
                    <li
                      key={path}
                      className="group flex min-w-0 items-center gap-0.5"
                    >
                      <Button
                        variant="ghost"
                        tone="neutral"
                        size="sm"
                        onClick={() => void handleSelectRecent(path)}
                        disabled={isLoading}
                        className="min-w-0 flex-1 justify-start overflow-hidden"
                        title={path}
                        tooltipWrapperClassName="min-w-0 flex-1 overflow-hidden"
                      >
                        <span className="block truncate">{path}</span>
                      </Button>
                      <Button
                        variant="ghost"
                        iconOnly
                        size="sm"
                        onClick={() => removeRecentWorkspace(path)}
                        className="text-fg-subtle shrink-0 p-0.5 opacity-0 group-hover:opacity-100"
                        title="Remove from recent"
                      >
                        <X />
                      </Button>
                    </li>
                  ))}
              </ul>
            </div>
          )}

          {/* ── LLM Provider / Model ── */}
          <LLMSettings />

          <div className="flex justify-end">
            <Button
              variant="outline"
              tone="neutral"
              size="sm"
              onClick={handleClose}
            >
              Close
            </Button>
          </div>
        </Popover>
      )}
    </>
  );
};
