import { existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { createId } from '@sediment/shared';

import { SPACE_JSON_FILENAME, WORLD_CANVAS_DIR_NAME } from './paths.js';
import { atomicWriteJson, readJson, sanitizeId } from '../../../utils/fs.js';

import type { CanvasFile } from '../../canvas/persistence-types.js';

function readWorldCanvas(filePath: string): CanvasFile {
  const canvas = readJson<CanvasFile>(filePath);
  if (
    !canvas ||
    typeof canvas.canvasId !== 'string' ||
    !Array.isArray(canvas.state?.nodes) ||
    !Array.isArray(canvas.state?.edges)
  ) {
    throw new Error(`World canvas is missing or malformed: ${filePath}`);
  }
  sanitizeId(canvas.canvasId, 'world canvasId');
  return canvas;
}

/**
 * Ensure one stable hidden World canvas exists in the workspace.
 *
 * An existing `.world` directory is treated as established storage: a
 * missing or malformed topology is an integrity error, never a signal to mint
 * a replacement identity.
 */
export function ensureWorldCanvasOnDisk(workspacePath: string): string {
  const worldRoot = path.join(workspacePath, WORLD_CANVAS_DIR_NAME);
  const worldJson = path.join(worldRoot, SPACE_JSON_FILENAME);

  if (existsSync(worldRoot)) {
    if (!statSync(worldRoot).isDirectory()) {
      throw new Error(`World canvas path is not a directory: ${worldRoot}`);
    }
    return readWorldCanvas(worldJson).canvasId;
  }

  mkdirSync(worldRoot);
  const now = Date.now();
  const canvas: CanvasFile = {
    canvasId: createId('canvas'),
    title: 'World',
    version: 0,
    state: { nodes: [], edges: [] },
    createdAt: now,
    updatedAt: now,
  };
  atomicWriteJson(worldJson, canvas);
  return canvas.canvasId;
}
