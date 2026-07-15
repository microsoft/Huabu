import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { scanAgentTeamRoot } from '../src/scan.js';

const tempDirs: string[] = [];

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-team-root-'));
  tempDirs.push(root);
  return root;
}

function writeTeam(root: string, dir: string, manifest: string): void {
  const packageDir = join(root, dir);
  mkdirSync(packageDir);
  writeFileSync(join(packageDir, 'agentlet.yaml'), manifest);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('scanAgentTeamRoot', () => {
  it('returns valid members and diagnostics for invalid manifests', () => {
    const root = createRoot();
    writeTeam(
      root,
      'valid',
      `
schema: agentlet-agent-schema-v1
name: reviewer
description: Reviews changes
command:
  copilot: copilot --acp
require:
  env:
    - name: TOKEN
      description: API token
      required: true
      secret: true
`,
    );
    writeTeam(
      root,
      'invalid',
      `
schema: agentlet-agent-schema-v1
name: broken
`,
    );
    mkdirSync(join(root, 'not-a-team'));

    const result = scanAgentTeamRoot(root);

    expect(result.members).toEqual([
      {
        name: 'reviewer',
        manifestPath: join(root, 'valid', 'agentlet.yaml'),
        description: 'Reviews changes',
        harnesses: ['copilot'],
        env: [
          {
            name: 'TOKEN',
            description: 'API token',
            required: true,
            secret: true,
          },
        ],
      },
    ]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        manifestPath: join(root, 'invalid', 'agentlet.yaml'),
        code: 'invalid_manifest',
      }),
    ]);
  });

  it('requires an absolute collection root', () => {
    expect(() => scanAgentTeamRoot('relative/path')).toThrow(
      'Agent Team root path must be absolute',
    );
  });
});
