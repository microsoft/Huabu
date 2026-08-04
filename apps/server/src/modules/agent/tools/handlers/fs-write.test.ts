/**
 * Tests for the `fs_write` tool handler.
 *
 * Coverage:
 *   ✓ path routing (workspace / canvas / skill / unknown / malformed)
 *   ✓ canvasId requirement for canvas-memory writes
 *   ✓ overwrite mode (create + replace, trailing newline, caps)
 *   ✓ replace_string mode (must exist, unique-match contract, edge cases)
 *   ✓ skill creation rationale rule (the only conditional required field)
 *   ✓ result envelope shape (`{ ok, target, reason }`) for both ok and reject
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { handleFsWrite } from './fs-write.js';
import {
  canvasMemoryPath,
  userSkillsDir,
  workspaceMemoryPath,
} from '../../../storage/paths.js';
import { setWorkspacePath } from '../../../workspace.js';

interface ParsedResult {
  ok: boolean;
  target: string;
  reason: string;
}

function parse(raw: string): ParsedResult {
  return JSON.parse(raw) as ParsedResult;
}

let tmp: string;
const canvasId = 'cv-fs-write-test';

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'sediment-fs-write-'));
  setWorkspacePath(tmp);
  // `canvasRoot(canvasId)` falls back to `<workspace>/<canvasId>` when the
  // canvas-dir index has no entry for the id (see `canvasDirName` in
  // `workspace/disk/canvas-dirs.ts`). We just need the directory to exist so
  // writes can land in it.
  mkdirSync(join(tmp, canvasId), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ─── Path routing ──────────────────────────────────────────────────────────

describe('handleFsWrite — path routing', () => {
  it('rejects when path is missing', async () => {
    const r = parse(
      await handleFsWrite({ mode: 'overwrite', body: 'x' } as never),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/path is required/);
  });

  it('rejects unsupported paths', async () => {
    const r = parse(
      await handleFsWrite({
        path: 'nodes/foo.md',
        mode: 'overwrite',
        body: 'x',
      } as never),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/unsupported path/);
    expect(r.reason).toMatch(/memory\/user\.md/);
  });

  it('rejects space-memory writes without a bound canvasId', async () => {
    const r = parse(
      await handleFsWrite({
        path: 'memory/space.md',
        mode: 'overwrite',
        body: 'x',
      } as never),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Space-scoped but no canvasId/);
  });

  it('rejects malformed skill paths (no nested dirs)', async () => {
    const r = parse(
      await handleFsWrite({
        path: 'skills/foo/bar/SKILL.md',
        mode: 'overwrite',
        body: '---\nid: foo\nname: x\ndescription: x\nappliesTo: [ask]\n---\nbody',
        rationale: 'because no existing skill covers this rare case at all',
      } as never),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/skills\/<id>\/SKILL\.md/);
  });

  it('rejects skill ids with path traversal', async () => {
    const r = parse(
      await handleFsWrite({
        path: 'skills/../SKILL.md',
        mode: 'overwrite',
        body: 'x',
        rationale: 'a rationale long enough to clear the twenty char minimum',
      } as never),
    );
    expect(r.ok).toBe(false);
    // Either the path-shape check or the sandbox id validator catches it.
    expect(r.reason.length).toBeGreaterThan(0);
  });
});

// ─── Overwrite mode ────────────────────────────────────────────────────────

describe('handleFsWrite — overwrite', () => {
  it('creates workspace memory with trailing newline', async () => {
    const r = parse(
      await handleFsWrite({
        path: 'memory/user.md',
        mode: 'overwrite',
        body: '- prefers concise replies',
      } as never),
    );
    expect(r.ok).toBe(true);
    expect(r.target).toBe(workspaceMemoryPath());
    expect(readFileSync(workspaceMemoryPath(), 'utf8')).toBe(
      '- prefers concise replies\n',
    );
  });

  it('overwrites existing workspace memory wholesale', async () => {
    // Seed
    await handleFsWrite({
      path: 'memory/user.md',
      mode: 'overwrite',
      body: 'old line',
    } as never);
    // Overwrite
    const r = parse(
      await handleFsWrite({
        path: 'memory/user.md',
        mode: 'overwrite',
        body: 'new line',
      } as never),
    );
    expect(r.ok).toBe(true);
    expect(readFileSync(workspaceMemoryPath(), 'utf8')).toBe('new line\n');
  });

  it('writes canvas memory under the bound canvasId', async () => {
    const r = parse(
      await handleFsWrite({
        path: 'memory/space.md',
        mode: 'overwrite',
        body: 'canvas briefing',
        canvasId,
      } as never),
    );
    expect(r.ok).toBe(true);
    expect(r.target).toBe(canvasMemoryPath(canvasId));
    expect(readFileSync(canvasMemoryPath(canvasId), 'utf8')).toBe(
      'canvas briefing\n',
    );
  });

  it('rejects oversize bodies (workspace cap is 4 KB / 80 lines)', async () => {
    const body = 'x'.repeat(5000); // > 4 KB
    const r = parse(
      await handleFsWrite({
        path: 'memory/user.md',
        mode: 'overwrite',
        body,
      } as never),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/exceeds .* bytes/);
    expect(existsSync(workspaceMemoryPath())).toBe(false);
  });

  it('rejects when body > 80 lines on capped tiers', async () => {
    const body = Array.from({ length: 90 }, (_, i) => `- line ${i}`).join('\n');
    const r = parse(
      await handleFsWrite({
        path: 'memory/space.md',
        mode: 'overwrite',
        body,
        canvasId,
      } as never),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/exceeds .* lines/);
  });
});

// ─── Skill creation rationale rule ────────────────────────────────────────

describe('handleFsWrite — skill creation', () => {
  const skillBody = [
    '---',
    'id: test-skill',
    'name: "Test skill"',
    'description: "A test skill."',
    'appliesTo: ["ask"]',
    '---',
    '',
    '# Test skill',
    '',
    'Body.',
    '',
  ].join('\n');

  it('rejects new skill creation without rationale', async () => {
    const r = parse(
      await handleFsWrite({
        path: 'skills/test-skill/SKILL.md',
        mode: 'overwrite',
        body: skillBody,
      } as never),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/rationale/);
    expect(existsSync(join(userSkillsDir(), 'test-skill', 'SKILL.md'))).toBe(
      false,
    );
  });

  it('rejects new skill creation with too-short rationale', async () => {
    const r = parse(
      await handleFsWrite({
        path: 'skills/test-skill/SKILL.md',
        mode: 'overwrite',
        body: skillBody,
        rationale: 'too short',
      } as never),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/rationale/);
  });

  it('creates a new skill when rationale is sufficient', async () => {
    const r = parse(
      await handleFsWrite({
        path: 'skills/test-skill/SKILL.md',
        mode: 'overwrite',
        body: skillBody,
        rationale:
          'no existing skill covers this exact testing scenario at all today',
      } as never),
    );
    expect(r.ok).toBe(true);
    const onDisk = readFileSync(
      join(userSkillsDir(), 'test-skill', 'SKILL.md'),
      'utf8',
    );
    expect(onDisk).toContain('# Test skill');
    expect(onDisk).toContain('appliesTo: ["ask"]');
  });

  it('updating an existing skill via overwrite does NOT require rationale', async () => {
    // Seed by going through create-with-rationale (so file exists)
    await handleFsWrite({
      path: 'skills/test-skill/SKILL.md',
      mode: 'overwrite',
      body: skillBody,
      rationale:
        'no existing skill covers this exact testing scenario at all today',
    } as never);
    // Now overwrite without rationale — should succeed.
    const newBody = skillBody.replace('Body.', 'Updated body.');
    const r = parse(
      await handleFsWrite({
        path: 'skills/test-skill/SKILL.md',
        mode: 'overwrite',
        body: newBody,
      } as never),
    );
    expect(r.ok).toBe(true);
    expect(
      readFileSync(join(userSkillsDir(), 'test-skill', 'SKILL.md'), 'utf8'),
    ).toContain('Updated body.');
  });

  it('skill bodies are uncapped (>4 KB allowed)', async () => {
    const bigBody =
      [
        '---',
        'id: big-skill',
        'name: "Big skill"',
        'description: "A skill with a lot of text."',
        'appliesTo: ["ask"]',
        '---',
        '',
      ].join('\n') +
      'x'.repeat(5000) +
      '\n';
    const r = parse(
      await handleFsWrite({
        path: 'skills/big-skill/SKILL.md',
        mode: 'overwrite',
        body: bigBody,
        rationale:
          'huge reusable pattern that has no existing equivalent in the catalogue',
      } as never),
    );
    expect(r.ok).toBe(true);
  });
});

// ─── replace_string mode ───────────────────────────────────────────────────

describe('handleFsWrite — replace_string', () => {
  beforeEach(async () => {
    // Seed workspace memory with deterministic content.
    await handleFsWrite({
      path: 'memory/user.md',
      mode: 'overwrite',
      body: '- alpha\n- beta\n- gamma',
    } as never);
  });

  it('rejects when file does not exist', async () => {
    const r = parse(
      await handleFsWrite({
        path: 'memory/space.md',
        mode: 'replace_string',
        oldString: 'foo',
        newString: 'bar',
        canvasId,
      } as never),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/does not exist/);
  });

  it('rejects when oldString is missing entirely', async () => {
    const r = parse(
      await handleFsWrite({
        path: 'memory/user.md',
        mode: 'replace_string',
        oldString: 'does-not-occur',
        newString: 'x',
      } as never),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not found/);
  });

  it('rejects when oldString matches multiple times', async () => {
    // Overwrite with a body that has duplicates.
    await handleFsWrite({
      path: 'memory/user.md',
      mode: 'overwrite',
      body: '- alpha\n- alpha\n- beta',
    } as never);
    const r = parse(
      await handleFsWrite({
        path: 'memory/user.md',
        mode: 'replace_string',
        oldString: '- alpha',
        newString: '- ALPHA',
      } as never),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/multiple times/);
  });

  it('rejects empty oldString', async () => {
    const r = parse(
      await handleFsWrite({
        path: 'memory/user.md',
        mode: 'replace_string',
        oldString: '',
        newString: 'x',
      } as never),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/oldString/);
  });

  it('rejects when oldString === newString', async () => {
    const r = parse(
      await handleFsWrite({
        path: 'memory/user.md',
        mode: 'replace_string',
        oldString: '- alpha',
        newString: '- alpha',
      } as never),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/identical/);
  });

  it('replaces a unique substring and preserves the rest', async () => {
    const r = parse(
      await handleFsWrite({
        path: 'memory/user.md',
        mode: 'replace_string',
        oldString: '- beta',
        newString: '- BETA-NEW',
      } as never),
    );
    expect(r.ok).toBe(true);
    expect(readFileSync(workspaceMemoryPath(), 'utf8')).toBe(
      '- alpha\n- BETA-NEW\n- gamma\n',
    );
  });

  it('supports deletion via empty newString', async () => {
    const r = parse(
      await handleFsWrite({
        path: 'memory/user.md',
        mode: 'replace_string',
        oldString: '- beta\n',
        newString: '',
      } as never),
    );
    expect(r.ok).toBe(true);
    expect(readFileSync(workspaceMemoryPath(), 'utf8')).toBe(
      '- alpha\n- gamma\n',
    );
  });

  it('enforces cap on the post-edit body for capped tiers', async () => {
    // Replace something with a 5 KB blob — should reject and leave file intact.
    const before = readFileSync(workspaceMemoryPath(), 'utf8');
    const r = parse(
      await handleFsWrite({
        path: 'memory/user.md',
        mode: 'replace_string',
        oldString: '- beta',
        newString: 'x'.repeat(5000),
      } as never),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/exceeds/);
    expect(readFileSync(workspaceMemoryPath(), 'utf8')).toBe(before);
  });
});

// ─── Mode validation ───────────────────────────────────────────────────────

describe('handleFsWrite — mode validation', () => {
  it('rejects overwrite missing body', async () => {
    const r = parse(
      await handleFsWrite({
        path: 'memory/user.md',
        mode: 'overwrite',
      } as never),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/requires "body"/);
  });

  it('rejects replace_string missing newString', async () => {
    await handleFsWrite({
      path: 'memory/user.md',
      mode: 'overwrite',
      body: 'seed',
    } as never);
    const r = parse(
      await handleFsWrite({
        path: 'memory/user.md',
        mode: 'replace_string',
        oldString: 'seed',
      } as never),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/requires "newString"/);
  });
});
