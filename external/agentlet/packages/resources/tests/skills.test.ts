import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  importSkill,
  listImportedSkillIds,
  refreshSkill,
  removeImportedSkill,
  scanSkillFolder,
} from '../src/skills.js';
import { readReceipt } from '../src/receipts.js';

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createSkill(parent: string, folder: string, name: string): string {
  const skillDir = join(parent, folder);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Test Skill\n---\n\n# ${name}\n\nFollow these instructions.\n`,
  );
  writeFileSync(join(skillDir, 'helper.txt'), 'helper');
  return skillDir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('Skill resource lifecycle', () => {
  it('discovers nested SKILL.md packages without changing them', () => {
    const sourceRoot = createTempDir('agentlet-skill-source-');
    const skillDir = createSkill(sourceRoot, 'slides', 'HTML Slides Maker');

    const result = scanSkillFolder(sourceRoot);

    expect(result.diagnostics).toEqual([]);
    expect(result.candidates).toEqual([
      expect.objectContaining({
        id: 'html-slides-maker',
        name: 'HTML Slides Maker',
        sourcePath: skillDir,
        sourceRevision: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
  });

  it('imports a confirmed source into the managed resource root', () => {
    const sourceRoot = createTempDir('agentlet-skill-source-');
    const managedRoot = createTempDir('agentlet-resource-root-');
    const skillDir = createSkill(sourceRoot, 'slides', 'HTML Slides Maker');
    const candidate = scanSkillFolder(sourceRoot).candidates[0];

    const result = importSkill(managedRoot, 'machine-a', {
      id: candidate.id,
      sourcePath: skillDir,
      expectedRevision: candidate.sourceRevision,
    });

    expect(result).toMatchObject({
      created: true,
      receipt: {
        schemaVersion: 2,
        id: 'html-slides-maker',
        provider: 'machine-a',
        source: skillDir,
        sourceRevision: candidate.sourceRevision,
      },
    });
    expect(
      readFileSync(
        join(managedRoot, 'skills', 'html-slides-maker', 'helper.txt'),
        'utf8',
      ),
    ).toBe('helper');
  });

  it('rejects import when source changed after preview', () => {
    const sourceRoot = createTempDir('agentlet-skill-source-');
    const managedRoot = createTempDir('agentlet-resource-root-');
    const skillDir = createSkill(sourceRoot, 'slides', 'HTML Slides Maker');
    const candidate = scanSkillFolder(sourceRoot).candidates[0];
    writeFileSync(join(skillDir, 'helper.txt'), 'changed');

    expect(() =>
      importSkill(managedRoot, 'machine-a', {
        id: candidate.id,
        sourcePath: skillDir,
        expectedRevision: candidate.sourceRevision,
      }),
    ).toThrow(/changed after preview/);
  });

  it('returns the matching receipt when an import is retried', () => {
    const sourceRoot = createTempDir('agentlet-skill-source-');
    const managedRoot = createTempDir('agentlet-resource-root-');
    const skillDir = createSkill(sourceRoot, 'slides', 'HTML Slides Maker');
    const candidate = scanSkillFolder(sourceRoot).candidates[0];
    const input = {
      id: candidate.id,
      sourcePath: skillDir,
      expectedRevision: candidate.sourceRevision,
    };
    const first = importSkill(managedRoot, 'machine-a', input);

    expect(importSkill(managedRoot, 'machine-a', input)).toEqual({
      receipt: first.receipt,
      created: false,
    });
  });

  it('refreshes the managed copy from the receipt source', () => {
    const sourceRoot = createTempDir('agentlet-skill-source-');
    const managedRoot = createTempDir('agentlet-resource-root-');
    const skillDir = createSkill(sourceRoot, 'slides', 'HTML Slides Maker');
    const initial = scanSkillFolder(sourceRoot).candidates[0];
    importSkill(managedRoot, 'machine-a', {
      id: initial.id,
      sourcePath: skillDir,
      expectedRevision: initial.sourceRevision,
    });
    writeFileSync(join(skillDir, 'helper.txt'), 'updated');
    const updated = scanSkillFolder(skillDir).candidates[0];

    refreshSkill(
      managedRoot,
      'machine-a',
      initial.id,
      updated.sourceRevision,
    );

    expect(
      readFileSync(
        join(managedRoot, 'skills', initial.id, 'helper.txt'),
        'utf8',
      ),
    ).toBe('updated');
    expect(readReceipt(managedRoot, initial.id)?.sourceRevision).toBe(
      updated.sourceRevision,
    );
  });

  it('removes only the managed Skill and its receipt', () => {
    const sourceRoot = createTempDir('agentlet-skill-source-');
    const managedRoot = createTempDir('agentlet-resource-root-');
    const skillDir = createSkill(sourceRoot, 'slides', 'HTML Slides Maker');
    const candidate = scanSkillFolder(sourceRoot).candidates[0];
    importSkill(managedRoot, 'machine-a', {
      id: candidate.id,
      sourcePath: skillDir,
      expectedRevision: candidate.sourceRevision,
    });

    expect(
      removeImportedSkill(managedRoot, 'machine-a', candidate.id),
    ).toBe(true);
    expect(existsSync(skillDir)).toBe(true);
    expect(
      existsSync(join(managedRoot, 'skills', candidate.id)),
    ).toBe(false);
    expect(readReceipt(managedRoot, candidate.id)).toBeUndefined();
  });

  it('lists only Skills installed through the import flow', () => {
    const sourceRoot = createTempDir('agentlet-skill-source-');
    const managedRoot = createTempDir('agentlet-resource-root-');
    const skillDir = createSkill(sourceRoot, 'slides', 'HTML Slides Maker');
    const candidate = scanSkillFolder(sourceRoot).candidates[0];
    importSkill(managedRoot, 'machine-a', {
      id: candidate.id,
      sourcePath: skillDir,
      expectedRevision: candidate.sourceRevision,
    });

    expect(listImportedSkillIds(managedRoot, 'machine-a')).toEqual([
      candidate.id,
    ]);
  });

  it('rolls back a promoted refresh whose receipt was not committed', () => {
    const sourceRoot = createTempDir('agentlet-skill-source-');
    const managedRoot = createTempDir('agentlet-resource-root-');
    const skillDir = createSkill(sourceRoot, 'slides', 'HTML Slides Maker');
    const initial = scanSkillFolder(sourceRoot).candidates[0];
    importSkill(managedRoot, 'machine-a', {
      id: initial.id,
      sourcePath: skillDir,
      expectedRevision: initial.sourceRevision,
    });
    writeFileSync(join(skillDir, 'helper.txt'), 'updated');
    const updated = scanSkillFolder(skillDir).candidates[0];
    const destination = join(managedRoot, 'skills', initial.id);
    renameSync(destination, join(managedRoot, 'skills', `.${initial.id}.previous`));
    cpSync(skillDir, destination, { recursive: true });
    writeFileSync(
      join(managedRoot, 'skills', `.${initial.id}.transaction`),
      JSON.stringify({ targetRevision: updated.sourceRevision }),
    );

    expect(listImportedSkillIds(managedRoot, 'machine-a')).toEqual([
      initial.id,
    ]);
    expect(readFileSync(join(destination, 'helper.txt'), 'utf8')).toBe(
      'helper',
    );
    expect(readReceipt(managedRoot, initial.id)?.sourceRevision).toBe(
      initial.sourceRevision,
    );
  });

  it('rolls back a promoted first import whose receipt was not committed', () => {
    const sourceRoot = createTempDir('agentlet-skill-source-');
    const managedRoot = createTempDir('agentlet-resource-root-');
    const skillDir = createSkill(sourceRoot, 'slides', 'HTML Slides Maker');
    const candidate = scanSkillFolder(sourceRoot).candidates[0];
    const destination = join(managedRoot, 'skills', candidate.id);
    mkdirSync(join(managedRoot, 'skills'), { recursive: true });
    cpSync(skillDir, destination, { recursive: true });
    writeFileSync(
      join(managedRoot, 'skills', `.${candidate.id}.transaction`),
      JSON.stringify({ targetRevision: candidate.sourceRevision }),
    );

    expect(listImportedSkillIds(managedRoot, 'machine-a')).toEqual([]);
    expect(existsSync(destination)).toBe(false);
    expect(
      existsSync(
        join(managedRoot, 'skills', `.${candidate.id}.transaction`),
      ),
    ).toBe(false);
  });

  it('rejects a Skill package containing a symbolic link', () => {
    const sourceRoot = createTempDir('agentlet-skill-source-');
    const outside = createTempDir('agentlet-skill-outside-');
    const skillDir = createSkill(sourceRoot, 'slides', 'HTML Slides Maker');
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    symlinkSync(join(outside, 'secret.txt'), join(skillDir, 'secret.txt'));

    const result = scanSkillFolder(sourceRoot);

    expect(result.candidates).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'skill_invalid' }),
    ]);
  });
});
