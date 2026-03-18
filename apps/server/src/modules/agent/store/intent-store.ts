/**
 * Intent Store
 *
 * Persists intent episodes as JSON files (replaces SQLite storage).
 * Storage layout: .history/<canvasId>/intent_record.json
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { getWorkspacePath } from '../../workspace.js';

import type { IntentEpisode } from '@sediment/shared';

const HISTORY_DIR = '.history';
const DEFAULT_CANVAS = '_default';
const INTENT_FILE = 'intent_record.json';

function sanitize(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function getCanvasDir(canvasId?: string): string {
  const canvas = sanitize(canvasId || DEFAULT_CANVAS);
  const dir = path.join(getWorkspacePath(), HISTORY_DIR, canvas);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getIntentPath(canvasId?: string): string {
  return path.join(getCanvasDir(canvasId), INTENT_FILE);
}

function loadEpisodes(canvasId?: string): IntentEpisode[] {
  const filePath = getIntentPath(canvasId);
  if (!existsSync(filePath)) return [];
  try {
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as IntentEpisode[];
  } catch {
    return [];
  }
}

function saveEpisodes(episodes: IntentEpisode[], canvasId?: string): void {
  const filePath = getIntentPath(canvasId);
  const tmpPath = filePath + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(episodes, null, 2), 'utf-8');
  renameSync(tmpPath, filePath);
}

/**
 * Append an intent episode to the record for a canvas.
 */
export function logIntentEpisode(
  episode: IntentEpisode,
  canvasId?: string,
): void {
  const episodes = loadEpisodes(canvasId);
  // Replace if same ID exists, otherwise append
  const idx = episodes.findIndex((e) => e.id === episode.id);
  if (idx >= 0) {
    episodes[idx] = episode;
  } else {
    episodes.push(episode);
  }
  saveEpisodes(episodes, canvasId);
}
