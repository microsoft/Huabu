import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { enumerateLocalResources } from '../src/catalogue.js';
import { writeReceipt } from '../src/receipts.js';
import { resourceSubdirPath } from '../src/resource-dir.js';
import type { ResourceReceiptInput } from '../src/receipts.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentlet-catalogue-'));
  tempDirs.push(root);
  return root;
}

function sampleReceipt(root: string, overrides: Partial<ResourceReceiptInput> = {}): ResourceReceiptInput {
  const id = overrides.id ?? 'hackmd-publisher';
  const entrypoint = overrides.entrypoint ?? join('skills', id, 'SKILL.md');
  const absoluteEntrypoint = join(root, entrypoint);
  mkdirSync(join(absoluteEntrypoint, '..'), { recursive: true });
  writeFileSync(absoluteEntrypoint, `# ${id}\n`);
  return {
    id,
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

describe('enumerateLocalResources', () => {
  it('rejects a non-absolute root', () => {
    expect(() => enumerateLocalResources('relative/path')).toThrow(/must be absolute/);
  });

  it('returns an empty result when the receipts directory does not exist', () => {
    const root = createRoot();
    expect(enumerateLocalResources(root)).toEqual({ rootPath: root, records: [], diagnostics: [] });
  });

  it('projects a minimal AgentResource-shaped record for each valid receipt', () => {
    const root = createRoot();
    writeReceipt(root, sampleReceipt(root));
    writeReceipt(
      root,
      sampleReceipt(root, {
        id: 'deepv-slides-maker',
        name: 'DeepV Slides Maker',
        entrypoint: join('skills', 'deepv-slides-maker', 'SKILL.md'),
      }),
    );

    const result = enumerateLocalResources(root);

    expect(result.diagnostics).toEqual([]);
    expect(result.records).toEqual([
      {
        schemaVersion: 1,
        id: 'deepv-slides-maker',
        name: 'DeepV Slides Maker',
        provider: 'machine-a',
        description: 'Syncs canvas nodes to HackMD',
        instructions: expect.any(String),
      },
      {
        schemaVersion: 1,
        id: 'hackmd-publisher',
        name: 'HackMD Publisher',
        provider: 'machine-a',
        description: 'Syncs canvas nodes to HackMD',
        instructions: expect.any(String),
      },
    ]);
  });

  it('rejects receipts published for a different Agentlet provider', () => {
    const root = createRoot();
    writeReceipt(root, sampleReceipt(root, { provider: 'machine-b' }));

    const result = enumerateLocalResources(root, 'machine-a');

    expect(result.records).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'invalid_receipt',
        message: 'Receipt failed validation',
      }),
    ]);
  });

  it('reports an invalid receipt as a diagnostic instead of aborting the scan', () => {
    const root = createRoot();
    writeReceipt(root, sampleReceipt(root));

    const receiptsDir = resourceSubdirPath(root, 'receipts');
    writeFileSync(join(receiptsDir, 'broken.json'), JSON.stringify({ schemaVersion: 1, id: 'broken' }));

    const result = enumerateLocalResources(root);

    expect(result.records).toHaveLength(1);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'invalid_receipt', receiptPath: join(receiptsDir, 'broken.json') }),
    ]);
  });

  it('reports unparsable JSON as a receipt_unreadable diagnostic', () => {
    const root = createRoot();
    const receiptsDir = resourceSubdirPath(root, 'receipts');
    mkdirSync(receiptsDir, { recursive: true });
    writeFileSync(join(receiptsDir, 'corrupt.json'), '{ not valid json');

    const result = enumerateLocalResources(root);

    expect(result.records).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'receipt_unreadable', receiptPath: join(receiptsDir, 'corrupt.json') }),
    ]);
  });

  it('rejects a receipt whose filename does not match its id', () => {
    const root = createRoot();
    const receipt = writeReceipt(root, sampleReceipt(root));
    const receiptsDir = resourceSubdirPath(root, 'receipts');
    writeFileSync(
      join(receiptsDir, 'different-name.json'),
      JSON.stringify(receipt),
    );

    const result = enumerateLocalResources(root);

    expect(result.records).toHaveLength(1);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'invalid_receipt',
        message: 'Receipt failed validation',
      }),
    ]);
  });

  it('ignores non-json entries under receipts/', () => {
    const root = createRoot();
    const receiptsDir = resourceSubdirPath(root, 'receipts');
    mkdirSync(receiptsDir, { recursive: true });
    writeFileSync(join(receiptsDir, 'README.md'), 'not a receipt');

    expect(enumerateLocalResources(root)).toEqual({ rootPath: root, records: [], diagnostics: [] });
  });

  it('never reads outside the receipts subdirectory', () => {
    const root = createRoot();
    // A sibling file directly under the resource root must never be scanned.
    writeFileSync(join(root, 'secret.json'), JSON.stringify({ schemaVersion: 1, id: 'secret' }));

    expect(enumerateLocalResources(root)).toEqual({ rootPath: root, records: [], diagnostics: [] });
  });
});
