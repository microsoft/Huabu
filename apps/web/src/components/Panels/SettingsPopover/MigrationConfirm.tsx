import { AlertTriangle } from 'lucide-react';
import React from 'react';

import type { KnowledgeStorageBackend } from './types';

interface MigrationConfirmProps {
  fromBackend: KnowledgeStorageBackend;
  toBackend: KnowledgeStorageBackend;
  migratableCount: number;
  onMigrateAndSwitch: () => void;
  onCancel: () => void;
}

/**
 * Confirmation panel shown when the user switches backends and there are
 * nodes with content that can be migrated.
 */
export const MigrationConfirm: React.FC<MigrationConfirmProps> = ({
  fromBackend,
  toBackend,
  migratableCount,
  onMigrateAndSwitch,
  onCancel,
}) => (
  <>
    <div className="mb-3 flex items-start gap-2">
      <AlertTriangle size={18} className="mt-0.5 shrink-0 text-amber-500" />
      <div>
        <h3 className="text-sm font-semibold text-gray-900">
          Storage Migration
        </h3>
        <p className="mt-1 text-xs text-gray-600">
          Switching from <span className="font-medium">{fromBackend}</span> to{' '}
          <span className="font-medium">{toBackend}</span> will affect{' '}
          <span className="font-semibold text-gray-900">{migratableCount}</span>{' '}
          {migratableCount === 1 ? 'node' : 'nodes'} with existing content.
        </p>
      </div>
    </div>

    <div className="space-y-2">
      <button
        type="button"
        className="w-full rounded-md bg-gray-900 px-3 py-2 text-sm text-white hover:bg-gray-800"
        onClick={onMigrateAndSwitch}
      >
        Migrate &amp; Switch
        <span className="ml-1 text-xs text-gray-400">
          — copy content to new backend
        </span>
      </button>
      <button
        type="button"
        className="w-full rounded-md px-3 py-1.5 text-sm text-gray-500 hover:bg-gray-100"
        onClick={onCancel}
      >
        Cancel
      </button>
    </div>
  </>
);
