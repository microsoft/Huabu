// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Module-boundary guard for `storage/`.
 *
 * Enforces the canonical tree and dependency direction from
 * docs/proposals/multi-backend-storage.md §12.2.1 by reading the source
 * files, so the shape survives contact with the next person who needs "just
 * one import".
 *
 * What this is **not**: evidence that every application capability is
 * backend-neutral. Physical RFS, import/export, watchers, and other Disk-only
 * flows still use the compatibility facade, and the three root forwarding
 * shims still have importers. This asserts that the layering and single
 * structured-write authority stay intact while that compatibility surface
 * shrinks.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STORAGE_DIR = HERE;
const SRC_DIR = path.resolve(HERE, '../..');

/** Every `.ts` file under `dir`, as paths relative to `SRC_DIR`. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (entry.endsWith('.ts')) {
      out.push(path.relative(SRC_DIR, full));
    }
  }
  return out.sort();
}

function read(relative: string): string {
  return readFileSync(path.join(SRC_DIR, relative), 'utf8');
}

/**
 * Module specifiers imported or re-exported by a source file.
 *
 * `vi.mock`/`vi.doMock` targets count as references: mocking a module reaches
 * into it just as much as importing it does, and a test that mocks a
 * deprecated shim is exactly the new call site the shims exist to stop.
 */
function specifiersOf(relative: string): string[] {
  const source = read(relative);
  const out: string[] = [];
  const re =
    /(?:from|import|vi\s*\.\s*(?:mock|doMock|unmock|doUnmock))\s*\(?\s*['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) out.push(match[1]);
  return out;
}

/**
 * Resolve a relative specifier against its importer, as a `SRC_DIR`-relative
 * path with the `.js` suffix stripped. Bare package specifiers return null.
 */
function resolveSpecifier(fromRelative: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const resolved = path.join(path.dirname(fromRelative), spec);
  return resolved.replace(/\.js$/, '');
}

const storageFiles = walk(STORAGE_DIR);
const sourceFiles = walk(SRC_DIR);

// Workspace activation must recover an interrupted Disk commit before any
// migration reads or writes that Workspace. This is the sole application →
// adapter exception; every ordinary storage consumer still crosses a port.
const WORKSPACE_RECOVERY_IMPORT =
  'modules/storage/backends/disk/transaction-journal';

function inLayer(relative: string, layer: string): boolean {
  return relative.startsWith(`modules/storage/${layer}/`);
}

describe('storage module tree', () => {
  it('keeps only the barrel, composition, and the three shims at the root', () => {
    const rootFiles = storageFiles
      .filter((f) => path.dirname(f) === 'modules/storage')
      .map((f) => path.basename(f));

    expect(rootFiles.sort()).toEqual([
      'canvas-dirs.ts',
      'canvas-store.ts',
      'index.ts',
      'module-boundaries.test.ts',
      'paths.ts',
      'profile.test.ts',
      'profile.ts',
      'storage.ts',
    ]);
  });

  it('keeps every other file inside ports/, backends/, or compatibility/', () => {
    const nested = storageFiles.filter(
      (f) => path.dirname(f) !== 'modules/storage',
    );
    const stray = nested.filter(
      (f) =>
        !inLayer(f, 'ports') &&
        !inLayer(f, 'backends') &&
        !inLayer(f, 'compatibility'),
    );
    expect(stray).toEqual([]);
  });

  it('keeps every backend under a named backend directory', () => {
    const backendFiles = storageFiles.filter((f) => inLayer(f, 'backends'));
    // `backends/<kind>/…` — a file directly in `backends/` would be a backend
    // with no named backend, which is how the pre-Phase-2 layout drifted.
    const unscoped = backendFiles.filter(
      (f) => path.dirname(f) === 'modules/storage/backends',
    );
    expect(unscoped).toEqual([]);
    expect(backendFiles.length).toBeGreaterThan(0);
  });
});

describe('storage dependency direction', () => {
  it('never imports a backend or the compatibility layer from ports/', () => {
    const violations: string[] = [];
    for (const file of storageFiles.filter((f) => inLayer(f, 'ports'))) {
      for (const spec of specifiersOf(file)) {
        const target = resolveSpecifier(file, spec);
        if (!target) continue;
        if (
          target.includes('modules/storage/backends') ||
          target.includes('modules/storage/compatibility')
        ) {
          violations.push(`${file} → ${spec}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('never imports the compatibility layer from an adapter', () => {
    const violations: string[] = [];
    for (const file of storageFiles.filter((f) => inLayer(f, 'backends'))) {
      for (const spec of specifiersOf(file)) {
        const target = resolveSpecifier(file, spec);
        if (target?.includes('modules/storage/compatibility')) {
          violations.push(`${file} → ${spec}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('reaches backends/ only from the storage module itself', () => {
    const violations: string[] = [];
    for (const file of sourceFiles) {
      if (file.startsWith('modules/storage/')) continue;
      for (const spec of specifiersOf(file)) {
        const target = resolveSpecifier(file, spec);
        if (
          file === 'modules/workspace-prepare.ts' &&
          target === WORKSPACE_RECOVERY_IMPORT
        ) {
          continue;
        }
        if (target?.includes('modules/storage/backends')) {
          violations.push(`${file} → ${spec}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('selects a backend only in the composition root', () => {
    const importers = storageFiles
      // Tests construct adapters directly — that is how an adapter gets
      // exercised. The rule is about production source: one place decides
      // which backend the process runs.
      .filter((f) => !f.endsWith('.test.ts'))
      .filter((file) =>
        specifiersOf(file).some((spec) => {
          const target = resolveSpecifier(file, spec);
          return (
            target?.includes('modules/storage/backends') &&
            // The legacy class and its cache are the adapters' own internals,
            // and the compatibility facade is allowed to delegate to them.
            !target.includes('backends/disk/legacy')
          );
        }),
      );

    const nonAdapter = importers.filter((f) => !inLayer(f, 'backends'));
    expect(nonAdapter).toEqual(['modules/storage/storage.ts']);
  });
});

describe('single structured write authority', () => {
  it('keeps legacy CanvasStore mutation methods inside the Disk adapter', () => {
    const legacyMutation =
      /\.(?:writeNode|deleteNode|renameSelf|appendDeltaLogEntry|appendChanges|removeChange|appendEvents|upsertIntent)\s*\(/;
    const violations = sourceFiles
      .filter((file) => !file.endsWith('.test.ts'))
      .filter((file) => !file.startsWith('modules/storage/backends/disk/'))
      .filter((file) => legacyMutation.test(read(file)));

    expect(violations).toEqual([]);
  });
});

describe('root forwarding shims', () => {
  const SHIMS = [
    'modules/storage/canvas-store.ts',
    'modules/storage/canvas-dirs.ts',
    'modules/storage/paths.ts',
  ];

  it.each(SHIMS)('%s contains no logic', (shim) => {
    const body = read(shim)
      // Strip the license header, the block comment header, and blank lines.
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('//'));

    // A forwarder is exactly one re-export and nothing else. Anything with a
    // declaration or a statement has stopped being a forwarder.
    expect(body).toHaveLength(1);
    expect(body[0]).toMatch(/^export \* from '\.[^']+\.js';$/);
  });

  /**
   * Frozen snapshot of the call sites that already imported these paths when
   * the shims were installed. The lists may shrink as consumers migrate;
   * a new entry means someone added an importer of a deprecated path, which
   * is what the shims exist to stop.
   */
  const ALLOWED_IMPORTERS: Record<string, readonly string[]> = {
    'storage/canvas-store.js': [
      'modules/agent/sketch.service.ts',
      'modules/canvas/canvas-search.test.ts',
      'modules/canvas/canvas-search.ts',
      'modules/canvas/canvas-spatial.ts',
      'modules/canvas/canvas.route.ts',
      'modules/canvas/node-prompt.test.ts',
      'modules/canvas/node-prompt.ts',
      'modules/canvas/world-reference-resolver.ts',
      'modules/canvas/world-target-access.ts',
      'modules/preprocessing/pipeline.test.ts',
      'modules/preprocessing/pipeline.ts',
      'modules/preprocessing/stages/cache-check.ts',
      'modules/preprocessing/stages/persist.ts',
    ],
    'storage/canvas-dirs.js': [
      'modules/agent/tools/world-target-read.test.ts',
      'modules/canvas/canvas-command-router.test.ts',
      'modules/canvas/canvas-command-router.ts',
      'modules/canvas/canvas.route.ts',
      'modules/canvas/external-watcher.test.ts',
      'modules/canvas/external-watcher.ts',
      'modules/canvas/world-portal-policy.ts',
      'modules/canvas/world-portals.test.ts',
      'modules/canvas/world-portals.ts',
      'modules/canvas/world-reference-resolver.test.ts',
      'modules/canvas/world-reference-resolver.ts',
      'modules/canvas/world-target-access.ts',
      'modules/workspace.ts',
    ],
    'storage/paths.js': [
      'modules/agent/acp/service.ts',
      'modules/agent/acp/threads.route.ts',
      'modules/agent/agent.route.ts',
      'modules/agent/agent.service.ts',
      'modules/agent/conversation/prompt/debug-prompt.ts',
      'modules/agent/memory/analyzer.ts',
      'modules/agent/memory/read.ts',
      'modules/agent/memory/sandbox.ts',
      'modules/agent/memory/trigger.ts',
      'modules/agent/skills.route.test.ts',
      'modules/agent/tools/handlers/fs-sandbox.ts',
      'modules/agent/tools/handlers/fs-write.test.ts',
      'modules/agent/tools/handlers/fs-write.ts',
      'modules/canvas/canvas-search.test.ts',
      'modules/canvas/canvas-search.ts',
      'modules/canvas/canvas.route.ts',
      'modules/canvas/external-watcher.ts',
      'modules/canvas/external.route.ts',
      'modules/canvas/import-node-src.test.ts',
      'modules/canvas/import-node-src.ts',
      'modules/canvas/world-target-access.ts',
      'modules/remote_fs/rfs.route.ts',
      'modules/remote_fs/skill.ts',
      'prompt/skills/loader.ts',
    ],
  };

  it.each(Object.keys(ALLOWED_IMPORTERS))(
    'gains no new importer of %s',
    (shimPath) => {
      const importers = sourceFiles
        .filter((file) => !file.startsWith('modules/storage/'))
        .filter((file) =>
          specifiersOf(file).some((spec) => spec.endsWith(`/${shimPath}`)),
        )
        .sort();

      const added = importers.filter(
        (f) => !ALLOWED_IMPORTERS[shimPath].includes(f),
      );
      expect(added).toEqual([]);
      // Shrinking is the goal, so the snapshot is a ceiling, not an equality.
      expect(importers.length).toBeLessThanOrEqual(
        ALLOWED_IMPORTERS[shimPath].length,
      );
    },
  );
});
