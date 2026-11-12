// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import assert from 'node:assert/strict';
import { access, cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { loadKit, validateConfiguration } from '../scripts/install.mjs';

test('portable package links resolve and Prompt bodies fit native UTF-8 budgets', async () => {
  const kit = await loadKit();
  for (const [file, content] of Object.entries(kit.content)) {
    if (!file.endsWith('.md')) continue;
    for (const [, target] of content.matchAll(/\[[^\]]+]\((\.\/[^)#]+)\)/g)) {
      await access(new URL(`../${target}`, import.meta.url));
    }
    if (file.startsWith('assets/')) {
      assert.doesNotMatch(
        content,
        /\/home\/|\/Users\/|microsoft\/Huabu|origin\/alpha|pnpm|node-[0-9a-f]{8}/,
      );
      assert(
        Buffer.byteLength(content) < 10 * 1024,
        `${file} exceeds a Prompt Note budget`,
      );
    }
  }
  const promptFiles = [
    'common-policy',
    'execution-note-contract',
    'issue-frame-layout',
    'coordinator-prompt',
  ];
  const promptBytes = promptFiles.reduce(
    (total, file) =>
      total + Buffer.byteLength(kit.content[`assets/${file}.md`]),
    0,
  );
  assert(promptBytes < 28 * 1024, 'Leave room for rendered Prompt wrappers');
  const skill = kit.content['SKILL.md'];
  assert.match(skill, /^---\nname: issue-tracker\n/);
  assert.match(skill, /Use when/);
  assert.match(skill, /Do not use/);
});

test('script works from a standalone clone outside the Huabu checkout', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'issue-tracker-portable-'));
  try {
    await cp(new URL('../', import.meta.url), join(directory, 'kit'), {
      recursive: true,
    });
    const output = execFileSync(
      process.execPath,
      [join(directory, 'kit/scripts/install.mjs'), '--help'],
      { cwd: directory, encoding: 'utf8' },
    );
    assert.match(output, /Preview is read-only/);
    const { loadKit: standalone } = await import(
      pathToFileURL(join(directory, 'kit/scripts/install.mjs')).href
    );
    assert.equal((await standalone()).digest, (await loadKit()).digest);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('configuration is explicit, portable and evidence-backed, never inferred', async () => {
  const kit = await loadKit();
  const validate = (value) =>
    validateConfiguration(
      `\`\`\`json\n${JSON.stringify(value)}\n\`\`\`\n`,
      kit.configurationSchema,
      [{ id: 'external-test', alias: 'A project Agent' }],
    );
  const missing = validateConfiguration(
    kit.content['assets/configuration.md'],
    kit.configurationSchema,
    [],
  );
  assert(missing.includes('REQUIRED repository'));
  assert(missing.includes('UNVERIFIED user confirmation'));

  const values = {
    repository: 'octo/example',
    codebasePath: 'D:\\projects\\example',
    worktreeRoot: 'D:\\worktrees',
    fixingProfileId: 'external-test',
    developmentBaseRef: 'upstream/develop',
    pullRequestBase: 'develop',
  };
  const config = {
    schemaVersion: 1,
    values,
    evidence: Object.fromEntries(
      Object.keys(values).map((key) => [
        key,
        'User confirmed; checked on selected execution device',
      ]),
    ),
    confirmedByUser: true,
  };
  assert.deepEqual(validate(config), []);
  assert.match(
    validate({
      ...config,
      values: { ...values, codebasePath: 'relative/path' },
    }).join('\n'),
    /INVALID codebasePath/,
  );
  assert.match(
    validate({
      ...config,
      values: { ...values, developmentBaseRef: 'upstream/../wrong' },
    }).join('\n'),
    /INVALID developmentBaseRef/,
  );
  assert.match(
    validate({
      ...config,
      values: { ...values, fixingProfileId: 'huabu' },
    }).join('\n'),
    /INVALID fixingProfileId/,
  );
  assert.match(validate({ ...config, evidence: {} }).join('\n'), /UNVERIFIED/);
  assert.match(
    validate({ ...config, confirmedByUser: false }).join('\n'),
    /UNVERIFIED user confirmation/,
  );
});
