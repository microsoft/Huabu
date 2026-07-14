import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  cliToolIsReady,
  npmToolsBinDir,
  recordCliTool,
  resolveNpmToolsRoot,
  resolveSharedNpmToolsRoot,
} from '../src/setup/npm-tools.js';
import type { CliToolRequirement } from '../src/setup/types.js';

const tempDirs: string[] = [];
const originalSharedToolsDir = process.env.AGENTLET_SHARED_NPM_TOOLS_DIR;
const tool: CliToolRequirement = {
  package: '@hackmd/hackmd-cli',
  installer: 'npm',
  scope: 'shared',
  executables: ['hackmd'],
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  if (originalSharedToolsDir === undefined) {
    delete process.env.AGENTLET_SHARED_NPM_TOOLS_DIR;
  } else {
    process.env.AGENTLET_SHARED_NPM_TOOLS_DIR = originalSharedToolsDir;
  }
});

describe('npm CLI tools', () => {
  it('requires both a matching receipt and declared executables', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentlet-npm-tools-'));
    tempDirs.push(root);
    const binDir = npmToolsBinDir(root);
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, 'hackmd'), '');

    expect(cliToolIsReady(root, tool)).toBe(false);
    recordCliTool(root, tool);
    expect(cliToolIsReady(root, tool)).toBe(true);

    rmSync(join(binDir, 'hackmd'));
    expect(cliToolIsReady(root, tool)).toBe(false);
  });

  it('supports an explicit shared-tools directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentlet-shared-tools-'));
    tempDirs.push(root);
    process.env.AGENTLET_SHARED_NPM_TOOLS_DIR = root;

    expect(resolveSharedNpmToolsRoot()).toBe(root);
  });

  it('isolates different package requirements into separate prefixes', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentlet-shared-tools-'));
    tempDirs.push(root);
    process.env.AGENTLET_SHARED_NPM_TOOLS_DIR = root;

    expect(resolveNpmToolsRoot(tool, '/workspace')).not.toBe(
      resolveNpmToolsRoot(
        { ...tool, package: '@hackmd/hackmd-cli@2' },
        '/workspace',
      ),
    );
  });
});
