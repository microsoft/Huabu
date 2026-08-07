import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runManagedSetup } from '../src/setup/run-setup.js';
import type { SetupLogger } from '../src/setup/types.js';
import { validateManagedAgentTeam } from '../src/validate.js';

const tempDirs: string[] = [];
const originalSharedToolsDir = process.env.AGENTLET_SHARED_NPM_TOOLS_DIR;
const logger: SetupLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
};

function createTeam(): string {
  const packageDir = mkdtempSync(join(tmpdir(), 'managed-agent-team-'));
  tempDirs.push(packageDir);
  writeFileSync(
    join(packageDir, 'agentlet.yaml'),
    [
      'schema: agentlet-agent-schema-v1',
      'name: reviewer',
      'description: Reviews changes',
      'command:',
      '  copilot: copilot --acp',
      'require:',
      '  prompts:',
      '    - system-prompt.md',
      '  copies:',
      '    - from: helper.mjs',
      '      to: scripts/helper.mjs',
    ].join('\n'),
  );
  writeFileSync(join(packageDir, 'system-prompt.md'), 'Review carefully.');
  writeFileSync(join(packageDir, 'helper.mjs'), 'export const ready = true;');
  return packageDir;
}

afterEach(() => {
  vi.clearAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  if (originalSharedToolsDir === undefined) {
    delete process.env.AGENTLET_SHARED_NPM_TOOLS_DIR;
  } else {
    process.env.AGENTLET_SHARED_NPM_TOOLS_DIR = originalSharedToolsDir;
  }
});

describe('runManagedSetup', () => {
  it('materializes an explicit workspace and emits structured phases', async () => {
    const packageDir = createTeam();
    const workingDirPath = join(packageDir, 'deployments', 'reviewer');
    const progress = vi.fn();

    await runManagedSetup({
      packageDir,
      harness: 'copilot',
      workingDirPath,
      log: logger,
      onProgress: progress,
    });

    expect(
      readFileSync(
        join(workingDirPath, '.github', 'copilot-instructions.md'),
        'utf8',
      ),
    ).toBe('Review carefully.');
    expect(existsSync(join(workingDirPath, 'scripts', 'helper.mjs'))).toBe(true);
    expect(
      validateManagedAgentTeam({
        packageDir,
        harness: 'copilot',
        workingDirPath,
      }),
    ).toEqual({ valid: true, issues: [] });
    expect(progress).toHaveBeenCalledWith({
      phase: 'validating_manifest',
      status: 'started',
      message: 'Validating Agent Team manifest',
    });
    expect(progress).toHaveBeenLastCalledWith({
      phase: 'running_custom_setup',
      status: 'completed',
      message: 'Running custom setup',
    });
  });

  it('reuses a ready shared npm tool across deployment workspaces', async () => {
    const toolDir = mkdtempSync(join(tmpdir(), 'agentlet-test-tool-'));
    tempDirs.push(toolDir);
    writeFileSync(
      join(toolDir, 'package.json'),
      JSON.stringify({
        name: 'agentlet-test-tool',
        version: '1.0.0',
        bin: { 'agentlet-test-tool': 'cli.mjs' },
      }),
    );
    writeFileSync(
      join(toolDir, 'cli.mjs'),
      '#!/usr/bin/env node\nconsole.log("ready");\n',
    );
    chmodSync(join(toolDir, 'cli.mjs'), 0o755);

    const packageDir = createTeam();
    writeFileSync(
      join(packageDir, 'agentlet.yaml'),
      [
        'schema: agentlet-agent-schema-v1',
        'name: reviewer',
        'description: Reviews changes',
        'command:',
        '  copilot: copilot --acp',
        'require:',
        '  cli-tools:',
        `    - package: ${JSON.stringify(toolDir)}`,
        '      installer: npm',
        '      scope: shared',
        '      executables:',
        '        - agentlet-test-tool',
        '  prompts:',
        '    - system-prompt.md',
      ].join('\n'),
    );
    process.env.AGENTLET_SHARED_NPM_TOOLS_DIR = join(
      packageDir,
      'shared-tools',
    );

    await runManagedSetup({
      packageDir,
      harness: 'copilot',
      workingDirPath: join(packageDir, 'deployments', 'first'),
      log: logger,
    });
    vi.clearAllMocks();
    await runManagedSetup({
      packageDir,
      harness: 'copilot',
      workingDirPath: join(packageDir, 'deployments', 'second'),
      log: logger,
    });

    expect(logger.info).toHaveBeenCalledWith(
      `Tool already ready: ${toolDir} (shared)`,
    );
  }, 15_000);
});
