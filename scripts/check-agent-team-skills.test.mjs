// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { validateSkillPackage } from './check-agent-team-skills.mjs';

const temporaryDirectories = [];
const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');

function createPackage(skillContent) {
  const root = mkdtempSync(join(tmpdir(), 'agent-team-skill-'));
  temporaryDirectories.push(root);
  const packageDir = join(root, 'example-agent');
  mkdirSync(packageDir);
  writeFileSync(
    join(packageDir, 'agentlet.yaml'),
    [
      'schema: agentlet-agent-schema-v1',
      'name: example-agent',
      'require:',
      '  prompts:',
      '    - system_prompt.md',
      '',
    ].join('\n'),
  );
  writeFileSync(join(packageDir, 'system_prompt.md'), '# Example Agent\n');
  writeFileSync(join(packageDir, 'SKILL.md'), skillContent);
  return packageDir;
}

function validSkill(extra = '') {
  return [
    '---',
    'name: example-agent',
    'description: "Example capability. Use when an example is requested. Do not use for unrelated work."',
    '---',
    '',
    '# Example Agent',
    '',
    'Read the [canonical instructions](./system_prompt.md).',
    extra,
    '',
  ].join('\n');
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

test('accepts a portable skill package with a canonical prompt', () => {
  assert.deepEqual(validateSkillPackage(createPackage(validSkill())), []);
});

test('rejects malformed frontmatter', () => {
  const packageDir = createPackage(
    validSkill().replace(
      'name: example-agent',
      'name: example-agent\nname: duplicate-agent',
    ),
  );
  assert.match(validateSkillPackage(packageDir).join('\n'), /invalid YAML/);
});

test('rejects unterminated frontmatter strings', () => {
  const packageDir = createPackage(
    validSkill().replace(
      'description: "Example capability. Use when an example is requested. Do not use for unrelated work."',
      'description: "Example capability',
    ),
  );
  assert.match(validateSkillPackage(packageDir).join('\n'), /invalid YAML/);
});

test('rejects invalid apostrophes in single-quoted frontmatter', () => {
  const packageDir = createPackage(
    validSkill().replace(
      'description: "Example capability. Use when an example is requested. Do not use for unrelated work."',
      "description: 'Use when asked. Don't use otherwise.'",
    ),
  );
  assert.match(validateSkillPackage(packageDir).join('\n'), /invalid YAML/);
});

test('rejects missing referenced files', () => {
  const packageDir = createPackage(
    validSkill('\nRead [missing guidance](./references/missing.md).'),
  );
  assert.match(
    validateSkillPackage(packageDir).join('\n'),
    /referenced file does not exist/,
  );
});

test('rejects non-portable and escaping references', () => {
  const packageDir = createPackage(
    validSkill(
      '\nDo not read [machine state](/home/example/state.md) or [parent state](../state.md).',
    ),
  );
  const errors = validateSkillPackage(packageDir).join('\n');
  assert.match(errors, /non-portable/);
  assert.match(errors, /escapes the skill folder/);
});

test('keeps Issue Tracker Coordinator and Fixing Agent roles isolated', () => {
  const packageDir = join(repoRoot, 'agent-teams', 'issue-tracker');
  const coordinator = readFileSync(
    join(packageDir, 'system_prompt.md'),
    'utf8',
  );
  const fixingAgent = readFileSync(
    join(packageDir, 'references', 'fixing-agent-preamble.md'),
    'utf8',
  );
  const skill = readFileSync(join(packageDir, 'SKILL.md'), 'utf8');

  assert.doesNotMatch(coordinator, /exactly one issue per conversation/i);
  assert.match(coordinator, /never act as a Fixing Agent/);
  assert.match(coordinator, /one or more GitHub issues/);
  assert.match(
    coordinator,
    /never mix their identities, environments, Agent threads, decisions, or authorization/,
  );
  assert.match(
    coordinator,
    /Only when the user explicitly asks to combine multiple issues/,
  );
  assert.match(coordinator, /Do not combine them before that confirmation/);
  assert.match(coordinator, /Give each execution unit one dedicated Frame/);
  assert.match(coordinator, /independently handled issues never share a Frame/);
  assert.match(
    coordinator,
    /The Frame is a presentation and navigation boundary, not an authorization or runtime identity/,
  );
  assert.match(
    coordinator,
    /concise issue-content title that summarizes the problem itself/,
  );
  assert.match(
    coordinator,
    /exclude workflow terms, Agent roles, and lifecycle states/,
  );
  assert.match(
    coordinator,
    /The body starts with `# <issue-content title>`, followed by a blank line and the complete investigation goal/,
  );
  assert.match(
    coordinator,
    /Submit only the Markdown body and use `expectRev`/,
  );
  assert.doesNotMatch(coordinator, /concise execution-unit title/);
  assert.match(fixingAgent, /The scope is normally one repository issue/);
  assert.match(
    fixingAgent,
    /do not decide to split or combine issues yourself/i,
  );
  assert.match(skill, /one or more GitHub issues/);
  assert.match(
    skill,
    /without explicit user approval and a reasonableness check/,
  );
});
