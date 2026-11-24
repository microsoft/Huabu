// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Storing the order keys of Spaces written before nodes carried them.
 *
 * Runs against a real Disk Workspace folder and a real SQLite database, and
 * triggers the step the way the product does: Workspace preparation on Disk,
 * the schema-version upgrade at start on SQLite. Each case writes Spaces in
 * the old format through the structured port, which stores what it is given.
 *
 *   - what is stored afterwards is what the read returned before, for paint
 *     order from array position, a Frame's stored list, and a Frame with no
 *     stored reading order
 *   - the Space version, timestamps, events and node records are untouched
 *   - a Space that has its keys is not written; a second run writes nothing
 *   - a Space that arrives in the old format later is stored on the next run
 *   - retired Portal / Pin nodes stay stored and the read is unchanged
 */

import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { withTestDatabase } from '../storage/backends/sqlite/test-support.js';
import {
  mountTestWorkspace,
  type MountedTestStorage,
} from '../storage/testing.js';
import { runWorkspacePreparation } from '../workspace-activation.js';
import { prepareWorkspaceOnDisk } from '../workspace-prepare.js';

import type { CanvasFile } from './persistence-types.js';
import type { Storage } from '../storage/index.js';
import type { StorageProfile } from '../storage/profile.js';

type StoredNode = Record<string, unknown> & { id: string };

const note = (id: string, extra: Record<string, unknown> = {}): StoredNode => ({
  id,
  type: 'note',
  position: { x: 0, y: 0 },
  data: {},
  ...extra,
});

/** Paint order held only as array position, across two parents. */
const PAINT_ONLY: StoredNode[] = [
  note('node-back'),
  {
    id: 'node-free-frame',
    type: 'frame',
    position: { x: 100, y: 0 },
    style: { width: 400, height: 400 },
    data: {},
  },
  note('node-inner-low', { parentId: 'node-free-frame' }),
  note('node-inner-high', { parentId: 'node-free-frame' }),
  note('node-front'),
];

/** A Column / Row Frame's two tracks of children, placed against the list. */
function structuredFrame(
  mode: 'column' | 'row',
  layoutOrder?: string[][],
): StoredNode[] {
  const field = mode === 'column' ? 'frameColumn' : 'frameRow';
  const child = (id: string, track: number, at: number): StoredNode => ({
    id,
    type: 'note',
    parentId: 'node-frame',
    position: mode === 'column' ? { x: 0, y: 500 - at } : { x: 500 - at, y: 0 },
    style: { width: 100, height: 60 },
    data: { [field]: track },
  });
  return [
    note('node-back', { position: { x: -500, y: 0 } }),
    {
      id: 'node-frame',
      type: 'frame',
      position: { x: 0, y: 0 },
      style: { width: 400, height: 400 },
      data: {
        layoutMode: mode,
        gridCount: 2,
        ...(layoutOrder ? { layoutOrder } : {}),
      },
    },
    child('node-a', 0, 10),
    child('node-b', 1, 20),
    child('node-c', 0, 30),
    note('node-front', { position: { x: 900, y: 0 } }),
  ];
}

/** The three ways a Space held order before nodes carried keys. */
const LEGACY_SPACES: Record<string, StoredNode[]> = {
  'space-paint-only': PAINT_ONLY,
  'space-column-list': structuredFrame('column', [
    ['node-c', 'node-a'],
    ['node-b', 'node-gone'],
  ]),
  'space-row-list': structuredFrame('row', [['node-c', 'node-a'], ['node-b']]),
  'space-column-implicit': structuredFrame('column'),
  'space-row-implicit': structuredFrame('row'),
};

const PROFILES: StorageProfile[] = [
  { structured: { kind: 'disk' }, blobs: { kind: 'disk' } },
  { structured: { kind: 'sqlite' }, blobs: { kind: 'disk' } },
];

describe.each(PROFILES)('stored order keys ($structured.kind)', (profile) => {
  let mounted: MountedTestStorage | null = null;
  let storage: Storage;

  afterEach(async () => {
    await mounted?.close();
    mounted = null;
  });

  async function open(): Promise<void> {
    mounted = await mountTestWorkspace(profile, 'huabu-order-keys-');
    storage = mounted.storage;
  }

  /** Store a Space exactly as given, with one node record beside it. */
  async function storeSpace(
    canvasId: string,
    nodes: readonly unknown[],
  ): Promise<void> {
    const created = await storage.structured
      .spaces()
      .create({ canvasId, title: canvasId });
    if (!created.ok) throw new Error(`Could not create ${canvasId}`);
    const nodeId = (nodes[0] as StoredNode).id;
    const written = await storage.structured.space(canvasId).write({
      expectedVersion: 0,
      nextRecord: {
        ...created.record,
        version: 1,
        state: { nodes: [...nodes], edges: [] },
      },
      nodeMutations: [
        {
          kind: 'put',
          nodeId,
          record: { nodeId, type: 'note', label: nodeId, content: 'body' },
        },
      ],
    });
    if (!written.ok) throw new Error(`Could not write ${canvasId}`);
    await storage.space(canvasId).events.append([
      {
        payload: {
          action: 'node_selected',
          node: { id: nodeId, type: 'note', label: nodeId },
        },
        ts: 1,
      },
    ]);
  }

  /** Everything the step must leave alone, and the stored record itself. */
  async function snapshot(canvasId: string) {
    const raw = storage.structured.space(canvasId);
    const record = (await raw.read()) as CanvasFile;
    const nodeId = (record.state.nodes[0] as StoredNode).id;
    return {
      record,
      events: await raw.events.read(),
      nodes: await raw.nodes.list(),
      firstNode: await raw.nodes.read(nodeId),
    };
  }

  /** The record without its nodes: what the step may not change. */
  function besidesNodes(record: CanvasFile) {
    const { nodes: _nodes, ...state } = record.state;
    return { ...record, state };
  }

  /** Run the step the way the product does. */
  async function storeKeys(): Promise<void> {
    if (!mounted) throw new Error('Not mounted');
    if (profile.structured.kind === 'disk') {
      prepareWorkspaceOnDisk(mounted.workspacePath);
      return;
    }
    // A database last opened by the build before the keys existed.
    withTestDatabase(process.env['HUABU_SQLITE_PATH'] as string, (database) =>
      database.exec('PRAGMA user_version = 4'),
    );
    storage = await mounted.reopen();
  }

  it.each(Object.keys(LEGACY_SPACES))(
    'stores for %s exactly what the read returned before',
    async (canvasId) => {
      await open();
      await storeSpace(canvasId, LEGACY_SPACES[canvasId]);
      const before = await snapshot(canvasId);
      const readBefore = await storage.space(canvasId).read();
      // The fixture really is in the old format: the read converts it.
      expect(readBefore?.state.nodes).not.toEqual(before.record.state.nodes);

      await storeKeys();

      const after = await snapshot(canvasId);
      expect(after.record.state.nodes).toEqual(readBefore?.state.nodes);
      expect(await storage.space(canvasId).read()).toEqual(readBefore);
      expect(besidesNodes(after.record)).toEqual(besidesNodes(before.record));
      expect(after.events).toEqual(before.events);
      expect(after.nodes).toEqual(before.nodes);
      expect(after.firstNode).toEqual(before.firstNode);
    },
  );

  it('leaves a keyed Space alone, and a second run changes nothing', async () => {
    await open();
    for (const [canvasId, nodes] of Object.entries(LEGACY_SPACES))
      await storeSpace(canvasId, nodes);
    const keyed = (await storage
      .space('space-paint-only')
      .read()) as CanvasFile;
    await storeSpace('space-keyed', keyed.state.nodes);
    const keyedBefore = await snapshot('space-keyed');

    await storeKeys();
    expect(await snapshot('space-keyed')).toEqual(keyedBefore);

    const ids = [...Object.keys(LEGACY_SPACES), 'space-keyed'];
    const once = await Promise.all(ids.map(snapshot));
    await storeKeys();
    expect(await Promise.all(ids.map(snapshot))).toEqual(once);
  });

  it('stores a Space that arrives in the old format after the first run', async () => {
    await open();
    await storeSpace('space-paint-only', LEGACY_SPACES['space-paint-only']);
    await storeKeys();
    const first = await snapshot('space-paint-only');

    await storeSpace('space-late', LEGACY_SPACES['space-column-implicit']);
    const readBefore = await storage.space('space-late').read();
    await storeKeys();

    expect((await snapshot('space-late')).record.state.nodes).toEqual(
      readBefore?.state.nodes,
    );
    expect(await snapshot('space-paint-only')).toEqual(first);
  });

  it('keeps retired Portal nodes stored and the read unchanged', async () => {
    await open();
    const nodes: StoredNode[] = [
      note('node-first'),
      {
        id: 'node-portal',
        type: 'canvasRef',
        position: { x: 100, y: 200 },
        data: {},
      },
      note('node-held', {
        parentId: 'node-portal',
        extent: 'parent',
        position: { x: 3, y: 4 },
      }),
      note('node-last'),
    ];
    await storeSpace('space-portal', nodes);
    const before = await snapshot('space-portal');
    const readBefore = await storage.space('space-portal').read();

    await storeKeys();

    const after = await snapshot('space-portal');
    expect(await storage.space('space-portal').read()).toEqual(readBefore);
    const stored = after.record.state.nodes as StoredNode[];
    // Everything but `data` and array order is as it was stored.
    const withoutData = (list: StoredNode[]) =>
      list
        .map(({ data: _data, ...rest }) => rest)
        .sort((a, b) => a.id.localeCompare(b.id));
    expect(withoutData(stored)).toEqual(withoutData(nodes));
    expect(stored.find((node) => node.id === 'node-portal')).toEqual(nodes[1]);
    expect(besidesNodes(after.record)).toEqual(besidesNodes(before.record));

    const once = await snapshot('space-portal');
    await storeKeys();
    expect(await snapshot('space-portal')).toEqual(once);
  });
});

describe('stored order keys on a Disk Workspace folder', () => {
  let mounted: MountedTestStorage | null = null;
  let folder: string | null = null;

  afterEach(async () => {
    await mounted?.close();
    mounted = null;
    if (folder) rmSync(folder, { recursive: true, force: true });
    folder = null;
  });

  /** The identity of every Space record file: replaced means rewritten. */
  function recordFiles(workspacePath: string): Record<string, number> {
    const files: Record<string, number> = {};
    for (const name of readdirSync(workspacePath)) {
      const file = path.join(workspacePath, name, 'space.json');
      const stat = statSync(file, { throwIfNoEntry: false });
      if (stat) files[name] = stat.ino;
    }
    return files;
  }

  async function writeLegacySpace(m: MountedTestStorage): Promise<void> {
    const created = await m.storage.structured
      .spaces()
      .create({ canvasId: 'space-legacy', title: 'Legacy' });
    if (!created.ok) throw new Error('Could not create the Space');
    await m.storage.structured.space('space-legacy').write({
      expectedVersion: 0,
      nextRecord: {
        ...created.record,
        version: 1,
        state: { nodes: structuredFrame('row'), edges: [] },
      },
      nodeMutations: [],
    });
  }

  it('rewrites only the record of a Space without keys, and only once', async () => {
    mounted = await mountTestWorkspace(PROFILES[0], 'huabu-order-keys-files-');
    await writeLegacySpace(mounted);
    const before = recordFiles(mounted.workspacePath);
    expect(Object.keys(before).sort()).toEqual(['.world', 'Legacy']);

    prepareWorkspaceOnDisk(mounted.workspacePath);
    const once = recordFiles(mounted.workspacePath);
    expect(once['.world']).toBe(before['.world']);
    expect(once['Legacy']).not.toBe(before['Legacy']);

    prepareWorkspaceOnDisk(mounted.workspacePath);
    expect(recordFiles(mounted.workspacePath)).toEqual(once);
  });

  it('passes over a folder whose space.json is not a Space record', async () => {
    mounted = await mountTestWorkspace(PROFILES[0], 'huabu-order-keys-bad-');
    await writeLegacySpace(mounted);
    const damaged = path.join(mounted.workspacePath, 'Damaged');
    mkdirSync(damaged);
    writeFileSync(path.join(damaged, 'space.json'), '{ not json');
    const readBefore = await mounted.storage.space('space-legacy').read();

    prepareWorkspaceOnDisk(mounted.workspacePath);

    expect(readFileSync(path.join(damaged, 'space.json'), 'utf-8')).toBe(
      '{ not json',
    );
    expect(
      (await mounted.storage.structured.space('space-legacy').read())?.state
        .nodes,
    ).toEqual(readBefore?.state.nodes);
  });

  it('runs in the isolated preparation process that opens a Workspace', async () => {
    mounted = await mountTestWorkspace(PROFILES[0], 'huabu-order-keys-fork-');
    await writeLegacySpace(mounted);
    const readBefore = await mounted.storage.space('space-legacy').read();
    // The same folder as another device left it, opened from cold.
    folder = mkdtempSync(path.join(tmpdir(), 'huabu-order-keys-copy-'));
    cpSync(mounted.workspacePath, folder, { recursive: true });
    const before = recordFiles(folder);

    await runWorkspacePreparation(folder);

    expect(recordFiles(folder)['Legacy']).not.toBe(before['Legacy']);
    const stored = JSON.parse(
      readFileSync(path.join(folder, 'Legacy', 'space.json'), 'utf-8'),
    ) as CanvasFile;
    expect(stored.state.nodes).toEqual(readBefore?.state.nodes);
    expect(stored.version).toBe(readBefore?.version);
  }, 60_000);
});
