// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveDesktopServerOrigin } from '../src/desktop.js';

const directories: string[] = [];
function root() {
  const directory = mkdtempSync(join(tmpdir(), 'desktop-config spaced-'));
  directories.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('Desktop connection configuration', () => {
  it('preserves local mode without an origin or default file', () => {
    expect(
      resolveDesktopServerOrigin([], { repoRoot: root(), inherited: {} }),
    ).toBeUndefined();
    expect(resolveDesktopServerOrigin([], { inherited: {} })).toBeUndefined();
  });

  it.each([
    ['HTTP://Example.COM:80/', 'http://example.com'],
    [' https://Example.COM:443/ ', 'https://example.com'],
    ['http://127.0.0.1:3001', 'http://127.0.0.1:3001'],
    ['http://[::1]:3001/', 'http://[::1]:3001'],
    ['https://example.test:8443/', 'https://example.test:8443'],
  ])('normalizes inherited public origin %s', (input, expected) => {
    expect(
      resolveDesktopServerOrigin([], {
        inherited: { HUABU_PUBLIC_ORIGIN: input },
      }),
    ).toBe(expected);
  });

  it('uses repo-root dotenv, not upward discovery, with env taking precedence', () => {
    const repoRoot = root();
    writeFileSync(
      join(repoRoot, '.env'),
      'HUABU_PUBLIC_ORIGIN=https://file.test/\n',
    );
    expect(resolveDesktopServerOrigin([], { repoRoot, inherited: {} })).toBe(
      'https://file.test',
    );
    expect(
      resolveDesktopServerOrigin([], {
        repoRoot,
        inherited: { HUABU_PUBLIC_ORIGIN: 'https://shell.test' },
      }),
    ).toBe('https://shell.test');
    const child = join(repoRoot, 'child');
    mkdirSync(child);
    expect(
      resolveDesktopServerOrigin([], { repoRoot: child, inherited: {} }),
    ).toBeUndefined();
  });

  it.each(['--env-file', '--env-file='])(
    'uses an explicit file exclusively, with cwd-relative paths: %s',
    (option) => {
      const repoRoot = root();
      const file = join(repoRoot, 'connection.env');
      writeFileSync(
        join(repoRoot, '.env'),
        'HUABU_PUBLIC_ORIGIN=https://default.test\n',
      );
      writeFileSync(file, 'HUABU_PUBLIC_ORIGIN=https://explicit.test/\n');
      const path = relative(process.cwd(), file);
      const args =
        option === '--env-file' ? [option, path] : [`${option}${path}`];
      const options = {
        repoRoot,
        inherited: { HUABU_PUBLIC_ORIGIN: 'not-a-url' },
      };
      expect(resolveDesktopServerOrigin(args, options)).toBe(
        'https://explicit.test',
      );
      writeFileSync(file, 'UNRELATED=value\nHUABU_CONNECTION_TOKEN=ignored\n');
      expect(resolveDesktopServerOrigin(args, options)).toBeUndefined();
    },
  );

  it('never reads inherited token values or treats file tokens as authorization', () => {
    const inherited = Object.defineProperty({}, 'HUABU_CONNECTION_TOKEN', {
      enumerable: true,
      get() {
        throw new Error('Desktop must not read this credential');
      },
    });
    expect(resolveDesktopServerOrigin([], { inherited })).toBeUndefined();
    const repoRoot = root();
    writeFileSync(
      join(repoRoot, '.env'),
      'HUABU_PUBLIC_ORIGIN=https://file.test\nHUABU_CONNECTION_TOKEN=ignored\n',
    );
    expect(resolveDesktopServerOrigin([], { repoRoot, inherited })).toBe(
      'https://file.test',
    );
  });

  it('resolves pnpm source-launch paths against the original invocation directory', () => {
    const cwd = root();
    writeFileSync(
      join(cwd, 'connection.env'),
      'HUABU_PUBLIC_ORIGIN=https://invocation.test\n',
    );
    expect(
      resolveDesktopServerOrigin(['--env-file', 'connection.env'], {
        cwd,
        inherited: {},
      }),
    ).toBe('https://invocation.test');
  });

  it.each([
    '',
    '  ',
    'not-a-url',
    'file:///tmp/huabu',
    'https://user:private-password@example.test',
    'https://example.test/prefix',
    'https://example.test?mode=desktop',
    'https://example.test#fragment',
  ])(
    'fails closed on invalid env origins without echoing them: %j',
    (origin) => {
      const repoRoot = root();
      writeFileSync(
        join(repoRoot, '.env'),
        'HUABU_PUBLIC_ORIGIN=https://valid-file.test\n',
      );
      const resolve = () =>
        resolveDesktopServerOrigin([], {
          repoRoot,
          inherited: { HUABU_PUBLIC_ORIGIN: origin },
        });
      expect(resolve).toThrow(/HUABU_PUBLIC_ORIGIN/);
      expect(resolve).not.toThrow(/private-password/);
    },
  );

  it.each(['', '  ', 'https://example.test/path'])(
    'rejects invalid file origins rather than using inherited values: %j',
    (origin) => {
      const file = join(root(), 'connection.env');
      writeFileSync(file, `HUABU_PUBLIC_ORIGIN="${origin}"\n`);
      expect(() =>
        resolveDesktopServerOrigin(['--env-file', file], {
          inherited: { HUABU_PUBLIC_ORIGIN: 'https://valid-shell.test' },
        }),
      ).toThrow(/HUABU_PUBLIC_ORIGIN/);
    },
  );

  it.each([
    'HUABU_PUBLIC_ORIGIN=https://a.test\nHUABU_PUBLIC_ORIGIN=https://b.test',
    'HUABU_PUBLIC_ORIGIN="private-unclosed',
    'HUABU_PUBLIC_ORIGIN="https://a.test"extra',
    'invalid private-assignment',
    'UNRELATED=value\0',
  ])('rejects malformed files even with an env override', (text) => {
    const repoRoot = root();
    writeFileSync(join(repoRoot, '.env'), text);
    const resolve = () =>
      resolveDesktopServerOrigin([], {
        repoRoot,
        inherited: { HUABU_PUBLIC_ORIGIN: 'https://override.test' },
      });
    expect(resolve).toThrow();
    expect(resolve).not.toThrow(/private-unclosed|private-assignment/);
  });

  it('fails for explicit missing files and non-file default paths', () => {
    const repoRoot = root();
    expect(() =>
      resolveDesktopServerOrigin(
        ['--env-file', join(repoRoot, 'missing.env')],
        {
          inherited: { HUABU_PUBLIC_ORIGIN: 'https://shell.test' },
        },
      ),
    ).toThrow(/ENOENT/);
    mkdirSync(join(repoRoot, '.env'));
    expect(() =>
      resolveDesktopServerOrigin([], { repoRoot, inherited: {} }),
    ).toThrow();
  });

  it.each([
    ['--env-file'],
    ['--env-file='],
    ['--env-file', '  '],
    ['--env-file', '--other'],
    ['--env-file=a', '--env-file=b'],
    ['--env-file', 'a', '--env-file', 'b'],
  ])('rejects missing or repeated file arguments: %j', (...args) => {
    expect(() => resolveDesktopServerOrigin(args, { inherited: {} })).toThrow(
      /--env-file/,
    );
  });

  it.each(['--server', '--server=https://a.test', '--server_url'])(
    'rejects removed flags before starting local mode: %s',
    (argument) => {
      expect(() =>
        resolveDesktopServerOrigin(['electron', '.', argument], {
          inherited: {},
        }),
      ).toThrow(/removed.*HUABU_PUBLIC_ORIGIN/);
    },
  );

  it('normalizes Windows key casing and rejects env/file collisions', () => {
    expect(
      resolveDesktopServerOrigin([], {
        platform: 'win32',
        inherited: { huabu_public_origin: 'https://windows.test/' },
      }),
    ).toBe('https://windows.test');
    expect(() =>
      resolveDesktopServerOrigin([], {
        platform: 'win32',
        inherited: {
          HUABU_PUBLIC_ORIGIN: 'https://a.test',
          huabu_public_origin: 'https://b.test',
        },
      }),
    ).toThrow(/Duplicate/);
    const repoRoot = root();
    writeFileSync(
      join(repoRoot, '.env'),
      'huabu_public_origin=https://windows.test/\n',
    );
    expect(
      resolveDesktopServerOrigin([], {
        repoRoot,
        platform: 'win32',
        inherited: {},
      }),
    ).toBe('https://windows.test');
    writeFileSync(
      join(repoRoot, '.env'),
      'HUABU_PUBLIC_ORIGIN=https://a.test\nhuabu_public_origin=https://b.test',
    );
    expect(() =>
      resolveDesktopServerOrigin([], {
        repoRoot,
        platform: 'win32',
        inherited: {},
      }),
    ).toThrow(/Duplicate/);
  });

  it('rejects env/file remote targets with HMR even for the same origin', () => {
    const repoRoot = root();
    const origin = 'http://127.0.0.1:3001';
    const options = { repoRoot, inherited: {}, externalServerUrl: origin };
    expect(resolveDesktopServerOrigin([], options)).toBeUndefined();
    expect(() =>
      resolveDesktopServerOrigin([], {
        ...options,
        inherited: { HUABU_PUBLIC_ORIGIN: origin },
      }),
    ).toThrow(/EXTERNAL_SERVER_URL.*start:desktop/);
    writeFileSync(join(repoRoot, '.env'), `HUABU_PUBLIC_ORIGIN=${origin}\n`);
    expect(() => resolveDesktopServerOrigin([], options)).toThrow(
      /EXTERNAL_SERVER_URL/,
    );
  });
});
