// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = dirname(fileURLToPath(import.meta.url));
const httpDirectory = join(root, 'http-native');
const cliDirectory = join(root, 'rfs-cli');
const markdownFiles = (directory: string) =>
  readdirSync(directory)
    .filter((name) => name.endsWith('.md'))
    .sort();
const headings = (directory: string, name: string) =>
  readFileSync(join(directory, name), 'utf8')
    .split('\n')
    .filter((line) => /^#{1,6} /.test(line));

describe('external Agent Skill presentations', () => {
  it('keeps every CLI Skill on the HTTP-native blueprint', () => {
    const httpFiles = markdownFiles(httpDirectory);
    const cliFiles = markdownFiles(cliDirectory);

    expect(httpFiles).toEqual([
      'access-huabu.md',
      'agents.md',
      'interactive-views.md',
      'layout.md',
      'services.md',
      'tasks.md',
    ]);
    expect(cliFiles).toEqual([
      'access-huabu.md',
      'agents.md',
      'interactive-views.md',
      'layout.md',
      'services.md',
    ]);
    for (const name of cliFiles) {
      expect(httpFiles).toContain(name);
      expect(headings(cliDirectory, name)).toEqual(
        headings(httpDirectory, name),
      );
    }
    const cliRoot = readFileSync(join(cliDirectory, 'access-huabu.md'), 'utf8');
    expect(cliRoot).not.toMatch(
      /HUABU_RFS_URL|AGENTLET_TOKEN|HUABU_THREAD_ID|HUABU_RFS_ENTRY/,
    );
  });
});
