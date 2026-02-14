import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import React from 'react';

import type { MigrateStorageResponse } from './types';

interface MigrationResultProps {
  result: MigrateStorageResponse | null;
  error: string;
  onClose: () => void;
}

/**
 * Shows the outcome of a storage migration – success summary or error details.
 */
export const MigrationResult: React.FC<MigrationResultProps> = ({
  result,
  error,
  onClose,
}) => {
  if (error) {
    return (
      <>
        <div className="mb-3 flex items-start gap-2">
          <AlertTriangle size={18} className="mt-0.5 shrink-0 text-red-500" />
          <div>
            <h3 className="text-sm font-semibold text-gray-900">
              Migration Failed
            </h3>
            <p className="mt-1 text-xs text-red-600">{error}</p>
          </div>
        </div>
        <div className="flex justify-end">
          <button
            type="button"
            className="rounded-md bg-gray-900 px-3 py-1.5 text-sm text-white hover:bg-gray-800"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </>
    );
  }

  const hasFailures = (result?.failedCount ?? 0) > 0;

  return (
    <>
      <div className="mb-3 flex items-start gap-2">
        {hasFailures ? (
          <AlertTriangle size={18} className="mt-0.5 shrink-0 text-amber-500" />
        ) : (
          <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-green-500" />
        )}
        <div>
          <h3 className="text-sm font-semibold text-gray-900">
            {hasFailures
              ? 'Migration Completed with Errors'
              : 'Migration Complete'}
          </h3>
          <ul className="mt-2 space-y-1 text-xs text-gray-600">
            {(result?.migratedCount ?? 0) > 0 && (
              <li>✓ {result!.migratedCount} migrated</li>
            )}
            {(result?.skippedCount ?? 0) > 0 && (
              <li>⊘ {result!.skippedCount} skipped (not found in source)</li>
            )}
            {(result?.failedCount ?? 0) > 0 && (
              <li className="text-red-600">✗ {result!.failedCount} failed</li>
            )}
          </ul>

          {/* Show failed details */}
          {hasFailures && result?.results && (
            <div className="mt-2 max-h-24 overflow-y-auto rounded border border-red-100 bg-red-50 p-2">
              {result.results
                .filter((n) => n.status === 'failed')
                .map((n) => (
                  <p key={n.nodeId} className="text-xs text-red-600">
                    {n.nodeId}: {n.error}
                  </p>
                ))}
            </div>
          )}
        </div>
      </div>
      <div className="flex justify-end">
        <button
          type="button"
          className="rounded-md bg-gray-900 px-3 py-1.5 text-sm text-white hover:bg-gray-800"
          onClick={onClose}
        >
          Done
        </button>
      </div>
    </>
  );
};
