import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  appendJsonLine,
  appendJsonLines,
  atomicWriteText,
  readJsonLines,
  readJsonLinesStrict,
  readJsonStrict,
} from './fs.js';

let root = '';

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'sediment-fs-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('readJsonStrict', () => {
  it('returns null only for a missing path', () => {
    expect(readJsonStrict(path.join(root, 'missing.json'))).toBeNull();

    const valid = path.join(root, 'valid.json');
    writeFileSync(valid, '{"ok":true}', 'utf8');
    expect(readJsonStrict(valid)).toEqual({ ok: true });
  });

  it('propagates malformed and unreadable durable state', () => {
    const malformed = path.join(root, 'malformed.json');
    writeFileSync(malformed, '{"unfinished":', 'utf8');
    expect(() => readJsonStrict(malformed)).toThrow(SyntaxError);

    const directory = path.join(root, 'directory.json');
    mkdirSync(directory);
    expect(() => readJsonStrict(directory)).toThrow();
  });

  it('does not confuse a present JSON null with the missing-file sentinel', () => {
    const file = path.join(root, 'null.json');
    writeFileSync(file, 'null', 'utf8');

    expect(() => readJsonStrict(file)).toThrow(SyntaxError);
  });
});

describe('atomicWriteText', () => {
  it('does not share or consume the legacy fixed .tmp sibling', () => {
    const target = path.join(root, 'record.json');
    const fixedSibling = `${target}.tmp`;
    writeFileSync(fixedSibling, 'someone else owns this', 'utf8');

    atomicWriteText(target, 'new record');

    expect(readFileSync(target, 'utf8')).toBe('new record');
    expect(readFileSync(fixedSibling, 'utf8')).toBe('someone else owns this');
  });

  it('removes its unique temp sibling when the final rename fails', () => {
    const target = path.join(root, 'blocked.txt');
    mkdirSync(target);

    expect(() => atomicWriteText(target, 'cannot land')).toThrow();
    expect(readdirSync(root)).toEqual(['blocked.txt']);
  });
});

describe('JSONL crash-tail recovery', () => {
  it('terminates and preserves a valid unterminated final row', () => {
    const file = path.join(root, 'valid-tail.jsonl');
    writeFileSync(file, JSON.stringify({ n: 1 }), 'utf8');

    appendJsonLine(file, { n: 2 });

    expect(readFileSync(file, 'utf8')).toBe('{"n":1}\n{"n":2}\n');
    expect(readJsonLines(file)).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('truncates a malformed crash fragment before a batch append', () => {
    const file = path.join(root, 'broken-tail.jsonl');
    // The multi-byte value makes this a byte-offset regression test too:
    // string indices would truncate after the wrong byte.
    writeFileSync(file, '{"label":"岩"}\n{"unfinished":', 'utf8');

    appendJsonLines(file, [{ n: 2 }, { n: 3 }]);

    expect(readFileSync(file, 'utf8')).toBe(
      '{"label":"岩"}\n{"n":2}\n{"n":3}\n',
    );
    expect(readJsonLines(file)).toEqual([{ label: '岩' }, { n: 2 }, { n: 3 }]);
  });

  it('repairs a final row larger than the bounded scan chunk', () => {
    const file = path.join(root, 'large-tail.jsonl');
    const large = { body: '岩'.repeat(70_000) };
    writeFileSync(file, JSON.stringify(large), 'utf8');

    appendJsonLine(file, { n: 2 });

    expect(readJsonLines(file)).toEqual([large, { n: 2 }]);
  });

  it('counts valid rows rather than malformed physical tail lines for a limit', () => {
    const file = path.join(root, 'limited-tail.jsonl');
    writeFileSync(file, '{"n":1}\n{"n":2}\n{"unfinished":', 'utf8');

    expect(readJsonLines(file, 1)).toEqual([{ n: 2 }]);
    expect(readJsonLines(file, 2)).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('propagates a non-ENOENT tail-read failure', () => {
    const file = path.join(root, 'not-a-log.jsonl');
    mkdirSync(file);

    expect(() => appendJsonLine(file, { n: 1 })).toThrow();
    expect(readdirSync(root)).toEqual(['not-a-log.jsonl']);
  });
});

describe('readJsonLinesStrict', () => {
  it('returns an empty log only when the path is missing', () => {
    expect(readJsonLinesStrict(path.join(root, 'missing.jsonl'))).toEqual([]);

    const directory = path.join(root, 'directory.jsonl');
    mkdirSync(directory);
    expect(() => readJsonLinesStrict(directory)).toThrow();
  });

  it('preserves a valid unterminated row and ignores only a malformed unterminated tail', () => {
    const validTail = path.join(root, 'valid-tail.jsonl');
    writeFileSync(validTail, '{"n":1}\n{"n":2}', 'utf8');
    expect(readJsonLinesStrict(validTail)).toEqual([{ n: 1 }, { n: 2 }]);

    const crashTail = path.join(root, 'crash-tail.jsonl');
    writeFileSync(crashTail, '{"n":1}\n{"unfinished":', 'utf8');
    expect(readJsonLinesStrict(crashTail, 1)).toEqual([{ n: 1 }]);
  });

  it.each([
    ['interior', '{"n":1}\nnot-json\n{"n":2}\n'],
    ['terminated final', '{"n":1}\nnot-json\n'],
  ])('rejects a malformed %s row even for a limited read', (_case, raw) => {
    const file = path.join(root, 'corrupt.jsonl');
    writeFileSync(file, raw, 'utf8');

    expect(() => readJsonLinesStrict(file, 1)).toThrow(SyntaxError);
    expect(readFileSync(file, 'utf8')).toBe(raw);
  });
});
