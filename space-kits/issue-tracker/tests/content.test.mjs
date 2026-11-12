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

test('Layer label examples identify the issue within the Agent budget without audit-only status words', async () => {
  const { content } = await loadKit();
  const layout = content['assets/issue-frame-layout.md'];
  assert.match(
    layout,
    /Frame: `<status emoji> <issue identity> · <stable issue title>`/,
  );
  assert.match(
    layout,
    /Agent: `<status emoji> <issue identity> · <stable issue title> · Agent`/,
  );
  const examples = [
    ...layout.matchAll(/\| `[🛠🟣⛔🚀✅] #\d+ · [^`]+` \| `[^\n]+` \|/gu),
  ];
  assert(
    examples.length >= 2,
    'Include initial decision and delivery examples',
  );
  for (const [row] of examples) {
    const [frame, agent] = [...row.matchAll(/`([^`]+)`/g)].map(
      ([, value]) => value,
    );
    assert.match(frame, /^(?:🛠|🟣|⛔|🚀|✅) #\d+ · \S.+$/u);
    assert.equal(agent, `${frame} · Agent`);
    assert(Array.from(agent).length <= 80, agent);
    assert.doesNotMatch(
      agent,
      /Approval Needed|In Progress|PR Prepared|Fixing Agent|Issue Frame|\(2\)/,
    );
  }
  const contract = content['assets/execution-note-contract.md'];
  assert.match(contract, /🟣 Approval Needed/);
  assert.match(contract, /🚀 PR Prepared/);
  assert.doesNotMatch(
    contract,
    /Give the containing Frame a distinct|`· Issue Frame` suffix/,
  );
});

test('installed contracts require acceptance-only dispatch and durable milestone handoff, not final-answer waiting', async () => {
  const { content } = await loadKit();
  const coordinator = content['assets/coordinator-prompt.md'];
  assert.match(
    coordinator,
    /wait only for prompt acceptance and confirmation of that existing Thread identity/,
  );
  assert.match(
    coordinator,
    /stop consuming the response and return control to the user/,
  );
  assert.match(
    coordinator,
    /Closing the response stream does not cancel the durable Agent turn/,
  );
  assert.match(
    coordinator,
    /Do not wait for, poll, or depend on receiving the final answer/,
  );
  assert.match(
    coordinator,
    /an HTTP connection or Thread announcement alone does not prove prompt acceptance/,
  );
  assert.match(
    coordinator,
    /exposes no acceptance signal, report dispatch confirmation as blocked/,
  );
  assert.match(
    coordinator,
    /user asks, a runtime notification is available, or a dependent action requires it/,
  );
  assert.doesNotMatch(
    coordinator,
    /wait for the Agent to finish|wait for its final answer|SSE="\$\(/i,
  );
  for (const file of ['execution-note-contract', 'fixing-agent-preamble']) {
    const contract = content[`assets/${file}.md`];
    assert.match(
      contract,
      /before ending each milestone turn|Before ending each milestone turn/,
    );
    assert.match(contract, /findings, decisions and the next required action/);
    assert.match(
      contract,
      /synchronize.*(?:Agent and Frame|Agent and containing Issue Frame|Layer labels)/,
    );
  }
});
