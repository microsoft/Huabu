import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Get the artifacts directory path
 */
export function getArtifactsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // This file lives at: apps/server/src/modules/artifact/*.ts
  // We want: apps/server/data/artifacts
  return path.resolve(here, '../../../data/artifacts');
}
