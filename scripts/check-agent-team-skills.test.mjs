import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, test } from 'node:test';

import { validateSkillPackage } from './check-agent-team-skills.mjs';

const temporaryDirectories = [];

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
    validSkill().replace('name: example-agent', 'name:\texample-agent'),
  );
  assert.match(
    validateSkillPackage(packageDir).join('\n'),
    /must not contain tabs/,
  );
});

test('rejects unterminated frontmatter strings', () => {
  const packageDir = createPackage(
    validSkill().replace(
      'description: "Example capability. Use when an example is requested. Do not use for unrelated work."',
      'description: "Example capability',
    ),
  );
  assert.match(
    validateSkillPackage(packageDir).join('\n'),
    /unterminated quote/,
  );
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
