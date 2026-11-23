// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * What a server-started job may read: it runs as the caller whose write
 * started it, so a node that cites another Space's artifact is processed
 * only as far as that caller could read.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../agent/functional-text.js', () => ({ runFunctionalText: vi.fn() }));

import {
  preprocessAfterWrites,
  waitForNodePreprocessing,
} from './node-jobs.js';
import { runFunctionalText } from '../agent/functional-text.js';
import { executeOnServer } from '../canvas/canvas-executor.js';
import { setCommitReactions } from '../canvas/commit-follow-up.js';
import {
  openPersonalSettings,
  useCaller,
} from '../identity/personal-settings.js';
import { createCanvas } from '../storage/compatibility/canvas.js';
import { getCanvasStore, resetStorageCache, space } from '../storage/index.js';
import { setWorkspacePath } from '../workspace.js';

import type { CanvasCommand } from '@huabu/shared';
import type { CanvasNode } from '@huabu/shared/canvas-engine';

let tmp: string;
const SECRET = '/api/canvas/private/artifact/secret.png';
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'huabu-jobs-access-'));
  vi.stubEnv('HUABU_DATA_DIR', tmp);
  setWorkspacePath(tmp);
  createCanvas('mine');
  createCanvas('private');
  await space('private').artifacts.put('secret.png', TINY_PNG);
  vi.mocked(runFunctionalText).mockResolvedValue('What the picture shows');
  setCommitReactions(preprocessAfterWrites);
});

afterEach(async () => {
  await waitForNodePreprocessing();
  setCommitReactions(undefined);
  vi.mocked(runFunctionalText).mockReset();
  vi.unstubAllEnvs();
  resetStorageCache();
  rmSync(tmp, { recursive: true, force: true });
});

const createImage = (): Promise<unknown> =>
  executeOnServer({
    canvasId: 'mine',
    originator: { source: 'ui' },
    commands: [
      {
        type: 'CREATE_NODES',
        nodes: [
          {
            id: 'node-image',
            nodeType: 'image',
            position: { x: 0, y: 0 },
            data: { src: SECRET },
          },
        ],
      },
    ] as CanvasCommand[],
  });

/** Carol reads and writes `mine` only. */
const asCarol = <T>(fn: () => T): T =>
  openPersonalSettings(() => {
    useCaller({
      principal: { principalId: 'carol', kind: 'user' },
      member: true,
      owner: false,
      access: {
        can: async (_level, { id }) => id === 'mine',
        claim: async () => {},
        workspaces: async () => 'all' as const,
      },
    });
    return fn();
  });

describe('a server-started job and another Space’s artifact', () => {
  it('does not read an image in a Space the caller may not read', async () => {
    await asCarol(createImage);
    await waitForNodePreprocessing();

    // Nothing of the picture reached the caller's Agent or the node.
    expect(runFunctionalText).not.toHaveBeenCalled();
    expect(getCanvasStore('mine').readNode('node-image')).not.toMatchObject({
      labelSource: 'auto',
    });
  });

  it('reads it for a caller who may', async () => {
    await createImage();
    await waitForNodePreprocessing();

    expect(runFunctionalText).toHaveBeenCalledOnce();
    expect(getCanvasStore('mine').readNode('node-image')).toMatchObject({
      label: 'What the picture shows',
      labelSource: 'auto',
    });
  });
});

describe('a run that waits behind another member’s', () => {
  it('is made as the member whose write it follows', async () => {
    await space('private').artifacts.put('other.png', TINY_PNG);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    vi.mocked(runFunctionalText).mockImplementation(async () => {
      await held;
      return 'What the picture shows';
    });

    // Someone who may read `private` starts the job…
    await createImage();
    await vi.waitFor(() => expect(runFunctionalText).toHaveBeenCalledOnce());
    // …and Carol, who may not, points the node at another of its pictures
    // while that run is under way.
    await asCarol(() =>
      executeOnServer({
        canvasId: 'mine',
        originator: { source: 'ui' },
        commands: [
          {
            type: 'MERGE_NODE_DATA',
            patches: [
              {
                nodeId: 'node-image',
                patch: { src: '/api/canvas/private/artifact/other.png' },
              },
            ],
          },
        ] as CanvasCommand[],
      }),
    );
    release();
    await waitForNodePreprocessing();

    // The run for Carol's write read nothing.
    expect(runFunctionalText).toHaveBeenCalledOnce();
  });
});

describe('a server-started job and a node whose record is missing', () => {
  it('does not write a record for it', async () => {
    // An Agent Node is re-associated after its record went missing.
    preprocessAfterWrites.agentNodeRestored('mine', {
      id: 'node-gone',
      type: 'question',
      position: { x: 0, y: 0 },
      data: { content: 'What is this?' },
    } as CanvasNode)?.();
    await waitForNodePreprocessing();

    expect(getCanvasStore('mine').readNode('node-gone')).toBeNull();
  });
});
