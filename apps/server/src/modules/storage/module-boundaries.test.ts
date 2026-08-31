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
 * What this is **not**: evidence that every read capability is portable. The
 * compatibility facade and two root forwarding shims still serve explicit
 * Disk-only/read paths. This asserts that the portable write boundary and
 * dependency direction stay intact while that remaining list only shrinks.
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

function inLayer(relative: string, layer: string): boolean {
  return relative.startsWith(`modules/storage/${layer}/`);
}

describe('storage module tree', () => {
  it('keeps only the barrel, composition, and the two shims at the root', () => {
    const rootFiles = storageFiles
      .filter((f) => path.dirname(f) === 'modules/storage')
      .map((f) => path.basename(f));

    expect(rootFiles.sort()).toEqual([
      'canvas-dirs.ts',
      'index.ts',
      'module-boundaries.test.ts',
      'paths.ts',
      'profile.test.ts',
      'profile.ts',
      'space-lifecycle-admission.ts',
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
      // Same exemption, and the same reason, as the composition-root rule
      // below: exercising an adapter means naming it. A production file that
      // names one has bound the application to a backend, which is the thing
      // being prevented; a test that names one is choosing its subject.
      if (file.endsWith('.test.ts')) continue;
      for (const spec of specifiersOf(file)) {
        const target = resolveSpecifier(file, spec);
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
    // `storage.ts` selects the backend. The rest reach a *named* Disk module
    // because the Disk layout and its directory index moved inside the
    // boundary in Phase 4.5 (§12.5.2): the barrel re-exports the Disk World
    // helpers, the two shims forward Disk-capability imports, and the
    // compatibility facade is Disk-coupled by construction. Each entry
    // disappears as its consumers move onto ports and the materialization
    // capability (§12.5.5 step 5).
    expect(nonAdapter).toEqual([
      'modules/storage/canvas-dirs.ts',
      'modules/storage/compatibility/canvas.ts',
      'modules/storage/index.ts',
      'modules/storage/paths.ts',
      'modules/storage/storage.ts',
    ]);
  });
});

/**
 * Phase 4.5's outcome, guarded (proposal §12.5).
 *
 * The workspace module used to hold a `disk/` segment containing the Disk
 * record layout, the `space.json`-derived directory index, and pure naming
 * rules — so "where is a Space" was answered outside the storage boundary, in
 * a module whose name asserted the substrate. These pin the correction: what
 * remains describes the workspace as a place, and anything needing a real
 * Space directory asks for it by capability.
 */
describe('workspace module names no backend', () => {
  const workspaceFiles = sourceFiles.filter((f) =>
    /^modules\/workspace(?:[./-])/.test(f),
  );

  it('has no substrate segment', () => {
    const substrate = workspaceFiles.filter((f) =>
      f.startsWith('modules/workspace/disk/'),
    );
    expect(substrate).toEqual([]);
    expect(workspaceFiles.length).toBeGreaterThan(0);
  });

  it('never imports a storage backend', () => {
    const violations: string[] = [];
    for (const file of workspaceFiles) {
      for (const spec of specifiersOf(file)) {
        const target = resolveSpecifier(file, spec);
        if (target?.includes('modules/storage/backends')) {
          violations.push(`${file} → ${spec}`);
        }
      }
    }
    // A Space's directory comes from `spaceDirectory()` on the facade, which
    // is the capability; reaching a backend for it would restore exactly the
    // coupling this phase removed.
    expect(violations).toEqual([]);
  });

  it('names no Disk record or blob layout symbol', () => {
    // These are the members that moved to `backends/disk/layout.ts`. Their
    // reappearance here would mean the workspace had started describing how a
    // backend stores things again, whatever the import path said.
    const DISK_LAYOUT = [
      'SPACE_JSON_FILENAME',
      'WORLD_CANVAS_DIR_NAME',
      'canvasJsonPath',
      'nodesDir',
      'nodeFilePath',
      'ARTIFACTS_DIR_NAME',
      'artifactsDir',
      'artifactPath',
      'HISTORY_DIR_NAME',
      'historyDir',
      'chatDir',
      'tasksPath',
      'eventsPath',
      'deltaLogPath',
      'changesPath',
      'canvasRoot',
    ];
    const violations: string[] = [];
    for (const file of workspaceFiles) {
      if (file.startsWith('modules/workspace/migrations/')) continue;
      const source = read(file);
      for (const symbol of DISK_LAYOUT) {
        if (new RegExp(`\\b${symbol}\\b`).test(source)) {
          violations.push(`${file} → ${symbol}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

/**
 * The Disk Space directory, fenced by name and by census (proposal §12.6.2).
 *
 * `diskTree` is not a port and is not portable: a backend that keeps Spaces in
 * tables has no directory, and the member is typed by that absence. What keeps
 * an unportable capability from reading as a portable one is not where it
 * hangs — it is on the Space handle, beside everything else about a Space —
 * but its name and the fact that every consumer is written down here.
 *
 * This list may shrink and must not grow. Each entry is a family §6.4.3
 * assigns a disposition: the **A** families stay and become capability-matrix
 * rows, and the rest leave as they move onto a port.
 */
describe('Disk Space tree capability', () => {
  const EXPECTED_CONSUMERS = [
    // A — the built-in file tools' sandbox root.
    'modules/agent/tools/handlers/fs-sandbox.ts',
    // A — bundle export.
    'modules/canvas/canvas.route.ts',
    // A — external-note claim.
    'modules/canvas/external.route.ts',
    // C — the resurrection guard, which disappears with the substrate.
    'modules/agent/memory/trigger.ts',
    // B, deferred — RFS's sidecar-to-record mapping. Portable in principle,
    // Disk's in practice until a second backend has a file plane at all.
    'modules/remote_fs/node-meta.ts',
    // D — the per-Space RFS access guide, headed for a blob.
    'modules/remote_fs/skill.ts',
    // C and D — memory files, the debug prompt log, ACP session state.
    'modules/workspace/paths.ts',
  ].sort();

  it('keeps the exact production consumer census', () => {
    // Matched as a bare word, not as `.diskTree`: destructuring the member
    // off a handle (`const { diskTree } = space(id)`) or reaching it by
    // subscript reads it just as effectively, and a census a consumer can
    // leave by changing its spelling is not a census.
    const consumers = sourceFiles
      .filter((file) => !file.startsWith('modules/storage/'))
      .filter((file) => !file.endsWith('.test.ts'))
      .filter((file) => /\bdiskTree\b/.test(read(file)));

    expect(consumers.sort()).toEqual(EXPECTED_CONSUMERS);
  });

  it('exposes no portable path accessor from the barrel', () => {
    const barrel = read('modules/storage/index.ts');

    // A Space's directory is reachable only through the Disk-named member on
    // the Space handle. A free `spaceDirectory()`-shaped export would read as
    // something every backend answers, which is the claim being prevented.
    expect(barrel).not.toMatch(/\bspaceDirectory\b/);
    expect(barrel).toMatch(/\bDiskSpaceTree\b/);
  });

  it('names Disk at the type, so a consumer cannot mistake it for a port', () => {
    const tree = read('modules/storage/backends/disk/space-tree.ts');

    expect(tree).toMatch(/export interface DiskSpaceTree/);
    // Living under `backends/disk/` is what the `ports/` census already
    // guarantees; this states the intent the file exists to carry.
    expect(tree).toMatch(/not a port/i);
  });
});

/**
 * The neutrality half of the exit criterion, at the import level (proposal
 * §12.7, §12.8).
 *
 * The `workspace module names no backend` group above pinned Phase 4.5's
 * correction for one module. The criterion is wider: **no** production module
 * outside `storage/` may name how a backend stores a Space, because that is
 * exactly the knowledge a second adapter would have to re-satisfy.
 *
 * Migrations are exempt — they rewrite frozen historical on-disk shapes, which
 * is the one legitimate reason to know a layout that is no longer current.
 * Tests are exempt for the same reason they may name an adapter: a test that
 * names one is choosing its subject.
 */
describe('no production module outside storage names a Disk layout', () => {
  /** Members of `backends/disk/layout.ts` and the Disk directory index. */
  const DISK_LAYOUT = [
    'SPACE_JSON_FILENAME',
    'WORLD_CANVAS_DIR_NAME',
    'canvasJsonPath',
    'nodesDir',
    'nodeFilePath',
    'ARTIFACTS_DIR_NAME',
    'artifactsDir',
    'artifactPath',
    'HISTORY_DIR_NAME',
    'historyDir',
    'chatDir',
    'tasksPath',
    'eventsPath',
    'deltaLogPath',
    'changesPath',
    'canvasRoot',
    'suggestCanvasDir',
    'registerCanvasDir',
    'renameCanvasDirOnDisk',
  ];

  it('imports no Disk layout symbol', () => {
    const violations: string[] = [];
    for (const file of sourceFiles) {
      if (file.startsWith('modules/storage/')) continue;
      if (file.endsWith('.test.ts')) continue;
      if (file.startsWith('modules/workspace/migrations/')) continue;

      // Import-level, deliberately: a local variable that happens to be
      // called `artifactPath` is not a violation, while importing the symbol
      // is. The check is about where knowledge comes from, not vocabulary.
      const source = read(file);
      const imported = new Set<string>();
      for (const match of source.matchAll(
        /import\s*(?:type\s*)?\{([^}]*)\}\s*from/g,
      )) {
        for (const raw of match[1].split(',')) {
          const name = raw
            .trim()
            .replace(/^type\s+/, '')
            .split(/\s+as\s+/)[0];
          if (name) imported.add(name.trim());
        }
      }
      for (const symbol of DISK_LAYOUT) {
        if (imported.has(symbol)) violations.push(`${file} → ${symbol}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('rejects a production import of the legacy CanvasStore', () => {
    const violations = sourceFiles
      .filter((file) => !file.startsWith('modules/storage/'))
      .filter((file) => !file.endsWith('.test.ts'))
      .filter((file) =>
        specifiersOf(file).some((spec) => {
          const target = resolveSpecifier(file, spec);
          return target?.includes('legacy/canvas-store') === true;
        }),
      );

    // The root forwarding shim that used to make this reachable had no
    // importers left and was deleted; this keeps the path closed.
    expect(violations).toEqual([]);
  });

  /**
   * The path check above only sees a direct import. The barrel still
   * re-exports the legacy store for the compatibility layer and the Disk
   * suites, so a production file can reach the same object by name without
   * ever naming its file — which is how one reader survived the migration.
   */
  it('rejects a production import of a legacy CanvasStore symbol', () => {
    // Readers only. `resetStorageCache` is on the barrel too and the
    // Workspace routes still call it, but it reads nothing — it is the
    // activation lifecycle dropping an adapter's caches, which is a
    // composition concern with its own home to find (§12.8), not a
    // production module learning how a Space is stored.
    const LEGACY_STORE_SYMBOLS = [
      'CanvasStore',
      'getCanvasStore',
      'forgetCanvasStore',
    ];
    const violations: string[] = [];
    for (const file of sourceFiles) {
      if (file.startsWith('modules/storage/')) continue;
      if (file.endsWith('.test.ts')) continue;

      const source = read(file);
      for (const match of source.matchAll(
        /import\s*(?:type\s*)?\{([^}]*)\}\s*from/g,
      )) {
        for (const raw of match[1].split(',')) {
          const name = raw
            .trim()
            .replace(/^type\s+/, '')
            .split(/\s+as\s+/)[0]
            .trim();
          if (LEGACY_STORE_SYMBOLS.includes(name)) {
            violations.push(`${file} → ${name}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

describe('structured write authority', () => {
  it('does not expose compatibility create/delete writers from the public barrel', () => {
    expect(read('modules/storage/index.ts')).not.toMatch(
      /\b(?:createCanvas|deleteCanvas)\b/,
    );
  });

  it('does not import the compatibility layer from production application code', () => {
    const violations: string[] = [];
    for (const file of sourceFiles) {
      if (file.endsWith('.test.ts') || file.startsWith('modules/storage/')) {
        continue;
      }
      for (const spec of specifiersOf(file)) {
        const target = resolveSpecifier(file, spec);
        if (target?.includes('modules/storage/compatibility')) {
          violations.push(`${file} → ${spec}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('keeps legacy CanvasStore mutations inside the Disk adapter and compatibility layer', () => {
    const unambiguousMutation =
      /\.\s*(?:writeNode|deleteNode|renameSelf|destroy|appendDeltaLogEntry|appendEvents|appendChanges|removeChange|upsertIntent)\s*\(/;
    const callsLegacyMutation = (source: string): boolean => {
      if (unambiguousMutation.test(source)) return true;
      if (/getCanvasStore\s*\([^)]*\)\s*\.\s*write\s*\(/.test(source)) {
        return true;
      }
      for (const match of source.matchAll(
        /\b([A-Za-z_$][\w$]*)\s*=\s*getCanvasStore\s*\(/g,
      )) {
        const identifier = match[1].replace(/[$]/g, '\\$&');
        if (
          new RegExp(`\\b${identifier}\\s*\\.\\s*write\\s*\\(`).test(source)
        ) {
          return true;
        }
      }
      return false;
    };
    const violations = sourceFiles
      .filter((file) => !file.endsWith('.test.ts'))
      .filter((file) => !inLayer(file, 'backends'))
      .filter((file) => !inLayer(file, 'compatibility'))
      .filter((file) => callsLegacyMutation(read(file)));

    expect(violations).toEqual([]);
  });
});

describe('root forwarding shims', () => {
  const SHIMS = ['modules/storage/canvas-dirs.ts', 'modules/storage/paths.ts'];

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

  /** Exact snapshot of the remaining deprecated-path importers. */
  const EXPECTED_IMPORTERS: Record<string, readonly string[]> = {
    'storage/canvas-dirs.js': [
      'modules/agent/tools/world-target-read.test.ts',
      'modules/canvas/canvas-command-router.test.ts',
      'modules/canvas/canvas.route.ts',
      'modules/canvas/external-watcher.test.ts',
      'modules/canvas/external-watcher.ts',
      'modules/canvas/world-portal-policy.ts',
      'modules/canvas/world-portals.test.ts',
      'modules/canvas/world-reference-resolver.test.ts',
      'modules/workspace.ts',
    ],
    'storage/paths.js': [
      'modules/canvas/canvas-content-cas.test.ts',
      'modules/canvas/canvas.route.test.ts',
      // The one production importer left is a migration, which rewrites a
      // frozen historical on-disk shape and is exempt by construction.
      'modules/workspace/migrations/migrate-acp-sessions.ts',
    ],
  };

  it.each(Object.keys(EXPECTED_IMPORTERS))(
    'keeps the exact importer snapshot for %s',
    (shimPath) => {
      const importers = sourceFiles
        .filter((file) => !file.startsWith('modules/storage/'))
        .filter((file) =>
          specifiersOf(file).some((spec) => spec.endsWith(`/${shimPath}`)),
        )
        .sort();

      expect(importers).toEqual(EXPECTED_IMPORTERS[shimPath]);
    },
  );
});
