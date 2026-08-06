/**
 * Tests for the demo-stage canvas→space filename migration.
 *
 *   ✓ renames canvas.json → space.json and .memory/canvas.md → .memory/space.md
 *     in every Space folder, plus setting/.huabu.md → setting/user.md
 *   ✓ leaves the file content untouched (pure rename, no fold)
 *   ✓ never clobbers an already-renamed target; a second sweep is a no-op
 *   ✓ tolerates missing sources / non-Space dirs without throwing
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { migrateCanvasToSpace } from './migrate-canvas-to-space.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'sediment-migrate-space-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeFile(rel: string, body: string): void {
  const abs = join(tmp, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, body);
}

describe('migrateCanvasToSpace', () => {
  it('renames topology, space memory, and user memory files', () => {
    writeFile('My Space/canvas.json', '{"canvasId":"c1"}');
    writeFile('My Space/.memory/canvas.md', 'space brief');
    writeFile('setting/.huabu.md', '- prefers concise');

    migrateCanvasToSpace(tmp);

    expect(existsSync(join(tmp, 'My Space/canvas.json'))).toBe(false);
    expect(existsSync(join(tmp, 'My Space/.memory/canvas.md'))).toBe(false);
    expect(existsSync(join(tmp, 'setting/.huabu.md'))).toBe(false);

    expect(readFileSync(join(tmp, 'My Space/space.json'), 'utf-8')).toBe(
      '{"canvasId":"c1"}',
    );
    expect(readFileSync(join(tmp, 'My Space/.memory/space.md'), 'utf-8')).toBe(
      'space brief',
    );
    expect(readFileSync(join(tmp, 'setting/user.md'), 'utf-8')).toBe(
      '- prefers concise',
    );
  });

  it('never clobbers an already-renamed target and re-runs as a no-op', () => {
    writeFile('My Space/canvas.json', 'legacy');
    writeFile('My Space/space.json', 'current');

    migrateCanvasToSpace(tmp);
    // Existing new file is preserved; legacy source is left in place.
    expect(readFileSync(join(tmp, 'My Space/space.json'), 'utf-8')).toBe(
      'current',
    );

    // A second sweep does not throw and changes nothing.
    expect(() => migrateCanvasToSpace(tmp)).not.toThrow();
    expect(readFileSync(join(tmp, 'My Space/space.json'), 'utf-8')).toBe(
      'current',
    );
  });

  it('tolerates a workspace with no legacy files', () => {
    writeFile('Empty Space/space.json', '{}');
    expect(() => migrateCanvasToSpace(tmp)).not.toThrow();
    expect(existsSync(join(tmp, 'Empty Space/space.json'))).toBe(true);
  });
});
