import { FolderOpen, Settings } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { pickFolder } from '../../api/workspace';
import useCanvasStore from '../../store/canvasStore';
import { useWorkspaceStore } from '../../store/workspaceStore';
import { IconButton } from '../Common/IconButton';

/**
 * A minimal settings popover that lets the user view and change
 * the server-side workspace directory path via native folder picker.
 */
export const SettingsPopover: React.FC = () => {
  const loadCanvas = useCanvasStore((s) => s.loadCanvas);
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const selectWorkspace = useWorkspaceStore((s) => s.selectWorkspace);

  const [isOpen, setIsOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [isPicking, setIsPicking] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  const triggerRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const successTimeoutRef = useRef<number | null>(null);

  const handleClose = useCallback(() => {
    setIsOpen(false);
    setError('');
    setSuccess(false);
    if (successTimeoutRef.current !== null) {
      clearTimeout(successTimeoutRef.current);
      successTimeoutRef.current = null;
    }
  }, []);

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return;

    const handleClick = (e: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(e.target as Node)
      ) {
        handleClose();
      }
    };

    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [isOpen, handleClose]);

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

  const getPopoverStyle = (): React.CSSProperties => {
    if (!triggerRef.current) return {};
    const rect = triggerRef.current.getBoundingClientRect();
    return {
      position: 'fixed',
      top: rect.bottom + 6,
      right: window.innerWidth - rect.right,
      zIndex: 9999,
    };
  };

  const isLoading = saving || isPicking;

  return (
    <>
      <div ref={triggerRef}>
        <IconButton
          title="Settings"
          onClick={() => setIsOpen((prev) => !prev)}
          aria-label="Open settings"
        >
          <Settings size={18} />
        </IconButton>
      </div>

      {isOpen &&
        createPortal(
          <div
            ref={popoverRef}
            style={getPopoverStyle()}
            className="border-border w-80 rounded-lg border bg-white p-4 shadow-lg"
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
              <button
                type="button"
                onClick={() => void handlePickFolder()}
                disabled={isLoading}
                className="shrink-0 rounded bg-gray-200 px-2.5 py-1 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-300 disabled:opacity-50"
              >
                {isPicking ? 'Waiting…' : 'Change'}
              </button>
            </div>

            {error && <p className="mb-2 text-xs text-red-500">{error}</p>}
            {success && (
              <p className="mb-2 text-xs text-green-600">Workspace changed!</p>
            )}

            <p className="mb-3 text-[11px] leading-relaxed text-gray-400">
              The folder where canvas, sources, and artifacts are stored.
              Changes take effect immediately.
            </p>

            <div className="flex justify-end">
              <button
                type="button"
                onClick={handleClose}
                className="rounded px-3 py-1.5 text-xs text-gray-500 hover:bg-gray-100"
              >
                Close
              </button>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
};
