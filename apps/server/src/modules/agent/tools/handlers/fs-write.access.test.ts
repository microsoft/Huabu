// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { AsyncLocalStorage } from 'node:async_hooks';

import { InMemoryBubbleStore } from '@octostaff/bubble';
import { describe, expect, it } from 'vitest';

import { handleFsWrite } from './fs-write.js';
import { openBubbleIdentity } from '../../../identity/bubble.js';
import {
  openPersonalSettings,
  useCaller,
} from '../../../identity/personal-settings.js';
import { createMemoryWorkspacePreferences } from '../../../identity/preferences.js';
import { storageResourceDirectory } from '../../../identity/resources.js';
import { SPACE_MEMORY_BLOB_NAME } from '../../../storage/index.js';
import {
  describeProfile,
  mountTestWorkspace,
  PRODUCT_STORAGE_PROFILES,
} from '../../../storage/testing.js';
import { runInWorkspace } from '../../../workspace/context.js';
import { getWorkspaceHandle } from '../../../workspace.js';

import type { FsWriteArgs } from './fs-write.js';

const accessLosses = [
  'viewer downgrade',
  'Workspace access removed',
  'admission revoked',
  'account disabled',
] as const;
const writeModes = ['overwrite', 'replace_string'] as const;

describe.each(
  PRODUCT_STORAGE_PROFILES.map((profile) => ({
    profile,
    label: describeProfile(profile),
  })),
)('fs_write retained caller authorization ($label)', ({ profile }) => {
  it.each(
    accessLosses.flatMap((loss) => writeModes.map((mode) => ({ loss, mode }))),
  )('denies $mode Space memory writes after $loss', async ({ loss, mode }) => {
    const opened = await mountTestWorkspace(
      profile,
      `huabu-memory-write-${describeProfile(profile)}-`,
    );
    const preferences = createMemoryWorkspacePreferences();
    try {
      const workspace = getWorkspaceHandle();
      if (!workspace) throw new Error('Expected the test Workspace');
      const canvasId = 'shared-space';
      await opened.storage.structured
        .spaces()
        .create({ canvasId, title: 'Shared Space' });
      const store = new InMemoryBubbleStore();
      await store.principals.upsert({
        principalId: 'member',
        kind: 'user',
      });
      await store.grants.add({
        target: { type: 'system' },
        principalId: 'member',
        role: 'member',
        grantedByPrincipalId: null,
      });
      const { service } = await openBubbleIdentity({
        authenticator: [{ driver: 'master-key', masterKey: 'test-only-key' }],
        owner: 'admin',
        store,
        preferences,
        resources: storageResourceDirectory,
      });
      await service.people.setWorkspaceRole(
        'member',
        workspace.workspaceId,
        'editor',
        'admin',
      );
      const caller = await service.resolvePrincipal?.('member');
      if (!caller) throw new Error('Expected the admitted editor');
      // Capture exactly the caller and Workspace a long-lived turn keeps;
      // subsequent tool calls never replace this with a fresh identity.
      const resumed = runInWorkspace(
        { handle: workspace, path: opened.workspacePath },
        () =>
          openPersonalSettings(() => {
            useCaller(caller);
            return AsyncLocalStorage.snapshot();
          }),
      );
      const write = (
        args: Pick<FsWriteArgs, 'mode' | 'body' | 'oldString' | 'newString'>,
      ) =>
        resumed(() =>
          handleFsWrite({ path: 'memory/space.md', canvasId, ...args }),
        );
      const bytes = () =>
        opened.storage.space(canvasId).memory.read(SPACE_MEMORY_BLOB_NAME);
      expect(
        await resumed(() =>
          caller.access.can('manage', {
            type: 'workspace',
            id: workspace.workspaceId,
          }),
        ),
      ).toBe(false);
      // Editors may curate this Space without managing the Workspace.
      expect(
        JSON.parse(await write({ mode: 'overwrite', body: 'Seed briefing' })),
      ).toMatchObject({ ok: true, target: 'memory/space.md' });
      expect(
        JSON.parse(
          await write({
            mode: 'replace_string',
            oldString: 'Seed',
            newString: 'Original',
          }),
        ),
      ).toMatchObject({ ok: true, target: 'memory/space.md' });
      expect((await bytes())?.toString()).toBe('Original briefing\n');

      if (loss === 'account disabled')
        await store.principals.update('member', {
          disabledAt: new Date().toISOString(),
        });
      else if (loss === 'admission revoked')
        await service.people.setMember('member', false, 'admin');
      else
        await service.people.setWorkspaceRole(
          'member',
          workspace.workspaceId,
          loss === 'viewer downgrade' ? 'viewer' : null,
          'admin',
        );
      expect(
        await resumed(() =>
          caller.access.can('write', { type: 'space', id: canvasId }),
        ),
      ).toBe(false);
      const args =
        mode === 'overwrite'
          ? { mode, body: 'Unauthorized overwrite' }
          : {
              mode,
              oldString: 'Original',
              newString: 'Unauthorized',
            };
      await expect
        .soft(write(args))
        .rejects.toThrow('write access to the Space');
      // Assert the real blob, not only the handler's result envelope.
      expect((await bytes())?.toString()).toBe('Original briefing\n');
    } finally {
      await preferences.close();
      await opened.close();
    }
  });
});
