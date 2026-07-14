import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readManifest } from '../src/setup/manifest.js';

const tempDirs: string[] = [];

function writeManifest(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-team-manifest-'));
  tempDirs.push(dir);
  writeFileSync(join(dir, 'agentlet.yaml'), source);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('agentlet.yaml require.env', () => {
  it('preserves ordered secret and non-secret fields', () => {
    const manifest = readManifest(
      writeManifest(`
schema: agentlet-agent-schema-v1
name: Reviewer
description: Reviews changes
command:
  copilot: copilot --acp
require:
  env:
    - name: MODEL
      description: Model identifier
      required: false
      secret: false
      default: gpt-5
    - name: API_TOKEN
      description: Provider token
      required: true
      secret: true
`),
    );

    expect(manifest.require?.env).toEqual([
      {
        name: 'MODEL',
        description: 'Model identifier',
        required: false,
        secret: false,
        default: 'gpt-5',
      },
      {
        name: 'API_TOKEN',
        description: 'Provider token',
        required: true,
        secret: true,
      },
    ]);
  });

  it('rejects defaults on secret fields', () => {
    expect(() =>
      readManifest(
        writeManifest(`
schema: agentlet-agent-schema-v1
name: Reviewer
description: Reviews changes
command:
  copilot: copilot --acp
require:
  env:
    - name: API_TOKEN
      description: Provider token
      required: true
      secret: true
      default: leaked
`),
      ),
    ).toThrow('default` is not allowed for secret fields');
  });

  it('rejects incomplete field declarations', () => {
    expect(() =>
      readManifest(
        writeManifest(`
schema: agentlet-agent-schema-v1
name: Reviewer
description: Reviews changes
command:
  copilot: copilot --acp
require:
  env:
    - name: ""
      description: ""
      required: yes
`),
      ),
    ).toThrow('Invalid manifest');
  });
});
