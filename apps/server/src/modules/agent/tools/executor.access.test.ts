// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { InMemoryBubbleStore } from '@octostaff/bubble';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { executeTool } from './executor.js';
import { toSafeFilename } from '../../../utils/naming.js';
import { openBubbleIdentity, spaceTargetId } from '../../identity/bubble.js';
import {
  callerAccess,
  openPersonalSettings,
  useCaller,
} from '../../identity/personal-settings.js';
import { createMemoryWorkspacePreferences } from '../../identity/preferences.js';
import { storageResourceDirectory } from '../../identity/resources.js';
import { SPACE_MEMORY_BLOB_NAME } from '../../storage/index.js';
import {
  mountTestWorkspace,
  type MountedTestStorage,
} from '../../storage/testing.js';
import { workspaceMemoryPath } from '../../workspace/paths.js';
import { getWorkspaceHandle } from '../../workspace.js';

const SPACE_ID = 'executor-shared-space';
const MEMBER_ID = 'executor-member';
const PRIVATE_BODY = 'Private retained-turn Space memory';
const NOTE_ID = 'private-note';
const NOTE_LABEL = 'Private note';
const IMAGE_ID = 'private-image';
const IMAGE_SRC = 'private-source.png';
const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
    '0000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
  'hex',
);

interface ReadCase {
  name: string;
  args: Record<string, unknown>;
  evidence: string;
}

const portableReads: ReadCase[] = [
  { name: 'get_space_outline', args: {}, evidence: NOTE_ID },
  { name: 'inspect_nodes', args: {}, evidence: NOTE_ID },
  { name: 'inspect_edges', args: {}, evidence: 'private-edge' },
  {
    name: 'read',
    args: { path: 'memory/space.md' },
    evidence: PRIVATE_BODY,
  },
  {
    name: 'snapshot_nodes',
    args: { nodeIds: [IMAGE_ID] },
    evidence: IMAGE_SRC,
  },
];
const diskReads: ReadCase[] = [
  {
    name: 'read',
    args: { path: `nodes/${toSafeFilename(NOTE_LABEL, NOTE_ID)}.md` },
    evidence: PRIVATE_BODY,
  },
  {
    name: 'grep',
    args: { pattern: 'Private', path: 'nodes' },
    evidence: NOTE_ID,
  },
  { name: 'find', args: { pattern: '*.md', path: 'nodes' }, evidence: NOTE_ID },
  { name: 'ls', args: { path: 'nodes' }, evidence: NOTE_LABEL },
];

function retainedAccess() {
  const access = callerAccess();
  if (!access) throw new Error('Expected the retained Bubble caller access');
  return access;
}

for (const kind of ['disk', 'sqlite'] as const) {
  describe(`retained Built-In tool access (${kind}/disk)`, () => {
    let opened: MountedTestStorage;
    let store: InMemoryBubbleStore;
    let bubble: Awaited<ReturnType<typeof openBubbleIdentity>>;
    let resumed: ReturnType<typeof AsyncLocalStorage.snapshot>;
    let target: { type: 'huabu.space'; id: string };
    let workspaceId: string;

    const tool = (name: string, args: Record<string, unknown> = {}) =>
      resumed(() => executeTool(name, args, { canvasId: SPACE_ID }));
    const revokeSpace = async () => {
      for (const grant of await store.grants.list({
        target,
        principalId: MEMBER_ID,
      }))
        await store.grants.remove(grant.grantId);
    };
    const grantSpace = () =>
      store.grants.add({
        target,
        principalId: MEMBER_ID,
        role: 'huabu.space.owner',
        grantedByPrincipalId: null,
      });

    beforeEach(async () => {
      opened = await mountTestWorkspace(
        { structured: { kind }, blobs: { kind: 'disk' } },
        'huabu-executor-access-',
      );
      const created = await opened.storage.structured
        .spaces()
        .create({ canvasId: SPACE_ID, title: 'Shared private data' });
      if (!created.ok) throw new Error('Expected a fresh test Space');
      const record = created.record;
      const seeded = await opened.storage.space(SPACE_ID).write({
        expectedVersion: record.version,
        nextRecord: {
          ...record,
          version: record.version + 1,
          state: {
            nodes: [
              {
                id: NOTE_ID,
                type: 'note',
                position: { x: 0, y: 0 },
                style: { width: 200, height: 100 },
                data: {},
              },
              {
                id: IMAGE_ID,
                type: 'image',
                position: { x: 300, y: 0 },
                style: { width: 1, height: 1 },
                data: {},
              },
            ],
            edges: [{ id: 'private-edge', source: NOTE_ID, target: IMAGE_ID }],
          },
        },
        nodeMutations: [
          {
            kind: 'put',
            nodeId: NOTE_ID,
            record: {
              nodeId: NOTE_ID,
              type: 'note',
              label: NOTE_LABEL,
              content: PRIVATE_BODY,
            },
          },
          {
            kind: 'put',
            nodeId: IMAGE_ID,
            record: {
              nodeId: IMAGE_ID,
              type: 'image',
              label: 'Private image',
              src: IMAGE_SRC,
              content: '',
            },
          },
        ],
      });
      expect(seeded).toEqual({ ok: true });
      await opened.storage
        .space(SPACE_ID)
        .memory.put(SPACE_MEMORY_BLOB_NAME, Buffer.from(PRIVATE_BODY));
      await opened.storage.space(SPACE_ID).artifacts.put(IMAGE_SRC, TINY_PNG);
      const workspace = getWorkspaceHandle();
      if (!workspace) throw new Error('Expected the mounted Workspace');
      workspaceId = workspace.workspaceId;
      target = {
        type: 'huabu.space',
        id: spaceTargetId(workspace.workspaceId, SPACE_ID),
      };
      store = new InMemoryBubbleStore();
      await store.principals.upsert({ principalId: MEMBER_ID, kind: 'user' });
      await store.grants.add({
        principalId: MEMBER_ID,
        target: { type: 'system' },
        role: 'member',
        grantedByPrincipalId: null,
      });
      await grantSpace();
      bubble = await openBubbleIdentity({
        authenticator: [{ driver: 'master-key', masterKey: 'test-only-key' }],
        store,
        preferences: createMemoryWorkspacePreferences(),
        resources: storageResourceDirectory,
      });
      const identity = await bubble.service.resolvePrincipal?.(MEMBER_ID);
      if (!identity) throw new Error('Expected the admitted Space owner');
      resumed = openPersonalSettings(() => {
        useCaller(identity);
        return AsyncLocalStorage.snapshot();
      });
    });

    afterEach(async () => {
      await opened?.close();
    });

    it.each(kind === 'disk' ? [...portableReads, ...diskReads] : portableReads)(
      'refuses subsequent $name $args reads after the owning Space grant is revoked',
      async ({ name, args, evidence }) => {
        // The retained conversation binding cannot preserve a revoked grant.
        expect(
          await resumed(() =>
            retainedAccess().can('read', { type: 'space', id: SPACE_ID }),
          ),
        ).toBe(true);
        expect(await tool(name, args)).toEqual(
          expect.stringContaining(evidence),
        );
        await revokeSpace();
        expect(
          await resumed(() =>
            retainedAccess().can('read', { type: 'space', id: SPACE_ID }),
          ),
        ).toBe(false);
        const deliver = vi.fn();
        await expect(tool(name, args).then(deliver)).rejects.toThrow(
          `Canvas ${SPACE_ID} is not readable`,
        );
        expect(deliver).not.toHaveBeenCalled();
        await grantSpace();
        expect(await tool(name, args)).toEqual(
          expect.stringContaining(evidence),
        );
      },
    );

    it('refuses retained reads after admission loss and account disabling while the Space grant remains', async () => {
      expect(await tool('read', { path: 'memory/space.md' })).toContain(
        PRIVATE_BODY,
      );
      await bubble.service.people.setMember(MEMBER_ID, false, 'test-admin');
      await expect(tool('inspect_nodes')).rejects.toThrow('is not readable');
      await expect(tool('read', { path: 'memory/space.md' })).rejects.toThrow(
        'is not readable',
      );
      await bubble.service.people.setMember(MEMBER_ID, true, 'test-admin');
      expect(await tool('inspect_nodes')).toContain(NOTE_ID);
      await store.principals.update(MEMBER_ID, {
        disabledAt: new Date().toISOString(),
      });
      await expect(
        tool('snapshot_nodes', { nodeIds: [IMAGE_ID] }),
      ).rejects.toThrow('is not readable');
    });

    it('keeps shared Workspace viewer reads usable without granting write access', async () => {
      await revokeSpace();
      await store.grants.add({
        principalId: MEMBER_ID,
        target: {
          type: 'huabu.workspace',
          id: workspaceId,
        },
        role: 'huabu.workspace.viewer',
        grantedByPrincipalId: null,
      });
      expect(
        await resumed(() =>
          retainedAccess().can('write', { type: 'space', id: SPACE_ID }),
        ),
      ).toBe(false);
      for (const { name, args, evidence } of portableReads)
        expect(await tool(name, args)).toContain(evidence);
    });

    it('preserves authorized World target reads while denying private targets and subsequent revocation', async () => {
      const spaces = opened.storage.structured.spaces();
      const foreignId = 'executor-foreign-space';
      await spaces.create({
        canvasId: foreignId,
        title: 'Foreign private data',
      });
      const worldId = await spaces.worldId();
      const world = await opened.storage.space(worldId).read();
      if (!world) throw new Error('Expected the real World record');
      expect(
        await opened.storage.space(worldId).write({
          expectedVersion: world.version,
          nextRecord: {
            ...world,
            version: world.version + 1,
            state: {
              ...world.state,
              nodes: [SPACE_ID, foreignId].map((canvasId, index) => ({
                id: `preview-${index}`,
                type: 'spacePreview',
                position: { x: index * 400, y: 0 },
                data: { targetCanvasId: canvasId },
              })),
            },
          },
          nodeMutations: [],
        }),
      ).toEqual({ ok: true });
      const readTarget = (canvasId: string) =>
        resumed(() =>
          executeTool(
            'get_space_outline',
            { targetCanvasId: canvasId },
            { canvasId: worldId },
          ),
        );
      expect(await readTarget(SPACE_ID)).toContain(NOTE_ID);
      await expect(readTarget(foreignId)).rejects.toThrow('is not readable');
      // A global virtual path with an explicit foreign target must not borrow
      // instruction-layer access from the conversation's World binding.
      await expect(
        resumed(() =>
          executeTool(
            'read',
            { path: 'skills/space/SKILL.md', targetCanvasId: foreignId },
            { canvasId: worldId },
          ),
        ),
      ).rejects.toThrow('is not readable');
      await revokeSpace();
      await expect(readTarget(SPACE_ID)).rejects.toThrow('is not readable');
    });

    it('keeps local reads and owning-only snapshots compatible without a caller', async () => {
      expect(
        await executeTool(
          'read',
          { path: 'memory/space.md' },
          { canvasId: SPACE_ID },
        ),
      ).toContain(PRIVATE_BODY);
      expect(
        await executeTool(
          'snapshot_nodes',
          { nodeIds: [IMAGE_ID], targetCanvasId: 'unreadable-other-space' },
          { canvasId: SPACE_ID },
        ),
      ).toContain(IMAGE_SRC);
    });

    if (kind === 'disk') {
      it.each([
        { path: 'skills/space/SKILL.md', evidence: 'Space' },
        { path: 'memory/user.md', evidence: 'Workspace instructions' },
      ])(
        'keeps virtual $path reads scoped to current Space or Workspace access',
        async ({ path: requestedPath, evidence }) => {
          mkdirSync(path.dirname(workspaceMemoryPath()), { recursive: true });
          writeFileSync(workspaceMemoryPath(), 'Workspace instructions');
          expect(await tool('read', { path: requestedPath })).toContain(
            evidence,
          );
          await revokeSpace();
          await expect(tool('read', { path: requestedPath })).rejects.toThrow(
            'is not readable',
          );
          await store.grants.add({
            principalId: MEMBER_ID,
            target: { type: 'huabu.workspace', id: workspaceId },
            role: 'huabu.workspace.viewer',
            grantedByPrincipalId: null,
          });
          expect(await tool('read', { path: requestedPath })).toContain(
            evidence,
          );
          await bubble.service.people.setMember(MEMBER_ID, false, 'test-admin');
          await expect(tool('read', { path: requestedPath })).rejects.toThrow(
            'is not readable',
          );
        },
      );
    }
  });
}
