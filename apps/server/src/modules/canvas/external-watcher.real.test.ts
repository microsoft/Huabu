// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/** Real-filesystem regression for the missing-`nodes/` watch handoff. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  openExternalNoteSession,
  resetExternalNoteSessions,
} from './external-watcher.js';
import { createSpace, resetStorageCache } from '../storage/index.js';
import { setWorkspacePath } from '../workspace.js';

import type { ExternalNoteEvent } from '@huabu/shared';

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), 'huabu-external-watch-'));
  setWorkspacePath(workspace);
  resetStorageCache();
});

afterEach(() => {
  resetExternalNoteSessions();
  resetStorageCache();
  rmSync(workspace, { recursive: true, force: true });
});

describe('external note watcher — real filesystem', () => {
  it('observes nodes/ creation, deletion, and recreation in one session', async () => {
    const created = await createSpace('canvas-live', 'Live Space');
    expect(created.ok).toBe(true);
    const nodesPath = path.join(workspace, 'Live Space', 'nodes');
    const events: ExternalNoteEvent[] = [];

    const session = await openExternalNoteSession('canvas-live', (event) => {
      events.push(event);
    });
    expect(session.snapshot).toEqual([]);

    // A brand-new Space has no nodes directory. The active parent watcher
    // must hand off to nodes/ and discover a file written during that handoff.
    mkdirSync(nodesPath);
    writeFileSync(
      path.join(nodesPath, 'from-finder.md'),
      '---\nid: external-real\ntype: note\nlabel: From Finder\n---\nhello\n',
      'utf8',
    );

    await vi.waitFor(
      () => {
        expect(events).toContainEqual(
          expect.objectContaining({
            type: 'added',
            data: expect.objectContaining({
              relativePath: 'nodes/from-finder.md',
              noteId: 'external-real',
            }),
          }),
        );
      },
      { timeout: 5_000, interval: 25 },
    );

    // On Linux an fs.watch handle remains attached to the deleted inode and
    // never sees a new directory at the same path. The self-rename event must
    // move the session back to the Space watcher before nodes/ is recreated.
    rmSync(nodesPath, { recursive: true, force: true });
    await vi.waitFor(
      () => {
        expect(events).toContainEqual({
          type: 'snapshot',
          data: { items: [] },
        });
      },
      { timeout: 5_000, interval: 25 },
    );

    mkdirSync(nodesPath);
    writeFileSync(
      path.join(nodesPath, 'after-recreate.md'),
      '---\nid: external-recreated\ntype: note\nlabel: Recreated\n---\nhello again\n',
      'utf8',
    );

    await vi.waitFor(
      () => {
        expect(events).toContainEqual(
          expect.objectContaining({
            type: 'added',
            data: expect.objectContaining({
              relativePath: 'nodes/after-recreate.md',
              noteId: 'external-recreated',
            }),
          }),
        );
      },
      { timeout: 5_000, interval: 25 },
    );

    session.close();
  });
});
