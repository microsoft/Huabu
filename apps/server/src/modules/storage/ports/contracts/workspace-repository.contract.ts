// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/** Reusable minimum contract for backend-neutral Workspace membership. */

import { afterEach, describe, expect, it } from 'vitest';

import type { WorkspaceHandle, WorkspaceRepository } from '../workspace.js';

export interface WorkspaceRepositoryContractHarness {
  readonly repository: WorkspaceRepository;
  readonly create: (name: string) => Promise<WorkspaceHandle>;
  readonly cleanup?: () => Promise<void> | void;
}

export function describeWorkspaceRepositoryContract(
  name: string,
  createHarness: () =>
    | Promise<WorkspaceRepositoryContractHarness>
    | WorkspaceRepositoryContractHarness,
): void {
  describe(`WorkspaceRepository contract: ${name}`, () => {
    let harness: WorkspaceRepositoryContractHarness | null = null;

    async function open(): Promise<WorkspaceRepositoryContractHarness> {
      harness = await createHarness();
      return harness;
    }

    afterEach(async () => {
      await harness?.cleanup?.();
      harness = null;
    });

    it('starts with no registered Workspaces', async () => {
      const { repository } = await open();

      await expect(repository.list()).resolves.toEqual([]);
    });

    it('gets and lists registered Workspace identities', async () => {
      const { repository, create } = await open();
      const first = await create('First');
      const second = await create('Second');

      await expect(repository.get(first.workspaceId)).resolves.toEqual(first);
      await expect(repository.get(second.workspaceId)).resolves.toEqual(second);
      const workspaces = await repository.list();
      expect(workspaces).toHaveLength(2);
      expect(workspaces).toEqual(expect.arrayContaining([first, second]));
    });

    it('renames a registered Workspace and returns its authoritative handle', async () => {
      const { repository, create } = await open();
      const workspace = await create('Before');

      await expect(
        repository.rename(workspace.workspaceId, 'After'),
      ).resolves.toEqual({ ...workspace, name: 'After' });
      await expect(repository.get(workspace.workspaceId)).resolves.toEqual({
        ...workspace,
        name: 'After',
      });
    });

    it('unregisters membership without treating a missing id as success', async () => {
      const { repository, create } = await open();
      const workspace = await create('Disposable');

      await expect(repository.remove(workspace.workspaceId)).resolves.toBe(
        true,
      );
      await expect(repository.get(workspace.workspaceId)).resolves.toBeNull();
      await expect(repository.remove(workspace.workspaceId)).resolves.toBe(
        false,
      );
    });

    it('returns null for unknown identities', async () => {
      const { repository } = await open();

      await expect(
        repository.get('00000000-0000-4000-8000-000000000099'),
      ).resolves.toBeNull();
      await expect(
        repository.rename('00000000-0000-4000-8000-000000000099', 'Missing'),
      ).resolves.toBeNull();
    });
  });
}
