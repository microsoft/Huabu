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

  describe('agentlet.yaml require.cli-tools', () => {
    it('preserves structured npm tool requirements', () => {
      const manifest = readManifest(
        writeManifest(`
  schema: agentlet-agent-schema-v1
  name: Publisher
  description: Publishes documents
  command:
    copilot: copilot --acp
  require:
    cli-tools:
      - package: "@hackmd/hackmd-cli"
        installer: npm
        scope: shared
        executables:
          - hackmd
  `),
      );

      expect(manifest.require?.['cli-tools']).toEqual([
        {
          package: '@hackmd/hackmd-cli',
          installer: 'npm',
          scope: 'shared',
          executables: ['hackmd'],
        },
      ]);
    });

    it('rejects legacy string tool requirements', () => {
      expect(() =>
        readManifest(
          writeManifest(`
  schema: agentlet-agent-schema-v1
  name: Publisher
  description: Publishes documents
  command:
    copilot: copilot --acp
  require:
    cli-tools:
      - "@hackmd/hackmd-cli"
  `),
        ),
      ).toThrow('require.cli-tools[0]` must be an object');
    });

    it('rejects unsupported installers and empty executable lists', () => {
      expect(() =>
        readManifest(
          writeManifest(`
  schema: agentlet-agent-schema-v1
  name: Publisher
  description: Publishes documents
  command:
    copilot: copilot --acp
  require:
    cli-tools:
      - package: publisher
        installer: apt
        scope: shared
        executables: []
  `),
        ),
      ).toThrow('installer` must be "npm"');
    });

    it('rejects executable paths and npm option injection', () => {
      expect(() =>
        readManifest(
          writeManifest(`
  schema: agentlet-agent-schema-v1
  name: Publisher
  description: Publishes documents
  command:
    copilot: copilot --acp
  require:
    cli-tools:
      - package: -g
        installer: npm
        scope: shared
        executables:
          - ../../package.json
  `),
        ),
      ).toThrow('without surrounding whitespace or a leading dash');
    });
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
