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
    'issue-frame-layout',
    'coordinator-prompt',
  ];
  const promptBytes = promptFiles.reduce(
    (total, file) =>
      total + Buffer.byteLength(kit.content[`assets/${file}.md`]),
    0,
  );
  assert(promptBytes < 28 * 1024, 'Leave room for rendered Prompt wrappers');
  assert.equal(kit.content['assets/execution-note-contract.md'], undefined);
  const skill = kit.content['SKILL.md'];
  assert.match(skill, /^---\nname: issue-tracker\n/);
  assert.match(skill, /Use when/);
  assert.match(skill, /Do not use/);
  assert.match(skill, /## Step 1\. Lay out Space content/);
  assert.match(skill, /## Step 2\. Fill in configuration on the Space/);
  assert.match(
    skill,
    /## Step 3\. Finalize installation and create Coordinator/,
  );
  assert.match(skill, /HUABU_RFS_ENTRY/);
  assert.match(skill, /single Fixing Agent node/i);
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
    coordinatorProfileId: 'external-test',
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
      values: { ...values, coordinatorProfileId: 'huabu' },
    }).join('\n'),
    /INVALID coordinatorProfileId/,
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

test('Single-Agent-node label examples identify the issue within the Agent budget without status words or suffixes', async () => {
  const { content } = await loadKit();
  const layout = content['assets/issue-frame-layout.md'];
  assert.match(layout, /single Fixing Agent node/i);
  assert.match(
    layout,
    /do not create a per-issue Frame or a separate Execution Note node/i,
  );
  assert.match(
    layout,
    /Agent: `<status emoji> <issue identity> · <stable issue title>`/,
  );
  const examples = [
    ...layout.matchAll(/\| [^|\n]+ \| `([🛠🟣⛔🚀✅] #\d+ · [^`]+)` \|/gu),
  ];
  assert(
    examples.length >= 2,
    'Include initial decision and delivery examples',
  );
  for (const [, agent] of examples) {
    assert.match(agent, /^(?:🛠|🟣|⛔|🚀|✅) #\d+ · \S.+$/u);
    assert(Array.from(agent).length <= 80, agent);
    assert.doesNotMatch(
      agent,
      /Approval Needed|In Progress|PR Prepared|Fixing Agent|· Agent|Issue Frame|\(2\)/,
    );
  }
});

test('installed contracts require acceptance-only dispatch, initial-prompt identities, and direct chat/label milestone handoff', async () => {
  const { content } = await loadKit();
  const coordinator = content['assets/coordinator-prompt.md'];
  assert.match(coordinator, /single Fixing Agent node/i);
  assert.match(
    coordinator,
    /do not create an Execution Note or per-issue Frame/i,
  );
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
  const safety = content['assets/fixing-agent-preamble.md'];
  assert.match(
    safety,
    /single Fixing Agent node without a separate Execution Note or per-issue Frame/,
  );
  assert.match(
    safety,
    /before ending each milestone turn|Before ending each milestone turn/,
  );
  assert.match(
    safety,
    /findings, decisions, validation evidence and the next required action/,
  );
  assert.match(
    safety,
    /synchronize your own Agent node label under \*\*Issue Frame Layout\*\*/,
  );
});
