// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { migrateLegacyDesktopWorkspaceStore } from './legacy-desktop-workspace-store.js';
import {
  DiskWorkspaceRepository,
  WORKSPACE_MANIFEST_FILENAME,
  workspaceIdentityOnDisk,
} from './storage/backends/disk/workspace-repository.js';

describe('deprecated desktop Workspace store migration', () => {
  const roots: string[] = [];

  function tempDir(prefix: string): string {
    const root = mkdtempSync(path.join(tmpdir(), prefix));
    roots.push(root);
    return root;
  }

  /** A data dir plus the registry path the Disk backend would derive in it. */
  function harness(prefix: string): {
    dataDir: string;
    legacyFile: string;
    repository: DiskWorkspaceRepository;
  } {
    const dataDir = tempDir(prefix);
    return {
      dataDir,
      legacyFile: path.join(dataDir, 'workspace.json'),
      repository: new DiskWorkspaceRepository(
        path.join(dataDir, 'storage', 'disk', 'workspaces.json'),
      ),
    };
  }

  function writeLegacyStore(legacyFile: string, contents: unknown): void {
    writeFileSync(legacyFile, JSON.stringify(contents), 'utf8');
  }

  function importInto(
    legacyFile: string,
    repository: DiskWorkspaceRepository,
  ): void {
    migrateLegacyDesktopWorkspaceStore(legacyFile, {
      hasWorkspaceRegistry: () => repository.hasDurableRegistry(),
      adoptWorkspaceDirectory: (workspacePath) =>
        repository.adopt(workspacePath),
      workspaceIdentityOnDisk,
    });
  }

  async function registeredPaths(
    repository: DiskWorkspaceRepository,
  ): Promise<(string | null)[]> {
    const listed = await repository.list();
    return listed.map((workspace) =>
      repository.directoryOf(workspace.workspaceId),
    );
  }

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  describe('what it imports', () => {
    it('imports the legacy active path and recents in MRU order', async () => {
      const { legacyFile, repository } = harness('huabu-legacy-store-data-');
      const first = tempDir('huabu-legacy-store-first-');
      const second = tempDir('huabu-legacy-store-second-');
      writeLegacyStore(legacyFile, { path: second, recent: [second, first] });

      importInto(legacyFile, repository);

      await expect(registeredPaths(repository)).resolves.toEqual([
        path.resolve(second),
        path.resolve(first),
      ]);
      expect(
        readFileSync(path.join(first, WORKSPACE_MANIFEST_FILENAME), 'utf8'),
      ).toContain('workspaceId');
    });

    it('orders by a strictly increasing timestamp, not by array position', async () => {
      const { dataDir, legacyFile, repository } = harness(
        'huabu-legacy-store-stamps-',
      );
      const older = tempDir('huabu-legacy-store-older-');
      const newer = tempDir('huabu-legacy-store-newer-');
      writeLegacyStore(legacyFile, { path: newer, recent: [newer, older] });

      importInto(legacyFile, repository);

      const registry = JSON.parse(
        readFileSync(
          path.join(dataDir, 'storage', 'disk', 'workspaces.json'),
          'utf8',
        ),
      ) as { workspaces: { workspacePath: string; lastOpenedAt: string }[] };
      // Written oldest-first, so array order is the reverse of the MRU listing.
      // Only the timestamps carry recency.
      expect(registry.workspaces.map((entry) => entry.workspacePath)).toEqual([
        path.resolve(older),
        path.resolve(newer),
      ]);
      const stamps = registry.workspaces.map((entry) =>
        Date.parse(entry.lastOpenedAt),
      );
      expect(stamps[1]).toBeGreaterThan(stamps[0] ?? Number.NaN);
      await expect(registeredPaths(repository)).resolves.toEqual([
        path.resolve(newer),
        path.resolve(older),
      ]);
    });

    it('imports an active path that the recents list never mentioned', async () => {
      const { legacyFile, repository } = harness('huabu-legacy-store-active-');
      const active = tempDir('huabu-legacy-store-active-only-');
      writeLegacyStore(legacyFile, { path: active });

      importInto(legacyFile, repository);

      await expect(registeredPaths(repository)).resolves.toEqual([
        path.resolve(active),
      ]);
    });

    it('imports recents when the legacy store has no active path', async () => {
      const { legacyFile, repository } = harness(
        'huabu-legacy-store-norecent-',
      );
      const only = tempDir('huabu-legacy-store-recent-only-');
      writeLegacyStore(legacyFile, { path: null, recent: [only] });

      importInto(legacyFile, repository);

      await expect(registeredPaths(repository)).resolves.toEqual([
        path.resolve(only),
      ]);
    });

    it('caps the import at six entries', async () => {
      const { legacyFile, repository } = harness('huabu-legacy-store-cap-');
      const recent = Array.from({ length: 8 }, (_unused, index) =>
        tempDir(`huabu-legacy-store-cap-${index}-`),
      );
      writeLegacyStore(legacyFile, { path: recent[0], recent });

      importInto(legacyFile, repository);

      // The six most recent survive; the tail of the legacy list is dropped.
      await expect(registeredPaths(repository)).resolves.toEqual(
        recent.slice(0, 6).map((entry) => path.resolve(entry)),
      );
    });

    it('collapses path spellings that name the same directory', async () => {
      const { legacyFile, repository } = harness('huabu-legacy-store-dupes-');
      const home = tempDir('huabu-legacy-store-duped-');
      writeLegacyStore(legacyFile, {
        path: `${home}${path.sep}`,
        recent: [home, path.join(home, '.', ''), `${home}${path.sep}`],
      });

      importInto(legacyFile, repository);

      await expect(registeredPaths(repository)).resolves.toEqual([
        path.resolve(home),
      ]);
    });

    it('skips entries that are not absolute paths', async () => {
      const { legacyFile, repository } = harness(
        'huabu-legacy-store-relative-',
      );
      writeLegacyStore(legacyFile, {
        path: 'relative/home',
        recent: ['./also-relative', 42, null],
      });

      importInto(legacyFile, repository);

      expect(repository.hasDurableRegistry()).toBe(false);
      await expect(repository.list()).resolves.toEqual([]);
    });

    it('never resolves a relative entry against the Server working directory', () => {
      const { legacyFile, repository } = harness('huabu-legacy-store-cwd-');
      // A relative entry that *would* name a real directory if anything here
      // resolved it against `process.cwd()`. The legacy store was written by
      // the Electron main process, so its relative entries mean nothing to
      // this Server and must never be adopted into its own working directory.
      const relative = '.huabu-legacy-store-cwd-probe';
      const probe = path.join(process.cwd(), relative);
      mkdirSync(probe, { recursive: true });
      roots.push(probe);
      writeLegacyStore(legacyFile, {
        path: relative,
        recent: [`.${path.sep}${relative}`],
      });

      importInto(legacyFile, repository);

      expect(existsSync(path.join(probe, WORKSPACE_MANIFEST_FILENAME))).toBe(
        false,
      );
      expect(repository.hasDurableRegistry()).toBe(false);
    });
  });

  describe('what it refuses to touch', () => {
    it('registers without preparing, leaving only the identity manifest', async () => {
      const { legacyFile, repository } = harness('huabu-legacy-store-inert-');
      const home = tempDir('huabu-legacy-store-untouched-');
      writeLegacyStore(legacyFile, { path: home, recent: [home] });

      importInto(legacyFile, repository);

      // Preparation would have added the world canvas directory and run the
      // whole on-disk migration chain against a Workspace nobody opened.
      expect(readdirSync(home)).toEqual([WORKSPACE_MANIFEST_FILENAME]);
    });

    it('drops remembered paths that are no longer directories on disk', async () => {
      const { dataDir, legacyFile, repository } = harness(
        'huabu-legacy-store-empty-data-',
      );
      const missing = path.join(dataDir, 'deleted-home-folder');
      writeLegacyStore(legacyFile, { path: missing, recent: [missing] });

      importInto(legacyFile, repository);

      // A remembered path is not a request to open a folder: adopting it would
      // have recreated the directory the user deleted.
      expect(existsSync(missing)).toBe(false);
      expect(repository.hasDurableRegistry()).toBe(false);
      await expect(repository.list()).resolves.toEqual([]);
    });

    it('drops a remembered path that now names a file', async () => {
      const { dataDir, legacyFile, repository } = harness(
        'huabu-legacy-store-file-',
      );
      const notADirectory = path.join(dataDir, 'home.txt');
      writeFileSync(notADirectory, 'not a Workspace', 'utf8');
      writeLegacyStore(legacyFile, { path: notADirectory });

      importInto(legacyFile, repository);

      expect(repository.hasDurableRegistry()).toBe(false);
      expect(readFileSync(notADirectory, 'utf8')).toBe('not a Workspace');
    });

    it('follows a symlink that still points at a real directory', async () => {
      const { dataDir, legacyFile, repository } = harness(
        'huabu-legacy-store-symlink-',
      );
      const target = tempDir('huabu-legacy-store-symlink-target-');
      const link = path.join(dataDir, 'home-link');
      symlinkSync(target, link, 'dir');
      writeLegacyStore(legacyFile, { path: link });

      importInto(legacyFile, repository);

      await expect(registeredPaths(repository)).resolves.toEqual([
        path.resolve(link),
      ]);
    });

    it('ignores the deprecated file once workspaces.json exists', async () => {
      const { legacyFile, repository } = harness(
        'huabu-legacy-store-existing-data-',
      );
      const existing = tempDir('huabu-legacy-store-existing-');
      const legacy = tempDir('huabu-legacy-store-ignored-');
      writeLegacyStore(legacyFile, { path: legacy, recent: [legacy] });
      const registered = repository.adopt(existing);
      const adoptWorkspaceDirectory = vi.fn((workspacePath: string) => {
        repository.adopt(workspacePath);
      });

      migrateLegacyDesktopWorkspaceStore(legacyFile, {
        hasWorkspaceRegistry: () => repository.hasDurableRegistry(),
        adoptWorkspaceDirectory,
        workspaceIdentityOnDisk,
      });

      expect(adoptWorkspaceDirectory).not.toHaveBeenCalled();
      expect(existsSync(path.join(legacy, WORKSPACE_MANIFEST_FILENAME))).toBe(
        false,
      );
      await expect(repository.list()).resolves.toEqual([registered]);
    });
  });

  describe('when the legacy store is unusable', () => {
    it('stays silent when the deprecated file was never written', async () => {
      const { legacyFile, repository } = harness('huabu-legacy-store-absent-');

      expect(() => importInto(legacyFile, repository)).not.toThrow();

      expect(repository.hasDurableRegistry()).toBe(false);
      await expect(repository.list()).resolves.toEqual([]);
    });

    it('survives a truncated or malformed deprecated file', async () => {
      const { legacyFile, repository } = harness('huabu-legacy-store-broken-');
      writeFileSync(legacyFile, '{"path": "/tmp/hom', 'utf8');

      expect(() => importInto(legacyFile, repository)).not.toThrow();

      expect(repository.hasDurableRegistry()).toBe(false);
    });

    it('survives a deprecated file that is not an object', async () => {
      const { legacyFile, repository } = harness('huabu-legacy-store-scalar-');
      writeLegacyStore(legacyFile, ['/tmp/first']);

      expect(() => importInto(legacyFile, repository)).not.toThrow();

      expect(repository.hasDurableRegistry()).toBe(false);
    });

    it('registers the surviving entries when one of them cannot be adopted', async () => {
      const { legacyFile, repository } = harness(
        'huabu-legacy-store-partial-data-',
      );
      const healthy = tempDir('huabu-legacy-store-healthy-');
      const broken = tempDir('huabu-legacy-store-broken-entry-');
      writeLegacyStore(legacyFile, {
        path: healthy,
        recent: [healthy, broken],
      });

      migrateLegacyDesktopWorkspaceStore(legacyFile, {
        hasWorkspaceRegistry: () => repository.hasDurableRegistry(),
        adoptWorkspaceDirectory: (workspacePath) => {
          if (workspacePath === path.resolve(broken)) {
            throw new Error('copied Workspace identity');
          }
          repository.adopt(workspacePath);
        },
        workspaceIdentityOnDisk,
      });

      await expect(registeredPaths(repository)).resolves.toEqual([
        path.resolve(healthy),
      ]);
    });

    it('imports nothing when the deprecated store had nothing to remember', async () => {
      const { legacyFile, repository } = harness('huabu-legacy-store-blank-');
      writeLegacyStore(legacyFile, { path: null, recent: [] });

      importInto(legacyFile, repository);

      expect(repository.hasDurableRegistry()).toBe(false);
    });
  });
});
