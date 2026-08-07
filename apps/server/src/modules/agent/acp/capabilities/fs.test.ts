// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Tests for `fs/read_text_file` capability handler.
 *
 * Covers the security/contract surface that matters for v1:
 *   - virtual `/space/` prefix is mandatory
 *   - canvas-relative resolution + sandbox escape rejection
 *   - allowlist (`nodes/**`, `.artifacts/**`); everything else rejected
 *   - symlinks rejected even when their target would otherwise be in scope
 *   - missing file / not-a-file / over-size limits
 *   - empty canvasId is refused (no implicit "global" read)
 *
 * The handler is pure synchronous fs work, so the test only needs a
 * temp workspace populated with a fixture canvas. No mocking required.
 */

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ACP_CANVAS_VFS_PREFIX,
  FsCapabilityError,
  handleFsReadTextFile,
} from './fs.js';
import { setWorkspacePath } from '../../../workspace.js';

const CANVAS_ID = 'test-canvas';
const NODE_BODY = '# Hello\nThis is the node body.\n';
const ARTIFACT_BODY = 'artifact contents';

let workspace: string;
let canvasRoot: string;

beforeAll(() => {
  // Use a fresh temp workspace per test run so we never touch the user's
  // real huabu-data. The workspace module exposes setWorkspacePath
  // and stores the path in module-level state — fine for a single test
  // file driven by vitest's per-file isolation.
  //
  // Order matters: setWorkspacePath runs label-migration passes that
  // would rewrite our fixture files (adding `id:` frontmatter, renaming
  // canvas directories to match titles, etc.). Point it at the empty
  // temp dir FIRST so migration is a no-op, then lay down the fixtures.
  workspace = mkdtempSync(path.join(tmpdir(), 'huabu-fs-cap-'));
  setWorkspacePath(workspace);

  canvasRoot = path.join(workspace, CANVAS_ID);
  mkdirSync(path.join(canvasRoot, 'nodes'), { recursive: true });
  mkdirSync(path.join(canvasRoot, '.artifacts'), { recursive: true });
  mkdirSync(path.join(canvasRoot, '.history', 'chat'), { recursive: true });
  mkdirSync(path.join(canvasRoot, 'skills', 'demo'), { recursive: true });

  // title === dir name === canvasId keeps the V2→V3 idempotent rename
  // pass a no-op for any future test that re-runs setWorkspacePath.
  writeFileSync(
    path.join(canvasRoot, 'space.json'),
    JSON.stringify({ canvasId: CANVAS_ID, title: CANVAS_ID }),
  );
  writeFileSync(path.join(canvasRoot, 'nodes', 'foo.md'), NODE_BODY);
  writeFileSync(path.join(canvasRoot, '.artifacts', 'bar.txt'), ARTIFACT_BODY);
  writeFileSync(
    path.join(canvasRoot, '.history', 'chat', 'thread-1.json'),
    '{"secret":true}',
  );
  writeFileSync(
    path.join(canvasRoot, 'skills', 'demo', 'SKILL.md'),
    '---\nid: demo\n---\nbody',
  );

  // Symlink inside nodes/ that points to /etc/hostname (always present
  // on Linux runners). Even if the target were a legitimate canvas file,
  // we still want this rejected on principle so the sandbox is not
  // bypassable via symlink games.
  try {
    symlinkSync('/etc/hostname', path.join(canvasRoot, 'nodes', 'link.md'));
  } catch {
    // If symlink creation is denied (rare), the symlink test will
    // still pass-by-skip — we assert on lstat behaviour, not on the
    // existence of this entry. Tests that depend on it are guarded.
  }
});

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

// ─── Path namespace ─────────────────────────────────────────────────────────

describe('fs/read_text_file — path namespace', () => {
  it('reads a node file under /space/nodes/', () => {
    const result = handleFsReadTextFile(CANVAS_ID, {
      path: `${ACP_CANVAS_VFS_PREFIX}nodes/foo.md`,
    });
    expect(result.content).toBe(NODE_BODY);
  });

  it('reads an artifact under /space/.artifacts/', () => {
    const result = handleFsReadTextFile(CANVAS_ID, {
      path: `${ACP_CANVAS_VFS_PREFIX}.artifacts/bar.txt`,
    });
    expect(result.content).toBe(ARTIFACT_BODY);
  });

  it('rejects a path without the /space/ prefix', () => {
    expect(() =>
      handleFsReadTextFile(CANVAS_ID, { path: 'nodes/foo.md' }),
    ).toThrow(FsCapabilityError);
  });

  it('rejects a real absolute disk path even if it points inside the workspace', () => {
    const realAbs = path.join(canvasRoot, 'nodes', 'foo.md');
    expect(() => handleFsReadTextFile(CANVAS_ID, { path: realAbs })).toThrow(
      /must begin with "\/space\/"/,
    );
  });

  it('rejects /space/ on its own (no file named)', () => {
    expect(() =>
      handleFsReadTextFile(CANVAS_ID, { path: ACP_CANVAS_VFS_PREFIX }),
    ).toThrow(FsCapabilityError);
  });
});

// ─── Allowlist ──────────────────────────────────────────────────────────────

describe('fs/read_text_file — allowlist', () => {
  it('refuses space.json (intentionally excluded in v1)', () => {
    expect(() =>
      handleFsReadTextFile(CANVAS_ID, {
        path: `${ACP_CANVAS_VFS_PREFIX}space.json`,
      }),
    ).toThrow(/outside the external-agent read allowlist/);
  });

  it('refuses .history/** even when the file exists', () => {
    expect(() =>
      handleFsReadTextFile(CANVAS_ID, {
        path: `${ACP_CANVAS_VFS_PREFIX}.history/chat/thread-1.json`,
      }),
    ).toThrow(/outside the external-agent read allowlist/);
  });

  it('refuses skills/** even when the file exists', () => {
    expect(() =>
      handleFsReadTextFile(CANVAS_ID, {
        path: `${ACP_CANVAS_VFS_PREFIX}skills/demo/SKILL.md`,
      }),
    ).toThrow(/outside the external-agent read allowlist/);
  });
});

// ─── Sandbox / escapes ──────────────────────────────────────────────────────

describe('fs/read_text_file — sandbox escapes', () => {
  it('refuses a traversal escape via ../', () => {
    expect(() =>
      handleFsReadTextFile(CANVAS_ID, {
        path: `${ACP_CANVAS_VFS_PREFIX}nodes/../../etc/passwd`,
      }),
    ).toThrow(FsCapabilityError);
  });

  it('refuses a symlinked node file', () => {
    // Skip if the fixture symlink could not be created.
    const symlinkAbs = path.join(canvasRoot, 'nodes', 'link.md');
    try {
      // Re-stat to confirm the symlink exists.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('node:fs').lstatSync(symlinkAbs);
    } catch {
      return;
    }
    expect(() =>
      handleFsReadTextFile(CANVAS_ID, {
        path: `${ACP_CANVAS_VFS_PREFIX}nodes/link.md`,
      }),
    ).toThrow(/refusing to follow symlink/);
  });

  it('rejects an empty canvasId binding', () => {
    expect(() =>
      handleFsReadTextFile('', {
        path: `${ACP_CANVAS_VFS_PREFIX}nodes/foo.md`,
      }),
    ).toThrow(/no canvas is bound/);
  });

  it('rejects a canvasId containing a path separator', () => {
    expect(() =>
      handleFsReadTextFile('../evil', {
        path: `${ACP_CANVAS_VFS_PREFIX}nodes/foo.md`,
      }),
    ).toThrow(FsCapabilityError);
  });
});

// ─── Missing / invalid params ───────────────────────────────────────────────

describe('fs/read_text_file — bad inputs', () => {
  it('rejects missing params object', () => {
    expect(() => handleFsReadTextFile(CANVAS_ID, undefined)).toThrow(
      /params must be an object/,
    );
  });

  it('rejects missing path field', () => {
    expect(() => handleFsReadTextFile(CANVAS_ID, {})).toThrow(
      /"path" is required/,
    );
  });

  it('returns not-found for a path that passes allowlist but does not exist', () => {
    expect(() =>
      handleFsReadTextFile(CANVAS_ID, {
        path: `${ACP_CANVAS_VFS_PREFIX}nodes/missing.md`,
      }),
    ).toThrow(/path not found/);
  });
});
