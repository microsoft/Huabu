// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/** Runtime validation and strict reads for Disk Space-record boundaries. */

import { readJsonStrict } from '../../../../utils/fs.js';
import { canvasFileShapeError } from '../../../canvas/persistence-validation.js';

import type { CanvasFile } from '../../../canvas/persistence-types.js';

export { canvasFileShapeError } from '../../../canvas/persistence-validation.js';

/**
 * Strictly read and validate one indexed `space.json` path.
 *
 * Only absence returns null. Invalid JSON, IO failures, shape violations,
 * and a record belonging to another Space reject before any self-heal can
 * rewrite the file.
 */
export function readValidCanvasFile(
  filePath: string,
  expectedCanvasId: string,
): CanvasFile | null {
  const parsed = readJsonStrict<unknown>(filePath);
  if (parsed === null) return null;

  const shapeError = canvasFileShapeError(parsed, expectedCanvasId);
  if (shapeError) {
    throw new SyntaxError(`Invalid Space record in ${filePath}: ${shapeError}`);
  }
  return parsed as CanvasFile;
}
