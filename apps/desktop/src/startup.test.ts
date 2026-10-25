// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const compiledMain = ts.transpileModule(
  readFileSync(new URL('./main.ts', import.meta.url), 'utf8'),
  {
    fileName: 'main.ts',
    compilerOptions: {
      module: ts.ModuleKind.Node16,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  },
).outputText;

// Execute the emitted CommonJS shell with real ESM runtime artifacts, but no
// Electron, network, native vault, shell, or child-process side effects.
const runner = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const [entry, input] = process.argv.slice(2);
const options = JSON.parse(input);
process.env = options.env;
const state = { errors: [], forks: [], ipc: [], windows: [], probes: 0, vaults: 0, agents: 0, auth: 0, imports: [] };
let ready;
const noop = () => {};
const fakeProcess = {
  ...process,
  env: options.env,
  argv: ['Huabu', ...(options.args || [])],
  resourcesPath: options.resources,
  on: noop, once: noop,
  stdout: new EventEmitter(), stderr: new EventEmitter(),
};
class Window {
  constructor(config) {
    state.windows.push(config);
    this.webContents = { on: noop, setWindowOpenHandler: noop, send: noop, openDevTools: noop };
  }
  on() {}
  once() {}
  isDestroyed() { return false; }
  loadURL(url) { state.url = url; }
}
const electron = {
  app: {
    isPackaged: options.packaged,
    setName: noop, requestSingleInstanceLock: () => true,
    whenReady: () => ({ then: callback => { ready = callback; } }),
    on: noop, quit: () => { state.quit = true; },
    getPath: () => path.join(options.root, 'user-data'),
  },
  BrowserWindow: Window,
  dialog: { showErrorBox: (title, message) => state.errors.push(message) },
  ipcMain: { handle: name => state.ipc.push(name) },
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: value => value, decryptString: value => value,
  },
  utilityProcess: {
    fork: (entry, args, options) => {
      state.forks.push({ entry, args, env: options.env });
      return new EventEmitter();
    },
  },
  net: {
    fetch: async (url, init) => {
      state.probes++;
      state.probeUrl = url;
      state.redirect = init.redirect;
      if (options.basic && state.probes === 1)
        return new Response(null, { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Huabu"' } });
      if (options.failure) return new Response(null, { status: options.failure });
      return Response.json({ bind: {}, access: {}, owner: {}, transport: {}, issues: [] });
    },
  },
  session: { defaultSession: { webRequest: { onHeadersReceived: noop } } },
};
const nativeRequire = require;
function mockedRequire(id) {
  if (id === 'electron') return electron;
  if (id === 'node:fs') return {
    ...fs, existsSync: file => file.endsWith('server.js'),
    mkdirSync: noop,
  };
  if (id === 'node:child_process') return {
    execFile: (_shell, _args, _options, callback) => callback(null, '__HUABU_PATH__:/usr/bin'),
  };
  if (id === 'node:net') return {
    connect: (_port, _host, callback) => {
      const socket = new EventEmitter();
      socket.destroy = noop;
      queueMicrotask(callback);
      return socket;
    },
  };
  if (id === './local-agent.js') return {
    LocalAgentManager: class { restore() { state.agents++; } },
  };
  if (id === './mac-menu.js') return { applyApplicationMenu: noop, registerMenuIpc: noop };
  if (id === './remote-basic-auth.js') return {
    promptForRemoteBasicAuth: async () => ({ username: 'owner', password: 'test-password' }),
    registerRemoteBasicAuth: () => state.auth++,
  };
  if (id === './secure-secrets.js') return {
    DesktopSecureSecretStore: class {
      constructor() { state.vaults++; }
      snapshot() { return {}; }
    },
  };
  if (id === './server-target.js') return nativeRequire(options.serverTarget);
  if (id === './title-bar.js') return { TITLE_BAR_HEIGHT: 36 };
  if (id === './updater.js') return { registerUpdaterIpc: noop, startAutoUpdateChecks: noop };
  return nativeRequire(id);
}
const context = vm.createContext({
  require: mockedRequire, exports: {}, __dirname: path.dirname(entry),
  process: fakeProcess, Buffer, URL, AbortSignal,
  console: { log: noop, warn: noop, error: noop },
  setTimeout: () => ({ unref: noop }), clearTimeout: noop,
});
const script = new vm.Script(fs.readFileSync(entry, 'utf8'), {
  filename: entry,
  importModuleDynamically: specifier => {
    state.imports.push(specifier);
    if (specifier === 'get-port') return import('data:text/javascript,export default async () => 3001');
    return import(specifier);
  },
});
script.runInContext(context);
Promise.resolve().then(() => ready()).then(() => {
  process.stdout.write(JSON.stringify(state));
}).catch(error => { console.error(error); process.exitCode = 1; });
`;

interface StartupResult {
  errors: string[];
  forks: { env: Record<string, string> }[];
  ipc: string[];
  windows: { webPreferences: { additionalArguments: string[] } }[];
  url?: string;
  probes: number;
  probeUrl?: string;
  redirect?: string;
  vaults: number;
  agents: number;
  auth: number;
  quit?: boolean;
  imports: string[];
}

function startup(
  packaged: boolean,
  options: {
    env?: Record<string, string>;
    dotenv?: string;
    file?: string;
    args?: string[];
    basic?: boolean;
    failure?: number;
    missingRuntime?: boolean;
  } = {},
): StartupResult {
  const root = mkdtempSync(join(tmpdir(), 'desktop-startup-'));
  directories.push(root);
  const entry = join(root, 'apps/desktop/dist/main.js');
  const resources = join(root, 'resources');
  const runtimeDir = packaged
    ? join(resources, 'server/client-runtime')
    : join(root, 'packages/client-runtime/dist');
  mkdirSync(dirname(entry), { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  if (!options.missingRuntime)
    copyFileSync(
      resolve('../../packages/client-runtime/dist/desktop.js'),
      join(runtimeDir, 'desktop.js'),
    );
  writeFileSync(join(runtimeDir, 'package.json'), '{"type":"module"}');
  writeFileSync(entry, compiledMain);
  const serverTarget = join(root, 'server-target.cjs');
  writeFileSync(
    serverTarget,
    ts.transpileModule(
      readFileSync(new URL('./server-target.ts', import.meta.url), 'utf8'),
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2020,
        },
      },
    ).outputText,
  );
  if (options.dotenv !== undefined)
    writeFileSync(join(root, '.env'), options.dotenv);
  if (options.file !== undefined)
    writeFileSync(join(root, 'connection.env'), options.file);
  const runnerPath = join(root, 'runner.cjs');
  writeFileSync(runnerPath, runner);
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        '--no-warnings',
        '--experimental-vm-modules',
        runnerPath,
        entry,
        JSON.stringify({
          ...options,
          root,
          resources,
          packaged,
          serverTarget,
          env: { INIT_CWD: root, ...options.env },
        }),
      ],
      { encoding: 'utf8', cwd: root, timeout: 10_000 },
    ),
  );
}

describe.each([false, true])(
  'compiled Desktop startup (packaged=%s)',
  (packaged) => {
    it('selects env remote mode without local Server, vault or folder-picker resources', () => {
      const result = startup(packaged, {
        env: {
          HUABU_PUBLIC_ORIGIN: 'https://EXAMPLE.test:443/',
          HUABU_CONNECTION_TOKEN: 'ignored',
        },
        basic: true,
      });
      expect(result.errors).toEqual([]);
      expect(result.url).toBe('https://example.test');
      expect(result.probeUrl).toBe(
        'https://example.test/api/deployment/readiness',
      );
      expect(result.redirect).toBe('manual');
      expect(result.probes).toBe(2);
      expect(result.auth).toBe(1);
      expect(result.forks).toEqual([]);
      expect(result.vaults).toBe(0);
      expect(result.ipc).not.toContain('dialog:pick-folder');
      expect(result.windows[0].webPreferences.additionalArguments).toEqual([
        '--huabu-remote-server',
      ]);
      expect(result.agents).toBe(1);
      expect(result.imports[0]).toContain(
        packaged
          ? '/resources/server/client-runtime/desktop.js'
          : '/packages/client-runtime/dist/desktop.js',
      );
    });

    it('retains local startup and secret bridge without a configured origin', () => {
      const result = startup(packaged);
      expect(result.errors).toEqual([]);
      expect(result.url).toBe('http://127.0.0.1:3001');
      expect(result.vaults).toBe(1);
      expect(result.forks).toHaveLength(1);
      expect(result.forks[0].env.HUABU_SECRET_BRIDGE).toBe('1');
      expect(result.ipc).toContain('dialog:pick-folder');
      expect(result.windows[0].webPreferences.additionalArguments).toEqual([]);
      expect(result.probes).toBe(0);
      expect(result.agents).toBe(0);
    });

    it('loads default dotenv only for source startup', () => {
      const result = startup(packaged, {
        dotenv: 'HUABU_PUBLIC_ORIGIN=https://file.test\n',
      });
      expect(result.errors).toEqual([]);
      expect(result.url).toBe(
        packaged ? 'http://127.0.0.1:3001' : 'https://file.test',
      );
    });

    it('uses only an explicit file and forwards its relative path correctly', () => {
      const result = startup(packaged, {
        args: ['--env-file', 'connection.env'],
        file: 'HUABU_PUBLIC_ORIGIN=https://explicit.test\n',
        env: { HUABU_PUBLIC_ORIGIN: 'invalid' },
      });
      expect(result.errors).toEqual([]);
      expect(result.url).toBe('https://explicit.test');
    });

    it.each(['', 'invalid'])(
      'fails before local resources for an invalid env origin: %j',
      (origin) => {
        const result = startup(packaged, {
          env: { HUABU_PUBLIC_ORIGIN: origin },
        });
        expect(result.errors[0]).toContain('HUABU_PUBLIC_ORIGIN');
        expect(result.quit).toBe(true);
        expect(result.forks).toEqual([]);
        expect(result.ipc).toEqual([]);
        expect(result.vaults).toBe(0);
      },
    );

    it('rejects removed flags and missing runtime artifacts instead of falling back', () => {
      expect(
        startup(packaged, { args: ['--server', 'https://old.test'] }).errors[0],
      ).toMatch(/removed.*HUABU_PUBLIC_ORIGIN/);
      const result = startup(packaged, { missingRuntime: true });
      expect(result.errors[0]).toContain('desktop.js');
      expect(result.forks).toEqual([]);
      expect(result.quit).toBe(true);
    });

    it('does not navigate or fall back locally after readiness rejection', () => {
      const result = startup(packaged, {
        env: { HUABU_PUBLIC_ORIGIN: 'https://example.test' },
        failure: 403,
      });
      expect(result.errors[0]).toContain('HUABU_ALLOWED_HOSTS');
      expect(result.url).toBeUndefined();
      expect(result.forks).toEqual([]);
      expect(result.vaults).toBe(0);
    });
  },
);

it('rejects HMR conflicts before initializing native resources', () => {
  const result = startup(false, {
    dotenv: 'HUABU_PUBLIC_ORIGIN=http://127.0.0.1:3001\n',
    env: { EXTERNAL_SERVER_URL: 'http://127.0.0.1:3001' },
  });
  expect(result.errors[0]).toContain('EXTERNAL_SERVER_URL');
  expect(result.ipc).toEqual([]);
  expect(result.forks).toEqual([]);
  expect(result.windows).toEqual([]);
});
