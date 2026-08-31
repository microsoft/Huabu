import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  assertInsideResourceRoot,
  parseReceipt,
  readReceipt,
  removeReceipt,
  writeReceipt,
  type ResourceReceiptInput,
} from '../src/receipts.js';
import { resourceSubdirPath } from '../src/resource-dir.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentlet-receipts-'));
  tempDirs.push(root);
  return root;
}

function sampleReceipt(root: string, overrides: Partial<ResourceReceiptInput> = {}): ResourceReceiptInput {
  const entrypoint =
    overrides.entrypoint ?? join('skills', 'hackmd-publisher', 'SKILL.md');
  const absoluteEntrypoint = join(root, entrypoint);
  mkdirSync(join(absoluteEntrypoint, '..'), { recursive: true });
  writeFileSync(absoluteEntrypoint, '# HackMD Publisher\n');
  return {
    id: 'hackmd-publisher',
    kind: 'skill',
    name: 'HackMD Publisher',
    provider: 'machine-a',
    description: 'Syncs canvas nodes to HackMD',
    instructions: `Read and follow the Skill under ${root}/skills/hackmd-publisher/SKILL.md`,
    entrypoint,
    installedAt: '2026-08-31T00:00:00.000Z',
    ...overrides,
  };
}

describe('assertInsideResourceRoot', () => {
  it('accepts a relative path that stays inside the root', () => {
    const root = createRoot();
    const entrypoint = join(root, 'skills', 'a', 'SKILL.md');
    mkdirSync(join(entrypoint, '..'), { recursive: true });
    writeFileSync(entrypoint, '# A\n');
    expect(assertInsideResourceRoot(root, join('skills', 'a', 'SKILL.md'), 'entrypoint')).toBe(
      entrypoint,
    );
  });

  it('rejects ../ traversal outside the root', () => {
    const root = createRoot();
    expect(() => assertInsideResourceRoot(root, join('..', 'outside.md'), 'entrypoint')).toThrow(/must stay within/);
  });

  it('rejects an absolute path escaping the root', () => {
    const root = createRoot();
    expect(() => assertInsideResourceRoot(root, '/etc/passwd', 'entrypoint')).toThrow(/must stay within/);
  });

  it('rejects the root itself as a candidate path', () => {
    const root = createRoot();
    expect(() => assertInsideResourceRoot(root, root, 'entrypoint')).toThrow(/must stay within/);
  });

  it('rejects a missing entrypoint', () => {
    const root = createRoot();
    expect(() =>
      assertInsideResourceRoot(root, join('skills', 'missing.md'), 'entrypoint'),
    ).toThrow(/does not exist/);
  });

  it('rejects a symlink that escapes the root', () => {
    const root = createRoot();
    const outside = createRoot();
    const target = join(outside, 'outside.md');
    writeFileSync(target, 'outside');
    mkdirSync(join(root, 'skills'), { recursive: true });
    symlinkSync(target, join(root, 'skills', 'escaped.md'));

    expect(() =>
      assertInsideResourceRoot(root, join('skills', 'escaped.md'), 'entrypoint'),
    ).toThrow(/symbolic link/);
  });
});

describe('parseReceipt', () => {
  it('validates a well-formed receipt', () => {
    const root = createRoot();
    const receipt = parseReceipt({ schemaVersion: 1, ...sampleReceipt(root) }, root);
    expect(receipt).toMatchObject({ schemaVersion: 1, id: 'hackmd-publisher', kind: 'skill' });
  });

  it('rejects a missing or unsupported schemaVersion', () => {
    const root = createRoot();
    expect(() => parseReceipt({ ...sampleReceipt(root) }, root)).toThrow(/schemaVersion/);
    expect(() => parseReceipt({ schemaVersion: 2, ...sampleReceipt(root) }, root)).toThrow(/schemaVersion/);
  });

  it('rejects a non-kebab-case id', () => {
    const root = createRoot();
    expect(() =>
      parseReceipt({ schemaVersion: 1, ...sampleReceipt(root, { id: 'Not Valid!' }) }, root),
    ).toThrow(/kebab-case/);
  });

  it('rejects an entrypoint that escapes the resource root', () => {
    const root = createRoot();
    expect(() =>
      parseReceipt(
        { schemaVersion: 1, ...sampleReceipt(root, { entrypoint: join('..', 'outside.md') }) },
        root,
      ),
    ).toThrow(/must stay within/);
  });

  it('rejects an unknown kind', () => {
    const root = createRoot();
    expect(() =>
      parseReceipt({ schemaVersion: 1, ...sampleReceipt(root, { kind: 'malicious' as never }) }, root),
    ).toThrow(/kind must be one of/);
  });
});

describe('writeReceipt / readReceipt / removeReceipt', () => {
  it('persists a receipt atomically and reads it back', () => {
    const root = createRoot();
    const written = writeReceipt(root, sampleReceipt(root));

    expect(written.schemaVersion).toBe(1);

    const path = join(resourceSubdirPath(root, 'receipts'), 'hackmd-publisher.json');
    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.tmp`)).toBe(false);
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }

    const read = readReceipt(root, 'hackmd-publisher');
    expect(read).toEqual(written);
  });

  it('creates the bounded resource layout on first write', () => {
    const root = createRoot();
    writeReceipt(root, sampleReceipt(root));

    for (const subdir of ['skills', 'tools', 'connectors', 'receipts']) {
      expect(existsSync(join(root, subdir))).toBe(true);
    }
  });

  it('returns undefined for a missing receipt', () => {
    const root = createRoot();
    expect(readReceipt(root, 'does-not-exist')).toBeUndefined();
  });

  it('throws when reading a receipt written with an unsupported schema version', () => {
    const root = createRoot();
    const receiptsDir = resourceSubdirPath(root, 'receipts');
    writeReceipt(root, sampleReceipt(root));
    const path = join(receiptsDir, 'hackmd-publisher.json');
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), schemaVersion: 99 }));

    expect(() => readReceipt(root, 'hackmd-publisher')).toThrow(/schemaVersion/);
  });

  it('removes a receipt idempotently', () => {
    const root = createRoot();
    writeReceipt(root, sampleReceipt(root));
    removeReceipt(root, 'hackmd-publisher');
    expect(readReceipt(root, 'hackmd-publisher')).toBeUndefined();
    expect(() => removeReceipt(root, 'hackmd-publisher')).not.toThrow();
  });

  it('rejects a non-kebab-case id when reading or removing', () => {
    const root = createRoot();
    expect(() => readReceipt(root, '../escape')).toThrow(/kebab-case/);
    expect(() => removeReceipt(root, '../escape')).toThrow(/kebab-case/);
  });
});
