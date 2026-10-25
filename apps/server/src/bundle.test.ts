// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import archiver from 'archiver';
import { build } from 'tsup';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import {
  buildHuabuBootstrapEnv,
  resolveRuntimeArtifacts,
} from '../../../packages/client-runtime/src/bootstrap.js';
import clientRuntimeConfig from '../../../packages/client-runtime/tsup.config.js';
import bundleConfig from '../tsup.config.js';
import { getBundledServicePackages } from './modules/services/package-loader.js';

const configured =
  typeof bundleConfig === 'function' ? await bundleConfig({}) : bundleConfig;
const configurations = Array.isArray(configured) ? configured : [configured];

describe('server bundle runtime', () => {
  it('ships and loads every Service package in the desktop resource layout', async () => {
    const desktopConfig = parse(
      readFileSync(path.resolve('../desktop/electron-builder.yml'), 'utf8'),
    );
    const serviceResource = desktopConfig.extraResources.find(
      (resource: { from: string }) =>
        resource.from === '../server/dist-bundle/services',
    );
    expect(serviceResource).toEqual({
      from: '../server/dist-bundle/services',
      to: 'server/services',
      filter: ['**/*', '!**/*.test.*'],
    });

    const directory = mkdtempSync(path.join(tmpdir(), 'huabu-services-'));
    try {
      const resources = path.join(directory, 'resources');
      const sourceRoot = path.resolve('src/services');
      const packagedRoot = path.join(resources, serviceResource.to);
      const exclusions: string[] = serviceResource.filter
        .filter((pattern: string) => pattern.startsWith('!'))
        .map((pattern: string) => pattern.slice(1));
      cpSync(sourceRoot, packagedRoot, {
        recursive: true,
        filter: (source) =>
          !exclusions.some((pattern) =>
            path.matchesGlob(path.relative(sourceRoot, source), pattern),
          ),
      });
      const isTestFile = (file: string) =>
        path.matchesGlob(file, '**/*.test.*');
      expect(
        readdirSync(sourceRoot, {
          recursive: true,
          encoding: 'utf8',
        }).some(isTestFile),
      ).toBe(true);
      expect(
        readdirSync(packagedRoot, {
          recursive: true,
          encoding: 'utf8',
        }).some(isTestFile),
      ).toBe(false);
      const entry = path.join(resources, 'server/server.mjs');
      await build({
        ...configurations[0],
        config: false,
        entry: {
          server: path.resolve('src/modules/services/package-loader.ts'),
        },
        outDir: path.dirname(entry),
        outExtension: () => ({ js: '.mjs' }),
        onSuccess: undefined,
        silent: true,
      });
      const summarize =
        '(m) => [...m.getBundledServicePackages()].map(([id, p]) => [id, p.contentHash])';
      const output = execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `const m = await import(process.argv[1]); console.log(JSON.stringify((${summarize})(m)));`,
          pathToFileURL(entry).href,
        ],
        { cwd: directory, encoding: 'utf8' },
      );
      expect(JSON.parse(output)).toEqual(
        [...getBundledServicePackages()].map(([id, service]) => [
          id,
          service.contentHash,
        ]),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('loads real Agentlet and client-runtime artifacts outside the workspace without node_modules', async () => {
    const directory = realpathSync(
      mkdtempSync(path.join(tmpdir(), 'huabu-real-runtime-')),
    );
    try {
      writeFileSync(path.join(directory, 'package.json'), '{"type":"module"}');
      await build({
        ...configurations[1],
        config: false,
        entry: {
          index: path.resolve(
            '../../external/agentlet/packages/local/src/index.ts',
          ),
          'device-info': path.resolve(
            '../../external/agentlet/packages/local/src/device-info.ts',
          ),
        },
        outDir: path.join(directory, 'agentlet'),
        onSuccess: undefined,
        silent: true,
      });
      const runtimeOptions =
        typeof clientRuntimeConfig === 'function'
          ? await clientRuntimeConfig({})
          : clientRuntimeConfig;
      if (Array.isArray(runtimeOptions))
        throw new Error('Expected one runtime build config');
      await build({
        ...runtimeOptions,
        config: false,
        dts: false,
        entry: {
          'service-sdk': path.resolve(
            '../../packages/client-runtime/src/service-sdk.ts',
          ),
          daemon: path.resolve('../../packages/client-runtime/src/daemon.ts'),
          rfs: path.resolve('../../packages/client-runtime/src/rfs.ts'),
          desktop: path.resolve('../../packages/client-runtime/src/desktop.ts'),
        },
        outDir: path.join(directory, 'client-runtime'),
        silent: true,
      });
      const daemonHelp = execFileSync(
        process.execPath,
        [path.join(directory, 'agentlet/index.js'), 'daemon', '--help'],
        { encoding: 'utf8' },
      );
      expect(daemonHelp).toContain('--env-inject');
      const deviceInfo = JSON.parse(
        execFileSync(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            'const m = await import(process.argv[1]); console.log(JSON.stringify(await m.readDesktopDeviceInfo(process.argv[2])));',
            pathToFileURL(path.join(directory, 'client-runtime/desktop.js'))
              .href,
            path.join(directory, 'agentlet/index.js'),
          ],
          {
            cwd: directory,
            encoding: 'utf8',
            env: { ...process.env, HOME: directory, USERPROFILE: directory },
          },
        ),
      );
      expect(deviceInfo).toMatchObject({
        agentletId: expect.any(String),
        displayName: expect.any(String),
        version: expect.any(String),
      });
      const desktopOrigin = execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          'const m = await import(process.argv[1]); console.log(m.resolveDesktopServerOrigin([], { inherited: { HUABU_PUBLIC_ORIGIN: "https://EXAMPLE.test:443/" } }));',
          pathToFileURL(path.join(directory, 'client-runtime/desktop.js')).href,
        ],
        { cwd: directory, encoding: 'utf8' },
      );
      expect(desktopOrigin.trim()).toBe('https://example.test');
      const hostHelp = execFileSync(
        process.execPath,
        [path.join(directory, 'client-runtime/daemon.js'), '--help'],
        { encoding: 'utf8' },
      );
      expect(hostHelp).toContain('pnpm start:daemon');
      const rfsHelp = execFileSync(
        process.execPath,
        [path.join(directory, 'client-runtime/rfs.js'), '--help'],
        {
          encoding: 'utf8',
          env: { ...process.env, HUABU_RFS_URL: '', AGENTLET_TOKEN: '' },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      expect(rfsHelp).toContain('Operation response bodies and SSE are raw');
      const bootstrap = buildHuabuBootstrapEnv(
        resolveRuntimeArtifacts({ bundleDir: directory }),
      );
      const rfsEntry = bootstrap.HUABU_RFS_ENTRY;
      if (!rfsEntry) throw new Error('Expected built RFS entry');
      expect(rfsEntry).toBe(path.join(directory, 'client-runtime/rfs.js'));
      expect(bootstrap.HUABU_SERVICE_SDK_URL).toBe(
        pathToFileURL(path.join(directory, 'client-runtime/service-sdk.js'))
          .href,
      );
      const original = ' {"type":"FUTURE","unknown":true}\n';
      const mockServer = createServer((request, response) => {
        if (request.url === '/rfs/space/skill') {
          expect(request.headers['x-huabu-skill-client']).toBe('rfs-cli');
          response.end(
            '# CLI root guide\n\n# Space-specific Skills\nUse team vocabulary.',
          );
          return;
        }
        if (request.url === '/rfs/space/download/services/image-gen.zip') {
          const archive = archiver('zip');
          archive.on('error', (error) => response.destroy(error));
          archive.append('id: image-gen', { name: 'image-gen/service.yaml' });
          archive.append('# Package Skill', { name: 'image-gen/SKILL.md' });
          archive.append('throw new Error("do not execute");', {
            name: 'image-gen/entry.mjs',
          });
          archive.pipe(response);
          void archive.finalize();
          return;
        }
        let body = '';
        request.on('data', (chunk) => {
          body += chunk;
        });
        request.on('end', () => {
          expect(request.url).toBe('/rfs/space/query');
          expect(request.headers.authorization).toBe('Bearer mock-token');
          expect(body).toBe(original);
          response.end('{"business":false,"future":1}\n');
        });
      });
      await new Promise<void>((resolve) =>
        mockServer.listen(0, '127.0.0.1', resolve),
      );
      try {
        const address = mockServer.address();
        if (!address || typeof address === 'string')
          throw new Error('Expected test port');
        const rfsBase = `http://127.0.0.1:${address.port}/rfs/space`;
        const child = spawn(
          process.execPath,
          [rfsEntry, 'query', '--json-file', '-'],
          {
            env: {
              HUABU_RFS_URL: rfsBase,
              AGENTLET_TOKEN: 'mock-token',
            },
            stdio: ['pipe', 'pipe', 'pipe'],
          },
        );
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => {
          stdout += chunk;
        });
        child.stderr.on('data', (chunk) => {
          stderr += chunk;
        });
        child.stdin.end(original);
        const [code] = await once(child, 'close');
        expect(code).toBe(0);
        expect(stdout).toBe('{"business":false,"future":1}\n');
        expect(stderr).toBe('');
        async function invoke(args: string[]) {
          const subprocess = spawn(process.execPath, [rfsEntry, ...args], {
            env: {
              HUABU_RFS_URL: rfsBase,
              AGENTLET_TOKEN: 'mock-token',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let stdout = '';
          let stderr = '';
          subprocess.stdout.on('data', (chunk) => {
            stdout += chunk;
          });
          subprocess.stderr.on('data', (chunk) => {
            stderr += chunk;
          });
          const [code] = await once(subprocess, 'close');
          return { code, stdout, stderr };
        }
        const root = await invoke(['get-skill']);
        expect(root.code).toBe(0);
        expect(root.stdout).toContain('Usage: huabu-rfs');
        expect(root.stdout).toContain('Use team vocabulary.');
        const downloaded = await invoke([
          'service',
          'download',
          'image-gen',
          '--out-folder',
          path.join(directory, 'services'),
        ]);
        expect(downloaded.code).toBe(0);
        expect(downloaded.stderr).toBe('');
        expect(
          readFileSync(
            path.join(directory, 'services/image-gen/SKILL.md'),
            'utf8',
          ),
        ).toBe('# Package Skill');
      } finally {
        mockServer.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          mockServer.close((error) => (error ? reject(error) : resolve())),
        );
      }
      const sdkProbe = execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          'const sdk = await import(process.argv[1]); console.log(typeof sdk.leaseService, typeof sdk.withServiceContext)',
          pathToFileURL(path.join(directory, 'client-runtime/service-sdk.js'))
            .href,
        ],
        { encoding: 'utf8' },
      );
      expect(sdkProbe.trim()).toBe('function function');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it.each(configurations)(
    'loads prefix-only Node built-ins with the $outDir configuration',
    async (configuration) => {
      const directory = mkdtempSync(path.join(tmpdir(), 'huabu-bundle-test-'));
      try {
        const entry = path.join(directory, 'probe.ts');
        writeFileSync(
          entry,
          `import { createRequire as __createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const localRequire = __createRequire(import.meta.url);
const database = new DatabaseSync(':memory:');
writeFileSync(process.argv[2], JSON.stringify({
  ...database.prepare('SELECT 42 AS answer').get(),
  fsType: typeof localRequire('node:fs').readFileSync,
}));
database.close();
`,
        );
        const outDir = path.join(directory, 'dist');
        // Exercise the production bundler options with a small real entry.
        // Only redirect artifacts and omit production asset copying.
        await build({
          ...configuration,
          config: false,
          entry: { probe: entry },
          outDir,
          outExtension: () => ({ js: '.mjs' }),
          onSuccess: undefined,
          silent: true,
        });
        const resultFile = path.join(directory, 'result.json');
        execFileSync(
          process.execPath,
          [path.join(outDir, 'probe.mjs'), resultFile],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
        );
        expect(JSON.parse(readFileSync(resultFile, 'utf8'))).toEqual({
          answer: 42,
          fsType: 'function',
        });
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
