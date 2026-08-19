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
 * compatibility facade and three root forwarding shims still serve explicit
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

/**
 * Names a file imports, whatever they are imported from.
 *
 * Import-level rather than identifier-level on purpose: a module is coupled
 * to the Disk layout when it *brings in* `canvasRoot`, not when it happens to
 * name a local variable `artifactPath`.
 */
function importedNames(relative: string): string[] {
  const source = read(relative);
  const out: string[] = [];
  const re = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"][^'"]+['"]/gs;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    for (const clause of match[1].split(',')) {
      const name = clause
        .trim()
        .split(/\s+as\s+/)[0]
        ?.replace(/^type\s+/, '');
      if (name) out.push(name.trim());
    }
  }
  return out;
}

/**
 * The members that describe how the Disk backend stores a Space.
 *
 * They moved to `backends/disk/layout.ts` in Phase 4.5. Nothing outside the
 * storage boundary may name them: each one answers "how does *this* backend
 * store that", so a consumer holding one has bound the application to Disk.
 */
const DISK_LAYOUT_SYMBOLS = [
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

const storageFiles = walk(STORAGE_DIR);
const sourceFiles = walk(SRC_DIR);

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
      'product-boundary.test.ts',
      'profile.test.ts',
      'profile.ts',
      'space-lifecycle-admission.ts',
      'storage.ts',
      'testing.ts',
    ]);
  });

  /**
   * The settled architecture is **two** backend ports (§6.3, and the
   * proposal's own scope note). A third file appearing here would be a
   * third port, which is an architectural decision rather than an
   * implementation detail — so it has to be made deliberately, by editing
   * this list, and not by someone finding `ports/` a convenient place to put
   * an interface.
   *
   * Space directories are the case that already tried. They are not portable
   * and must not be made to look it: a backend keeping Spaces in tables has
   * no directory to offer. They stay a named Disk capability instead — see
   * the exported-surface guard below.
   */
  it('keeps ports/ to exactly the two backend ports', () => {
    const portFiles = storageFiles
      .filter((f) => path.dirname(f) === 'modules/storage/ports')
      .map((f) => path.basename(f));

    expect(portFiles.sort()).toEqual(['blob.ts', 'common.ts', 'structured.ts']);
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

  // Stricter than the import-level rule that covers every other module:
  // here even *naming* one of these is a violation, because this is the
  // module the layout was extracted from and a re-implementation under a
  // local name would restore the same coupling with a clean import list.
  it('names no Disk record or blob layout symbol', () => {
    const violations: string[] = [];
    for (const file of workspaceFiles) {
      if (file.startsWith('modules/workspace/migrations/')) continue;
      const source = read(file);
      for (const symbol of DISK_LAYOUT_SYMBOLS) {
        if (new RegExp(`\\b${symbol}\\b`).test(source)) {
          violations.push(`${file} → ${symbol}`);
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

/**
 * The Disk-only surface, held to an exact list.
 *
 * Some features still reach a Space as a filesystem tree — RFS, the
 * external-note watcher, the file-tool sandbox, and the agent domain's
 * `.memory/` and ACP files. That is not portable and the barrel does not
 * pretend otherwise: it exports `diskSpaceTree` / `stageDiskSpaceImport`,
 * whose names say so at every call site.
 *
 * Both lists below are snapshots so they can only shrink. Every consumer is a
 * reason a non-Disk structured profile is not selectable; the route out is
 * for these features to stop needing a tree (an agent can reach a Space over
 * the HTTP API instead of a projected filesystem), not for storage to promise
 * one it cannot keep.
 */
describe('Disk-only surface', () => {
  it('exposes no portable path capability from the barrel', () => {
    const barrel = read('modules/storage/index.ts');

    // Anything named for a Space's files without `disk` in it reads as a
    // promise every backend keeps. There is no such promise.
    expect(barrel).not.toMatch(/\bSpaceMaterialization\b/);
    expect(barrel).not.toMatch(/\bMaterializationKind\b/);
    expect(barrel).not.toMatch(/\bspaceDirectory\b/);
    expect(barrel).not.toMatch(/\bgetSpaceFiles\b/);
  });

  it('keeps the exact Disk-only export list', () => {
    const barrel = read('modules/storage/index.ts');
    const diskExports = [...barrel.matchAll(/\bdisk[A-Z]\w*|\bstageDisk\w*/g)]
      .map((m) => m[0])
      .filter((name, index, all) => all.indexOf(name) === index)
      .sort();

    expect(diskExports).toEqual(['diskSpaceTree', 'stageDiskSpaceImport']);
  });

  it('keeps the exact list of files that need a Space directory', () => {
    const consumers = sourceFiles
      .filter((file) => !file.startsWith('modules/storage/'))
      .filter((file) =>
        /\b(?:diskSpaceTree|stageDiskSpaceImport)\b/.test(read(file)),
      )
      .sort();

    expect(consumers).toEqual([
      'modules/agent/memory/trigger.ts',
      'modules/agent/tools/handlers/fs-sandbox.ts',
      'modules/canvas/canvas.route.ts',
      'modules/canvas/external-watcher.test.ts',
      'modules/canvas/external-watcher.ts',
      'modules/canvas/external.route.ts',
      'modules/canvas/import-node-src.test.ts',
      'modules/canvas/import-node-src.ts',
      'modules/remote_fs/node-meta.ts',
      'modules/remote_fs/rfs.route.test.ts',
      'modules/remote_fs/skill.ts',
      'modules/workspace/legacy-workspace-activation.test.ts',
      'modules/workspace/paths.ts',
    ]);
  });
});

describe('backend-neutral production reads', () => {
  /**
   * §12.6.4's second guard, at the scope the phase claimed: *no* production
   * module outside `storage/` imports a Disk-layout symbol, not merely the
   * workspace module.
   *
   * Two exemptions, both the same ones the sibling rules make. A migration
   * rewrites a frozen historical on-disk shape, so it is Disk-bound by
   * definition and cannot be expressed against a port. A test that names the
   * layout is choosing its subject rather than binding the application to it
   * — and the shim-importer snapshots below already pin which tests those
   * are, so they cannot grow unnoticed.
   */
  it('does not import a Disk-layout symbol outside the storage boundary', () => {
    const violations: string[] = [];
    for (const file of sourceFiles) {
      if (file.startsWith('modules/storage/')) continue;
      if (file.startsWith('modules/workspace/migrations/')) continue;
      if (file.endsWith('.test.ts')) continue;
      for (const name of importedNames(file)) {
        if (DISK_LAYOUT_SYMBOLS.includes(name)) {
          violations.push(`${file} → ${name}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('does not import CanvasStore or getCanvasStore from the public barrel', () => {
    const legacyReadImport =
      /import\s+(?:type\s+)?\{[^}]*\b(?:CanvasStore|getCanvasStore)\b[^}]*\}\s+from\s+['"][^'"]*storage\/index\.js['"]/s;
    const violations = sourceFiles
      .filter((file) => !file.endsWith('.test.ts'))
      .filter((file) => !file.startsWith('modules/storage/'))
      .filter((file) => legacyReadImport.test(read(file)));

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

  /** Exact snapshot of the remaining deprecated-path importers. */
  const EXPECTED_IMPORTERS: Record<string, readonly string[]> = {
    'storage/canvas-store.js': [],
    'storage/canvas-dirs.js': [
      'modules/agent/tools/world-target-read.test.ts',
      'modules/canvas/canvas-command-router.test.ts',
      'modules/canvas/external-watcher.test.ts',
      'modules/canvas/world-portals.test.ts',
      'modules/canvas/world-reference-resolver.test.ts',
    ],
    'storage/paths.js': [
      'modules/canvas/canvas-content-cas.test.ts',
      'modules/canvas/canvas.route.test.ts',
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
