// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { mkdirSync } from 'node:fs';

import { InMemoryBubbleStore } from '@octostaff/bubble';
import { expect, it, vi } from 'vitest';

import { buildAttachmentParts } from './attachments.js';
import { openBubbleIdentity, spaceTargetId } from '../../../identity/bubble.js';
import {
  openPersonalSettings,
  useCaller,
} from '../../../identity/personal-settings.js';
import { createMemoryWorkspacePreferences } from '../../../identity/preferences.js';
import { storageResourceDirectory } from '../../../identity/resources.js';
import { artifactPath } from '../../../storage/backends/disk/layout.js';
import { mountTestWorkspace } from '../../../storage/testing.js';
import { getWorkspaceHandle } from '../../../workspace.js';

async function attachmentCaller() {
  const workspace = getWorkspaceHandle();
  if (!workspace) throw new Error('Expected the real test Workspace');
  const store = new InMemoryBubbleStore();
  await store.principals.upsert({ principalId: 'member', kind: 'user' });
  for (const grant of [
    { target: { type: 'system' }, role: 'member' },
    {
      target: {
        type: 'huabu.space',
        id: spaceTargetId(workspace.workspaceId, 'readable'),
      },
      role: 'huabu.space.owner',
    },
  ] as const) {
    await store.grants.add({
      ...grant,
      principalId: 'member',
      grantedByPrincipalId: null,
    });
  }
  const bubble = await openBubbleIdentity({
    authenticator: [{ driver: 'master-key', masterKey: 'test-only-key' }],
    store,
    preferences: createMemoryWorkspacePreferences(),
    resources: storageResourceDirectory,
  });
  const identity = await bubble.service.resolvePrincipal?.('member');
  if (!identity) throw new Error('Expected the admitted attachment owner');
  return identity;
}

it.each(['file', 'image'] as const)(
  'requires source Space access before inlining a %s attachment',
  async (type) => {
    const opened = await mountTestWorkspace(
      { structured: { kind: 'disk' }, blobs: { kind: 'disk' } },
      'huabu-attachment-access-',
    );
    try {
      for (const canvasId of ['readable', 'private']) {
        await opened.storage.structured
          .spaces()
          .create({ canvasId, title: canvasId });
        await opened.storage
          .space(canvasId)
          .artifacts.put('source.png', Buffer.from('private-file-content'));
      }
      const caller = await attachmentCaller();
      await openPersonalSettings(async () => {
        useCaller(caller);
        const deliver = vi.fn();
        await expect(
          buildAttachmentParts(
            [
              {
                type,
                source: 'upload',
                url: '/api/canvas/readable/artifact/source.png',
              },
              {
                type,
                source: 'upload',
                url: '/api/canvas/private/artifact/source.png',
              },
            ],
            'own',
          ).then(deliver),
        ).rejects.toThrow('Artifact source Space is not readable');
        // The readable prefix cannot be sent as a complete attachment group
        // after denial, nor may the denied URL's caption be delivered.
        expect(deliver).not.toHaveBeenCalled();
        const parts = await buildAttachmentParts(
          [
            {
              type,
              source: 'upload',
              url: '/api/canvas/readable/artifact/source.png',
            },
          ],
          'own',
        );
        if (type === 'file')
          expect(parts).toMatchObject([
            {
              type: 'text',
              text: expect.stringContaining('private-file-content'),
            },
          ]);
        else
          expect(parts).toContainEqual({
            type: 'image',
            data: Buffer.from('private-file-content').toString('base64'),
            mimeType: 'image/png',
          });
      });
    } finally {
      await opened.close();
    }
  },
);

it.each(['file', 'image'] as const)(
  'keeps authorized %s attachments usable after missing blobs or read errors',
  async (type) => {
    const opened = await mountTestWorkspace(
      { structured: { kind: 'disk' }, blobs: { kind: 'disk' } },
      'huabu-attachment-recovery-',
    );
    try {
      await opened.storage.structured
        .spaces()
        .create({ canvasId: 'readable', title: 'Readable' });
      await opened.storage
        .space('readable')
        .artifacts.put('source.png', Buffer.from('usable-content'));
      // Reading a directory as a file gives a real EISDIR storage failure.
      mkdirSync(artifactPath('readable', 'broken.png'));
      const caller = await attachmentCaller();
      await openPersonalSettings(async () => {
        useCaller(caller);
        const parts = await buildAttachmentParts(
          ['missing.png', 'broken.png', 'source.png'].map((filename) => ({
            type,
            source: 'upload' as const,
            url: `/api/canvas/readable/artifact/${filename}`,
          })),
          'readable',
        );
        if (type === 'file') {
          expect(parts.slice(0, 2)).toEqual(
            ['missing.png', 'broken.png'].map((filename) => ({
              type: 'text',
              text: `<attachment type="file" name="attachment" url="/api/canvas/readable/artifact/${filename}" />`,
            })),
          );
          expect(parts[2]).toMatchObject({
            type: 'text',
            text: expect.stringContaining('usable-content'),
          });
        } else {
          // Ordinary unavailable image blobs keep their existing skip
          // behavior; the usable image is still delivered.
          expect(parts).toEqual([
            {
              type: 'image',
              data: Buffer.from('usable-content').toString('base64'),
              mimeType: 'image/png',
            },
          ]);
        }
      });
    } finally {
      await opened.close();
    }
  },
);
