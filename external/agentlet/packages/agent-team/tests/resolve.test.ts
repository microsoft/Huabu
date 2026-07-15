import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveAgentTeam } from '../src/resolve/index.js';
import {
  npmToolsBinDir,
  resolveNpmToolsRoot,
} from '../src/setup/npm-tools.js';
import type { CliToolRequirement } from '../src/setup/types.js';

const tempDirs: string[] = [];
const originalSharedToolsDir = process.env.AGENTLET_SHARED_NPM_TOOLS_DIR;

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

describe('resolveAgentTeam', () => {
  it('prepends workspace and shared tool bins after host env overrides', () => {
    const packageDir = mkdtempSync(join(tmpdir(), 'agent-team-resolve-'));
    tempDirs.push(packageDir);
    const workspaceDir = join(packageDir, 'workspaces', 'copilot');
    mkdirSync(workspaceDir, { recursive: true });
    const tool: CliToolRequirement = {
      package: '@hackmd/hackmd-cli',
      installer: 'npm',
      scope: 'shared',
      executables: ['hackmd'],
    };
    writeFileSync(
      join(packageDir, 'agentlet.yaml'),
      [
        'schema: agentlet-agent-schema-v1',
        'name: publisher',
        'description: Publishes documents',
        'command:',
        '  copilot: copilot --acp',
        'require:',
        '  cli-tools:',
        `    - package: "${tool.package}"`,
        '      installer: npm',
        '      scope: shared',
        '      executables:',
        '        - hackmd',
      ].join('\n'),
    );
    writeFileSync(join(packageDir, '.env'), 'TOKEN=package\nPATH=/package-bin\n');
    process.env.AGENTLET_SHARED_NPM_TOOLS_DIR = join(packageDir, 'shared');

    const resolved = resolveAgentTeam(
      { agentDir: packageDir, harness: 'copilot' },
      { TOKEN: 'host', PATH: '/host-bin' },
    );

    expect(resolved.env.TOKEN).toBe('host');
    expect(resolved.env.PATH).toBe(
      [
        join(workspaceDir, 'node_modules', '.bin'),
        npmToolsBinDir(resolveNpmToolsRoot(tool, workspaceDir)),
        '/host-bin',
      ].join(delimiter),
    );
  });

  it('uses the manifest and workspace paths snapshotted by a Profile', () => {
    const packageDir = mkdtempSync(join(tmpdir(), 'agent-team-profile-'));
    tempDirs.push(packageDir);
    const workspaceDir = join(packageDir, 'custom-workspace');
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(
      join(packageDir, 'agentlet.yaml'),
      [
        'schema: agentlet-agent-schema-v1',
        'name: reviewer',
        'description: Reviews documents',
        'command:',
        '  claude: claude-agent-acp',
      ].join('\n'),
    );

    const resolved = resolveAgentTeam({
      manifestPath: join(packageDir, 'agentlet.yaml'),
      workingDirPath: workspaceDir,
      harness: 'claude',
    });

    expect(resolved.command).toBe('claude-agent-acp');
    expect(resolved.cwd).toBe(workspaceDir);
  });
});
