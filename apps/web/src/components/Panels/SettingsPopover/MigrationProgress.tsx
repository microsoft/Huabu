import { Loader2 } from 'lucide-react';
import React from 'react';

interface MigrationProgressProps {
  migratableCount: number;
}

/**
 * Spinner shown while the migration request is in-flight.
 */
export const MigrationProgress: React.FC<MigrationProgressProps> = ({
  migratableCount,
}) => (
  <div className="flex flex-col items-center py-4">
    <Loader2 size={24} className="animate-spin text-blue-500" />
    <p className="mt-3 text-sm text-gray-600">
      Migrating {migratableCount} {migratableCount === 1 ? 'node' : 'nodes'}...
    </p>
    <p className="mt-1 text-xs text-gray-400">
      Please do not close this panel.
    </p>
  </div>
);
