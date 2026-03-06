import clsx from 'clsx';
import React from 'react';

import type { KnowledgeStorageBackend } from './types';

interface StorageSettingsFormProps {
  backend: KnowledgeStorageBackend;
  vaultPath: string;
  error: string;
  onBackendChange: (backend: KnowledgeStorageBackend) => void;
  onVaultPathChange: (path: string) => void;
  onSave: () => void;
  onCancel: () => void;
}

/**
 * Form for selecting the storage backend and (optionally) configuring
 * the Obsidian vault path.
 */
export const StorageSettingsForm: React.FC<StorageSettingsFormProps> = ({
  backend,
  vaultPath,
  error,
  onBackendChange,
  onVaultPathChange,
  onSave,
  onCancel,
}) => (
  <>
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
          className={clsx(
            'flex-1 rounded-md border px-3 py-1.5 text-sm transition-colors',
            backend === 'sqlite'
              ? 'border-blue-500 bg-blue-50 text-blue-700'
              : 'border-border text-gray-600 hover:bg-gray-50',
          )}
          onClick={() => onBackendChange('sqlite')}
        >
          SQLite
        </button>
        <button
          type="button"
          className={clsx(
            'flex-1 rounded-md border px-3 py-1.5 text-sm transition-colors',
            backend === 'obsidian'
              ? 'border-blue-500 bg-blue-50 text-blue-700'
              : 'border-border text-gray-600 hover:bg-gray-50',
          )}
          onClick={() => onBackendChange('obsidian')}
        >
          Obsidian
        </button>
      </div>
    </div>

    {/* Obsidian vault path */}
    {backend === 'obsidian' && (
      <div className="mb-3">
        <label className="mb-1 block text-xs font-medium text-gray-600">
          Vault Folder Path
        </label>
        <input
          type="text"
          value={vaultPath}
          onChange={(e) => onVaultPathChange(e.target.value)}
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
        onClick={onCancel}
      >
        Cancel
      </button>
      <button
        type="button"
        className="rounded-md bg-gray-900 px-3 py-1.5 text-sm text-white hover:bg-gray-800"
        onClick={onSave}
      >
        Save
      </button>
    </div>
  </>
);
