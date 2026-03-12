import { FolderOpen, Settings } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { getWorkspacePath, putWorkspacePath } from '../../api/workspace';
import useCanvasStore from '../../store/canvasStore';
import { IconButton } from '../Common/IconButton';

/**
 * A minimal settings popover that lets the user view and change
 * the server-side workspace directory path.
 */
export const SettingsPopover: React.FC = () => {
  const loadCanvas = useCanvasStore((s) => s.loadCanvas);

  const [isOpen, setIsOpen] = useState(false);
  const [workspacePath, setWorkspacePath] = useState('');
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  const triggerRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Fetch current workspace path when popover opens
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;

    void getWorkspacePath().then((info) => {
      if (cancelled) return;
      setWorkspacePath(info.path);
      setDraft(info.path);
    });

    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  const handleClose = useCallback(() => {
    setIsOpen(false);
    setError('');
    setSuccess(false);
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

  const isDirty = draft.trim() !== workspacePath;

  const handleSave = async () => {
    const trimmed = draft.trim();
    if (!trimmed) {
      setError('Workspace path cannot be empty');
      return;
    }
    if (!isDirty) return;

    setSaving(true);
    setError('');
    setSuccess(false);

    try {
      const result = await putWorkspacePath(trimmed);
      setWorkspacePath(result.path);
      setDraft(result.path);
      setSuccess(true);
      setTimeout(() => setSuccess(false), 2000);

      // Reload canvas and notify other panels about workspace change
      await loadCanvas();
      window.dispatchEvent(new Event('workspace-changed'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
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
              Workspace Path
            </label>

            <input
              type="text"
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                setError('');
                setSuccess(false);
              }}
              placeholder="/path/to/workspace"
              className="border-border mb-2 w-full rounded border px-2.5 py-1.5 text-sm text-gray-800 outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400"
            />

            {error && <p className="mb-2 text-xs text-red-500">{error}</p>}
            {success && <p className="mb-2 text-xs text-green-600">Saved!</p>}

            <p className="mb-3 text-[11px] leading-relaxed text-gray-400">
              The directory where canvas, sources, and artifacts are stored.
              Changes take effect immediately for new operations.
            </p>

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={handleClose}
                className="rounded px-3 py-1.5 text-xs text-gray-500 hover:bg-gray-100"
              >
                Close
              </button>
              <button
                type="button"
                onClick={() => void handleSave()}
                disabled={saving || !isDirty}
                className="rounded bg-blue-500 px-3 py-1.5 text-xs text-white hover:bg-blue-600 disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
};
