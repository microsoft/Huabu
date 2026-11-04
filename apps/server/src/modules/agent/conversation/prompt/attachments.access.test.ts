// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, it } from 'vitest';

import { buildAttachmentParts } from './attachments.js';
import {
  openPersonalSettings,
  useCaller,
} from '../../../identity/personal-settings.js';
import { mountTestWorkspace } from '../../../storage/testing.js';

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
      await openPersonalSettings(async () => {
        useCaller({
          principal: { principalId: 'member', kind: 'user' },
          member: true,
          owner: false,
          access: {
            can: async (_level, resource) => resource.id === 'readable',
            claim: async () => {},
            workspaces: async () => [],
          },
        });
        await expect(
          buildAttachmentParts(
            [
              {
                type,
                source: 'upload',
                url: '/api/canvas/private/artifact/source.png',
              },
            ],
            'own',
          ),
        ).rejects.toThrow('Artifact source Space is not readable');
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
