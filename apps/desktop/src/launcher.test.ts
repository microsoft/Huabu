// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, expect, it } from 'vitest';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const driver = String.raw`
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const input = JSON.parse(process.argv[1]);
process.env = input.env;
const runtime = await import(input.runtime);
const state = { spawns: [], children: [], errors: [] };
const noop = () => {};
const spawn = (...args) => {
  state.spawns.push(args);
  return {
    on: noop,
    once: (name, callback) => { if (name === 'exit') queueMicrotask(() => callback(0)); },
  };
};
const context = vm.createContext({
  process: {
    env: input.env, argv: ['node', input.script, ...input.args],
    platform: process.platform, stdin: { isTTY: false }, on: noop,
    exit: code => { state.code = code; },
  },
  console: { log: noop, warn: noop, error: (...values) => state.errors.push(values.map(String).join(' ')) },
  setTimeout,
});
const entry = new vm.SourceTextModule(readFileSync(input.script, 'utf8'), {
  context,
  initializeImportMeta(meta) { meta.url = input.metaUrl; },
});
await entry.link(async specifier => {
  let values;
  if (specifier === 'node:child_process') values = { spawn, spawnSync: spawn };
  else if (specifier === 'node:module') values = { createRequire: () => () => '/mock/electron' };
  else if (specifier === 'node:net') values = {
    default: { connect: () => ({
      once: (name, callback) => { if (name === 'connect') queueMicrotask(callback); },
      destroy: noop,
    }) },
  };
  else if (specifier === 'dotenv') values = { default: { config: () => ({ parsed: {} }) } };
  else if (specifier.includes('client-runtime')) values = runtime;
  else if (specifier.includes('dev-child-supervisor')) values = {
    spawnSupervisedDevChild: spec => {
      state.children.push(spec);
      return { on: noop, once: noop };
    },
    waitForSupervisedDevChildren: (_children, code) => { state.code = code; },
  };
  else if (specifier.includes('dev-ports')) values = { findAvailablePort: async value => value };
  else values = await import(specifier);
  return new vm.SyntheticModule(Object.keys(values), function () {
    for (const [key, value] of Object.entries(values)) this.setExport(key, value);
  }, { context });
});
await entry.evaluate();
await new Promise(setImmediate);
process.stdout.write(JSON.stringify(state));
`;

function launch(
  hmr: boolean,
  args: string[],
  env: Record<string, string>,
  dotenv?: string,
) {
  const root = mkdtempSync(join(tmpdir(), 'desktop-launcher-'));
  directories.push(root);
  if (dotenv !== undefined) writeFileSync(join(root, '.env'), dotenv);
  writeFileSync(
    join(root, 'remote.env'),
    'HUABU_PUBLIC_ORIGIN=https://file.test\n',
  );
  writeFileSync(join(root, 'local env ; $literal.env'), '# Local HMR\n');
  const script = new URL(
    hmr ? '../../../scripts/dev-desktop.mjs' : '../scripts/dev.mjs',
    import.meta.url,
  );
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        '--no-warnings',
        '--experimental-vm-modules',
        '--input-type=module',
        '-e',
        driver,
        JSON.stringify({
          script: fileURLToPath(script),
          args,
          env: { INIT_CWD: root, ...env },
          metaUrl: pathToFileURL(join(root, 'scripts/dev-desktop.mjs')).href,
          runtime: new URL(
            '../../../packages/client-runtime/dist/desktop.js',
            import.meta.url,
          ).href,
        }),
      ],
      { encoding: 'utf8', timeout: 10_000 },
    ),
  ) as {
    spawns: [string, string[], { env: Record<string, string> }][];
    children: { command: string; args: string[]; shell: boolean }[];
    errors: string[];
    code?: number;
  };
}

it.each([['--env-file', 'remote.env'], ['--env-file=remote.env']])(
  'forwards explicit-file arguments and inherited env to Electron: %j',
  (...args) => {
    const result = launch(false, args, {
      HUABU_PUBLIC_ORIGIN: 'https://shell.test',
      ELECTRON_RUN_AS_NODE: '1',
    });
    expect(result.spawns).toHaveLength(1);
    expect(result.spawns[0][1]).toEqual(['.', ...args]);
    expect(result.spawns[0][2].env.HUABU_PUBLIC_ORIGIN).toBe(
      'https://shell.test',
    );
    expect(result.spawns[0][2].env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  },
);

it.each(['env', 'default-file', 'explicit-file', 'removed-flag'])(
  'rejects HMR remote configuration before compilation or service spawn: %s',
  (source) => {
    const result = launch(
      true,
      source === 'explicit-file'
        ? ['--env-file', 'remote.env']
        : source === 'removed-flag'
          ? ['--server=https://old.test']
          : [],
      source === 'env' ? { HUABU_PUBLIC_ORIGIN: 'https://shell.test' } : {},
      source === 'default-file'
        ? 'HUABU_PUBLIC_ORIGIN=https://default.test\n'
        : undefined,
    );
    expect(result.spawns).toEqual([]);
    expect(result.children).toEqual([]);
    expect(result.code).toBe(1);
    expect(result.errors.join('\n')).toMatch(/EXTERNAL_SERVER_URL|removed/);
  },
);

it('forwards HMR file paths literally to the Electron executable without a shell', () => {
  const args = ['--env-file', 'local env ; $literal.env'];
  const result = launch(true, args, {});
  expect(result.errors).toEqual([]);
  expect(result.children.at(-1)).toMatchObject({
    command: '/mock/electron',
    args: ['.', ...args],
    shell: false,
  });
});
