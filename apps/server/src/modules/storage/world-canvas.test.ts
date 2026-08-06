import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ensureWorldCanvasOnDisk } from './world-canvas.js';

const roots: string[] = [];

function workspace(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'sediment-world-canvas-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('ensureWorldCanvasOnDisk', () => {
  it('creates one stable hidden World canvas', () => {
    const root = workspace();

    const firstId = ensureWorldCanvasOnDisk(root);
    const secondId = ensureWorldCanvasOnDisk(root);

    expect(secondId).toBe(firstId);
    expect(firstId).toMatch(/^canvas-/);
    const filePath = path.join(root, '.world', 'space.json');
    expect(existsSync(filePath)).toBe(true);
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toMatchObject({
      canvasId: firstId,
      title: 'World',
      version: 0,
      state: { nodes: [], edges: [] },
    });
  });

  it('rejects an established World directory without valid topology', () => {
    const root = workspace();
    const worldRoot = path.join(root, '.world');
    mkdirSync(worldRoot);

    expect(() => ensureWorldCanvasOnDisk(root)).toThrow(
      'World canvas is missing or malformed',
    );

    writeFileSync(path.join(worldRoot, 'space.json'), '{bad json', 'utf8');
    expect(() => ensureWorldCanvasOnDisk(root)).toThrow(
      'World canvas is missing or malformed',
    );
  });
});
