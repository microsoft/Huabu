import { Settings } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import useCanvasStore from '../../store/canvasStore';
import { IconButton } from '../Common/IconButton';

import type { KnowledgeStorageBackend } from '@sediment/shared';

/**
 * Settings popover that lets users configure the knowledge storage backend.
 * Anchored to a trigger button and rendered via a portal.
 */
export const SettingsPopover: React.FC = () => {
  const storageConfig = useCanvasStore((s) => s.storageConfig);
  const setStorageConfig = useCanvasStore((s) => s.setStorageConfig);

  const [isOpen, setIsOpen] = useState(false);
  const [backend, setBackend] = useState<KnowledgeStorageBackend>(
    storageConfig.backend,
  );
  const [vaultPath, setVaultPath] = useState(
    storageConfig.obsidianVaultPath ?? '',
  );
  const [error, setError] = useState('');

  const triggerRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Sync local state when store changes (e.g. after canvas load)
  useEffect(() => {
    setBackend(storageConfig.backend);
    setVaultPath(storageConfig.obsidianVaultPath ?? '');
  }, [storageConfig]);

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
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [isOpen]);

  const handleSave = () => {
    if (backend === 'obsidian' && !vaultPath.trim()) {
      setError('Obsidian vault path is required');
      return;
    }

    setError('');
    setStorageConfig({
      backend,
      obsidianVaultPath: backend === 'obsidian' ? vaultPath.trim() : undefined,
    });
    setIsOpen(false);
  };

  const handleCancel = () => {
    // Reset local state to store values
    setBackend(storageConfig.backend);
    setVaultPath(storageConfig.obsidianVaultPath ?? '');
    setError('');
    setIsOpen(false);
  };

  // Compute popover position anchored below the trigger button
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
            <h3 className="mb-3 text-sm font-semibold text-gray-900">
              Knowledge Storage
            </h3>

            {/* Backend selector */}
            <div className="mb-3">
              <label className="mb-1 block text-xs font-medium text-gray-600">
                Storage Backend
              </label>
              <div className="flex gap-2">
                <button
                  type="button"
                  className={`flex-1 rounded-md border px-3 py-1.5 text-sm transition-colors ${
                    backend === 'sqlite'
                      ? 'border-blue-500 bg-blue-50 text-blue-700'
                      : 'border-border text-gray-600 hover:bg-gray-50'
                  }`}
                  onClick={() => {
                    setBackend('sqlite');
                    setError('');
                  }}
                >
                  SQLite
                </button>
                <button
                  type="button"
                  className={`flex-1 rounded-md border px-3 py-1.5 text-sm transition-colors ${
                    backend === 'obsidian'
                      ? 'border-blue-500 bg-blue-50 text-blue-700'
                      : 'border-border text-gray-600 hover:bg-gray-50'
                  }`}
                  onClick={() => setBackend('obsidian')}
                >
                  Obsidian
                </button>
              </div>
            </div>

            {/* Obsidian vault path (shown only when obsidian is selected) */}
            {backend === 'obsidian' && (
              <div className="mb-3">
                <label className="mb-1 block text-xs font-medium text-gray-600">
                  Vault Folder Path
                </label>
                <input
                  type="text"
                  value={vaultPath}
                  onChange={(e) => {
                    setVaultPath(e.target.value);
                    if (error) setError('');
                  }}
                  placeholder="/path/to/obsidian/vault"
                  className="border-border w-full rounded-md border px-3 py-1.5 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400"
                />
                {error && <p className="mt-1 text-xs text-red-500">{error}</p>}
              </div>
            )}

            {/* Actions */}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="rounded-md px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100"
                onClick={handleCancel}
              >
                Cancel
              </button>
              <button
                type="button"
                className="rounded-md bg-gray-900 px-3 py-1.5 text-sm text-white hover:bg-gray-800"
                onClick={handleSave}
              >
                Save
              </button>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
};
