import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { RESOURCE_SUBDIRS, ensureResourceLayout, resolveResourceRoot, resourceSubdirPath } from '../src/resource-dir.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveResourceRoot', () => {
  it('defaults to an absolute ~/.agentlet/resources directory', () => {
    const root = resolveResourceRoot({});
    expect(root.endsWith(join('.agentlet', 'resources'))).toBe(true);
    expect(root.startsWith('/') || /^[A-Za-z]:\\/.test(root)).toBe(true);
  });

  it('honors an explicit absolute AGENT_RESOURCE_DIR override', () => {
    const override = mkdtempSync(join(tmpdir(), 'agentlet-resources-'));
    tempDirs.push(override);
    expect(resolveResourceRoot({ AGENT_RESOURCE_DIR: override })).toBe(override);
  });

  it('rejects a relative AGENT_RESOURCE_DIR override', () => {
    expect(() =>
      resolveResourceRoot({ AGENT_RESOURCE_DIR: './relative-resources' }),
    ).toThrow(/absolute path/);
  });

  it('ignores a blank override and falls back to the default root', () => {
    expect(resolveResourceRoot({ AGENT_RESOURCE_DIR: '   ' })).toBe(resolveResourceRoot({}));
  });
});

describe('ensureResourceLayout', () => {
  it('creates the bounded skills/tools/connectors/receipts layout', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentlet-resources-'));
    tempDirs.push(root);

    ensureResourceLayout(root);

    for (const subdir of RESOURCE_SUBDIRS) {
      expect(existsSync(resourceSubdirPath(root, subdir))).toBe(true);
    }
  });

  it('is idempotent and leaves existing content untouched', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentlet-resources-'));
    tempDirs.push(root);

    ensureResourceLayout(root);
    ensureResourceLayout(root);

    for (const subdir of RESOURCE_SUBDIRS) {
      expect(existsSync(resourceSubdirPath(root, subdir))).toBe(true);
    }
  });
});
