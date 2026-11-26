// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Store the order keys of every Space in a Workspace folder that was written
 * before nodes carried them.
 *
 * Part of Workspace preparation, so it runs each time the folder is opened
 * and records nothing about having run: a Space that has its keys is read
 * and left alone, which is also what makes an interrupted run safe — each
 * `space.json` is replaced atomically, and the next open converts the rest.
 * It has to look every time because a folder can gain old-format Spaces
 * between two opens, written by an older build on another device.
 *
 * Only `state.nodes` in `space.json` is rewritten. The version, the
 * timestamps, the change log and every node file stay as they are: the read
 * already returned these keys, so nothing changed for any reader.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { SPACE_JSON_FILENAME, WORLD_CANVAS_DIR_NAME } from './layout.js';
import { atomicWriteJson } from '../../../../utils/fs.js';
import { canvasFileShapeError } from '../../../canvas/persistence-validation.js';
import { storedNodesWithOrderKeys } from '../../../canvas/stored-node-order.js';

import type { CanvasFile } from '../../../canvas/persistence-types.js';

/** The text of a file, or `null` when it cannot be read. */
function readText(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * The record a `space.json` holds, or `null` for text that is not one. The
 * Space's own read reports a damaged record; this step only leaves it alone.
 */
function parseSpaceRecord(text: string): CanvasFile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const canvasId = (parsed as { canvasId?: unknown } | null)?.canvasId;
  if (typeof canvasId !== 'string' || canvasFileShapeError(parsed, canvasId))
    return null;
  return parsed as CanvasFile;
}

/** Returns how many Spaces had their keys stored. */
export function storeSpaceOrderKeysOnDisk(workspacePath: string): number {
  // The same folders the directory index reads as Spaces: the hidden World
  // and every visible direct child.
  const folders = readdirSync(workspacePath).filter(
    (name) => name === WORLD_CANVAS_DIR_NAME || !name.startsWith('.'),
  );

  let stored = 0;
  for (const folder of folders) {
    const filePath = path.join(workspacePath, folder, SPACE_JSON_FILENAME);
    const text = readText(filePath);
    if (text === null) continue;
    const record = parseSpaceRecord(text);
    if (!record) continue;
    const nodes = storedNodesWithOrderKeys(record.state);
    if (!nodes) continue;
    // A Server that already has this folder open may have saved the Space
    // since it was read here. Its save stores the keys itself, so leave it.
    if (readText(filePath) !== text) continue;
    atomicWriteJson(filePath, { ...record, state: { ...record.state, nodes } });
    stored += 1;
  }
  return stored;
}
