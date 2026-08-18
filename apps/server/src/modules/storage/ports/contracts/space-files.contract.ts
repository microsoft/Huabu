// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Reusable minimum contract for the Space file capability.
 *
 * What every materialization owes, independent of how it addresses a Space.
 * Deliberately silent about *where* anything lands: a suite that asserted a
 * path would be asserting one addressing scheme, which is the coupling this
 * capability exists to remove. It asserts the relationships a feature module
 * actually depends on — that the nodes directory is under the Space
 * directory, that a published import is reachable through the ordinary scope,
 * that a retained scope stops answering once the Workspace changes.
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { CanvasFile } from '../../../canvas/persistence-types.js';
import type { SpaceFiles } from '../files.js';

export interface SpaceFilesContractHarness {
  /** Capability under test, bound to an isolated active Workspace. */
  readonly files: SpaceFiles;
  /** Activate a different Workspace, so retained scopes must be refused. */
  readonly switchWorkspace: () => void;
  /** Does `relativePath` exist inside this Space's materialization? */
  readonly exists: (canvasId: string, relativePath: string) => boolean;
  /** Write one file into a directory the harness was handed. */
  readonly writeFile: (
    directory: string,
    relativePath: string,
    contents: string,
  ) => void;
  readonly cleanup?: () => Promise<void> | void;
}

function record(canvasId: string, title: string | null): CanvasFile {
  return {
    canvasId,
    title,
    version: 0,
    state: { nodes: [], edges: [] },
    createdAt: 1,
    updatedAt: 1,
  };
}

export function describeSpaceFilesContract(
  name: string,
  createHarness: () =>
    | Promise<SpaceFilesContractHarness>
    | SpaceFilesContractHarness,
): void {
  describe(`SpaceFiles contract: ${name}`, () => {
    let harness: SpaceFilesContractHarness | null = null;

    async function open(): Promise<SpaceFilesContractHarness> {
      harness = await createHarness();
      await harness.files.init();
      harness.files.activate();
      return harness;
    }

    afterEach(async () => {
      await harness?.cleanup?.();
      harness = null;
    });

    it('reports a kind and a healthy connection', async () => {
      const { files } = await open();

      expect(files.kind).toBeTruthy();
      await expect(files.health()).resolves.toMatchObject({
        ok: true,
        kind: files.kind,
      });
    });

    it('puts the nodes directory inside the Space directory', async () => {
      const { files } = await open();
      const scope = files.space('canvas-contract-a');

      expect(scope.canvasId).toBe('canvas-contract-a');
      expect(scope.nodesDirectory().startsWith(scope.directory())).toBe(true);
      expect(scope.nodesDirectory()).not.toBe(scope.directory());
    });

    it('isolates one Space directory from another', async () => {
      const { files } = await open();

      expect(files.space('canvas-contract-a').directory()).not.toBe(
        files.space('canvas-contract-b').directory(),
      );
    });

    it('publishes a staged import into the ordinary scope', async () => {
      const { files, exists, writeFile } = await open();
      const staged = await files.stageImport('canvas-contract-import');
      writeFile(staged.directory, 'nodes/seed.md', '---\nid: seed\n---\nbody');

      const published = await staged.publish(
        record('canvas-contract-import', 'Imported Space'),
      );

      // The returned record is authoritative — an implementation that has to
      // allocate a name may have adjusted the title to fit its namespace.
      expect(published.canvasId).toBe('canvas-contract-import');
      expect(exists('canvas-contract-import', 'nodes/seed.md')).toBe(true);
      // Idempotent after publish: the staging directory is already gone.
      await expect(staged.discard()).resolves.toBeUndefined();
      expect(exists('canvas-contract-import', 'nodes/seed.md')).toBe(true);
    });

    it('refuses to publish a record addressed to another Space', async () => {
      const { files } = await open();
      const staged = await files.stageImport('canvas-contract-import');

      await expect(
        staged.publish(record('canvas-contract-other', 'Wrong Space')),
      ).rejects.toThrow();
    });

    it('refuses to publish twice', async () => {
      const { files } = await open();
      const staged = await files.stageImport('canvas-contract-import');
      await staged.publish(record('canvas-contract-import', 'Imported Space'));

      await expect(
        staged.publish(record('canvas-contract-import', 'Imported Space')),
      ).rejects.toThrow();
    });

    it('discards a staged import that was never published', async () => {
      const { files, exists, writeFile } = await open();
      const staged = await files.stageImport('canvas-contract-discard');
      writeFile(staged.directory, 'nodes/seed.md', 'body');

      await staged.discard();

      expect(exists('canvas-contract-discard', 'nodes/seed.md')).toBe(false);
    });

    it('maps a materialized node file back to its record', async () => {
      const { files } = await open();
      const scope = files.space('canvas-contract-a');

      // Only node files carry a record. Everything else in a Space is an
      // ordinary file the app happens to keep there.
      await expect(scope.nodeIdForPath('setting/user.md')).resolves.toBeNull();
      await expect(scope.nodeIdForPath('nodes/deep/x.md')).resolves.toBeNull();
      await expect(scope.nodeIdForPath('nodes/not-markdown')).resolves.toBe(
        null,
      );
    });

    it('unregisters a handle owner without disturbing the others', async () => {
      const { files } = await open();
      const scope = files.space('canvas-contract-a');
      const owner = { release: () => {}, reacquire: () => {} };

      const unregister = scope.registerHandleOwner(owner);

      expect(typeof unregister).toBe('function');
      expect(() => {
        unregister();
        unregister();
      }).not.toThrow();
    });

    it('fences a retained scope after the Workspace changes', async () => {
      const { files, switchWorkspace } = await open();
      const scope = files.space('canvas-contract-a');
      switchWorkspace();

      expect(() => scope.directory()).toThrow('inactive workspace');
      expect(() => scope.nodesDirectory()).toThrow('inactive workspace');
      await expect(files.stageImport('canvas-contract-import')).rejects.toThrow(
        /inactive [Ww]orkspace/,
      );
    });
  });
}
