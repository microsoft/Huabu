// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'dotenv';
import { expect, it } from 'vitest';

import { EncryptedFileSecretStore } from './security/encrypted-file-secret-store.js';
import { resolveStandaloneMasterKey } from './security/private-config.js';
import { SECRET_IDS } from './security/secret-ids.js';

import type {
  AgentletConnectionCommandResponse,
  DeploymentReadinessResponse,
} from '@huabu/shared';

const serverRoot = fileURLToPath(new URL('../', import.meta.url));
const serverEntry = process.env.HUABU_TEST_SERVER_ENTRY ?? 'src/server.ts';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected a TCP address');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

it('bootstraps locally, survives restart, authenticates setup remote mode, and rotates only explicitly', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'huabu-setup-process-'));
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'production',
    HUABU_DATA_DIR: join(directory, 'data'),
    HUABU_CONFIG_DIR: join(directory, 'config'),
    HUABU_SECRET_KEY: '',
    HUABU_SECRET_BRIDGE: '',
    HUABU_WORKSPACE: join(directory, 'workspace'),
    HUABU_STRUCTURED_BACKEND: 'disk',
    HUABU_BLOB_BACKEND: 'disk',
    HUABU_CONNECTION_TOKEN: '',
    HUABU_BIND_HOST: undefined,
    HUABU_PUBLIC_ORIGIN: undefined,
    HUABU_BASIC_AUTH_USER: undefined,
    HUABU_BASIC_AUTH_PASS: undefined,
    HUABU_AUTH_MODE: undefined,
    HUABU_ALLOWED_HOSTS: '127.0.0.1',
    SERVER_PORT: String(port),
    LOG_LEVEL: 'warn',
    HUABU_DEBUG_PROMPT: 'off',
    WEB_DIST_PATH: fileURLToPath(new URL('../../web/dist/', import.meta.url)),
  };
  let child: ChildProcess | undefined;
  let vite: ChildProcess | undefined;
  let remoteDaemon: ChildProcess | undefined;
  let remoteDaemonOutput = '';
  let output = '';
  let viteOutput = '';
  let authorization: string | undefined;
  const request = (path: string, options?: RequestInit) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      ...options,
      headers: {
        ...(authorization ? { Authorization: authorization } : {}),
        ...options?.headers,
      },
      signal: AbortSignal.timeout(2000),
    });
  const stop = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exit = once(child, 'exit');
    child.kill('SIGTERM');
    const timer = setTimeout(() => child?.kill('SIGKILL'), 5000);
    try {
      await exit;
    } finally {
      clearTimeout(timer);
    }
  };
  const stopRemoteDaemon = async () => {
    if (
      !remoteDaemon ||
      remoteDaemon.exitCode !== null ||
      remoteDaemon.signalCode !== null
    )
      return;
    const exit = once(remoteDaemon, 'exit');
    remoteDaemon.kill('SIGTERM');
    const timer = setTimeout(() => remoteDaemon?.kill('SIGKILL'), 5000);
    try {
      await exit;
    } finally {
      clearTimeout(timer);
    }
  };
  const waitForRemoteDaemon = async (connections: number) => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (remoteDaemon?.exitCode !== null || remoteDaemon?.signalCode !== null)
        throw new Error(`Remote daemon exited: ${remoteDaemonOutput}`);
      if (
        remoteDaemonOutput.split('"event":"daemon_ready"').length - 1 >=
        connections
      )
        return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Remote daemon reconnect timed out: ${remoteDaemonOutput}`);
  };
  const start = async () => {
    output = '';
    child = spawn(process.execPath, ['--import', 'tsx', serverEntry], {
      cwd: serverRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null)
        throw new Error(`Server failed to start: ${output}`);
      try {
        const response = await request('/api/deployment/readiness');
        if (response.ok)
          return (await response.json()) as DeploymentReadinessResponse;
      } catch (error) {
        if (!(error instanceof TypeError || error instanceof DOMException))
          throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Server readiness timed out: ${output}`);
  };
  const command = async () => {
    const response = await request('/api/acp/connection-command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        origin: `http://127.0.0.1:${port}`,
        shell: 'posix',
        format: 'env-file',
      }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    return (await response.json()) as AgentletConnectionCommandResponse;
  };
  const setup = (args: string[], input?: string) =>
    execFileSync(
      process.execPath,
      ['--import', 'tsx', 'src/setup.ts', ...args],
      { cwd: serverRoot, env, input, encoding: 'utf8', timeout: 20_000 },
    );
  const startVite = async () => {
    const webPort = await freePort();
    viteOutput = '';
    vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js'], {
      cwd: fileURLToPath(new URL('../../web/', import.meta.url)),
      env: {
        ...env,
        WEB_PORT: String(webPort),
        VITE_API_PROXY_TARGET: `http://127.0.0.1:${port}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    vite.stdout?.on('data', (chunk: Buffer) => {
      viteOutput += chunk.toString();
    });
    vite.stderr?.on('data', (chunk: Buffer) => {
      viteOutput += chunk.toString();
    });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (vite.exitCode !== null)
        throw new Error(`Vite failed to start: ${viteOutput}`);
      try {
        const response = await fetch(
          `http://127.0.0.1:${webPort}/api/deployment/readiness`,
          {
            headers: authorization ? { Authorization: authorization } : {},
            signal: AbortSignal.timeout(2000),
          },
        );
        if (response.ok) return webPort;
      } catch (error) {
        if (!(error instanceof TypeError || error instanceof DOMException))
          throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Vite readiness timed out: ${viteOutput}`);
  };
  const stopVite = async () => {
    if (!vite) return;
    const exit = once(vite, 'exit');
    vite.kill('SIGTERM');
    await exit;
    vite = undefined;
  };
  const readCredentials = async () => {
    const store = new EncryptedFileSecretStore(
      join(directory, 'data'),
      resolveStandaloneMasterKey(true, env),
    );
    await store.initialize();
    return store;
  };
  try {
    const initialCredentials = new EncryptedFileSecretStore(
      join(directory, 'data'),
      resolveStandaloneMasterKey(false, env),
    );
    await initialCredentials.initialize();
    await initialCredentials.set(
      'integration:test:preserved',
      'preserved-test-credential',
    );
    expect(setup(['--help'])).toContain(
      'Before setup, stop all Huabu servers and Vite dev servers',
    );
    expect(await start()).toMatchObject({
      bind: { scope: 'loopback' },
      credentials: { writable: true },
    });
    const first = await command();
    expect(first.source).toBe('managed');
    remoteDaemon = spawn(
      process.execPath,
      [
        fileURLToPath(
          new URL(
            '../../../external/agentlet/packages/local/dist/index.js',
            import.meta.url,
          ),
        ),
        'daemon',
        '--server',
        `ws://127.0.0.1:${port}/api/acp/agent`,
        '--allow-insecure',
        '--agentlet-id',
        'huabu-restart-test',
        '--reconnect-max',
        '1',
      ],
      {
        cwd: serverRoot,
        env: {
          ...env,
          AGENTLET_TOKEN: parse(first.content).HUABU_CONNECTION_TOKEN,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    remoteDaemon.stderr?.on('data', (chunk: Buffer) => {
      remoteDaemonOutput += chunk.toString();
    });
    await waitForRemoteDaemon(1);
    await stop();
    expect(remoteDaemon.exitCode).toBeNull();
    await start();
    await waitForRemoteDaemon(2);
    expect((await command()).content).toBe(first.content);
    await stopRemoteDaemon();
    expect(remoteDaemon.exitCode).toBe(0);
    remoteDaemon = undefined;
    await stop();

    const password = 'test-private-access-password-' + 'p'.repeat(5000);
    delete env.HUABU_WORKSPACE;
    setup(
      [
        '--remote',
        '--origin',
        'https://huabu.example',
        '--password-stdin',
        '--workspace',
        join(directory, 'workspace'),
      ],
      `${password}\n`,
    );
    expect(
      readFileSync(join(directory, 'config', 'deployment.json'), 'utf8'),
    ).not.toContain(password);
    expect(
      readFileSync(join(directory, 'data', 'encrypted-secrets.json'), 'utf8'),
    ).not.toContain(password);
    const savedCiphertext = readFileSync(
      join(directory, 'data', 'encrypted-secrets.json'),
      'utf8',
    );
    const reuseOutput = setup([
      '--remote',
      '--origin',
      'https://huabu.example',
    ]);
    expect(reuseOutput).toContain('Password configured');
    expect(reuseOutput).not.toContain(password);
    expect(
      readFileSync(join(directory, 'data', 'encrypted-secrets.json'), 'utf8'),
    ).toBe(savedCiphertext);
    authorization = `Basic ${Buffer.from(`owner:${password}`).toString('base64')}`;
    expect(await start()).toMatchObject({
      bind: { scope: 'network' },
      access: { basicAuthConfigured: true },
    });
    const workspace = await request('/api/workspace');
    expect(await workspace.json()).toMatchObject({
      configured: true,
      mode: 'managed',
    });
    const unauthenticated = await fetch(
      `http://127.0.0.1:${port}/api/acp/connection-command`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      },
    );
    expect(unauthenticated.status).toBe(401);
    const remoteCommand = parse((await command()).content);
    expect(remoteCommand.HUABU_PUBLIC_ORIGIN).toBe('https://huabu.example');
    expect(remoteCommand.HUABU_CONNECTION_TOKEN).toBe(
      parse(first.content).HUABU_CONNECTION_TOKEN,
    );
    expect(output).not.toContain(password);
    const webPort = await startVite();
    expect((await fetch(`http://127.0.0.1:${webPort}/`)).status).toBe(401);
    expect(viteOutput).not.toContain(password);
    await stopVite();
    await stop();

    const replacementPassword = 'x';
    setup(
      [
        '--remote',
        '--origin',
        'https://huabu.example',
        '--username',
        'alice',
        '--password-stdin',
      ],
      `${replacementPassword}\n`,
    );
    expect(setup(['--reset-connection-token'])).toContain(
      'Start Huabu to apply',
    );
    const credentials = await readCredentials();
    expect(credentials.get('integration:test:preserved')).toBe(
      'preserved-test-credential',
    );
    expect(credentials.get(SECRET_IDS.remoteAccessPassword)).toBe(
      replacementPassword,
    );
    expect(credentials.get(SECRET_IDS.managedConnectionToken)).not.toBe(
      remoteCommand.HUABU_CONNECTION_TOKEN,
    );
    authorization = `Basic ${Buffer.from(`alice:${replacementPassword}`).toString('base64')}`;
    await start();
    expect(
      (
        await request('/api/deployment/readiness', {
          headers: {
            Authorization: `Basic ${Buffer.from(`owner:${password}`).toString('base64')}`,
          },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await request('/api/deployment/readiness', {
          headers: {
            Authorization: `Basic ${Buffer.from(`owner:${replacementPassword}`).toString('base64')}`,
          },
        })
      ).status,
    ).toBe(401);
    expect(parse((await command()).content).HUABU_CONNECTION_TOKEN).toBe(
      credentials.get(SECRET_IDS.managedConnectionToken),
    );
    expect(
      (
        await request('/api/deployment/readiness', {
          headers: {
            Authorization: `Bearer ${remoteCommand.HUABU_CONNECTION_TOKEN}`,
          },
        })
      ).status,
    ).toBe(401);
    await stop();
    const noLoginOutput = setup([
      '--remote',
      '--origin',
      'https://huabu.example',
      '--no-login',
    ]);
    expect(noLoginOutput).toContain('Login    Disabled');
    authorization = undefined;
    expect(await start()).toMatchObject({
      bind: { scope: 'network' },
      access: { basicAuthConfigured: false },
      owner: { policy: 'unauthenticated', allowedForRequest: true },
      issues: expect.arrayContaining([
        { code: 'REMOTE_LOGIN_DISABLED', severity: 'warning' },
      ]),
    });
    expect(output).toContain('full owner access');
    const networkAddress = Object.values(networkInterfaces())
      .flat()
      .find(
        (address) => address?.family === 'IPv4' && !address.internal,
      )?.address;
    if (networkAddress) {
      const remoteOwnerResponse = await fetch(
        `http://${networkAddress}:${port}/api/acp/connection-command`,
        {
          method: 'POST',
          headers: {
            Host: 'huabu.example',
            Origin: 'https://huabu.example',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            origin: 'https://huabu.example',
            shell: 'posix',
            format: 'env-file',
          }),
          signal: AbortSignal.timeout(2000),
        },
      );
      expect(remoteOwnerResponse.status).toBe(200);
    }
    expect((await command()).content).toContain(
      credentials.get(SECRET_IDS.managedConnectionToken),
    );
    expect((await request('/api/rfs/test')).status).toBe(401);
    const noLoginWebPort = await startVite();
    expect((await fetch(`http://127.0.0.1:${noLoginWebPort}/`)).status).toBe(
      200,
    );
    expect(viteOutput).toContain('login disabled');
    await stopVite();
    await stop();
    expect((await readCredentials()).get(SECRET_IDS.remoteAccessPassword)).toBe(
      replacementPassword,
    );
    setup(
      ['--remote', '--origin', 'https://huabu.example', '--password-stdin'],
      `${replacementPassword}\n`,
    );
    authorization = `Basic ${Buffer.from(`alice:${replacementPassword}`).toString('base64')}`;
    expect(await start()).toMatchObject({
      access: { basicAuthConfigured: true },
      owner: { policy: 'loopback-or-basic-auth' },
    });
    expect(
      (await fetch(`http://127.0.0.1:${port}/api/deployment/readiness`)).status,
    ).toBe(401);
    await stop();
    setup(['--local']);
    authorization = undefined;
    env.HUABU_WORKSPACE = join(directory, 'workspace');
    expect(await start()).toMatchObject({
      bind: { scope: 'loopback' },
      access: { basicAuthConfigured: false },
    });
    expect((await command()).content).not.toBe(first.content);
    await stop();
    delete env.HUABU_WORKSPACE;
    env.HUABU_STRUCTURED_BACKEND = 'sqlite';
    env.HUABU_SQLITE_PATH = join(directory, 'huabu.sqlite');
    setup(
      ['--remote', '--origin', 'https://huabu.example', '--password-stdin'],
      `${password}\n`,
    );
    authorization = `Basic ${Buffer.from(`owner:${password}`).toString('base64')}`;
    expect(await start()).toMatchObject({ bind: { scope: 'network' } });
    const sqlWorkspace = await request('/api/workspace');
    expect(await sqlWorkspace.json()).toMatchObject({
      configured: true,
      mode: 'free',
      path: null,
    });
    await stop();
    env.HUABU_BIND_HOST = '0.0.0.0';
    env.HUABU_PUBLIC_ORIGIN = 'https://env.example';
    env.HUABU_BASIC_AUTH_USER = 'env-user';
    env.HUABU_BASIC_AUTH_PASS = 'environment-private-password';
    const environmentOutput = setup(['--remote']);
    expect(environmentOutput).toContain(
      'Address  https://env.example · environment',
    );
    expect(environmentOutput).toContain('Login    env-user · environment');
    expect(environmentOutput).toContain('Password configured · environment');
    expect(environmentOutput).not.toContain(env.HUABU_BASIC_AUTH_PASS);
    expect((await readCredentials()).get(SECRET_IDS.remoteAccessPassword)).toBe(
      password,
    );
    authorization = `Basic ${Buffer.from(`env-user:${env.HUABU_BASIC_AUTH_PASS}`).toString('base64')}`;
    expect(await start()).toMatchObject({ bind: { scope: 'network' } });
    expect(parse((await command()).content).HUABU_PUBLIC_ORIGIN).toBe(
      'https://env.example',
    );
    expect(
      (
        await request('/api/deployment/readiness', {
          headers: {
            Authorization: `Basic ${Buffer.from(`owner:${password}`).toString('base64')}`,
          },
        })
      ).status,
    ).toBe(401);
  } finally {
    await stopRemoteDaemon();
    if (vite && vite.exitCode === null) {
      const exit = once(vite, 'exit');
      vite.kill('SIGKILL');
      await exit;
    }
    await stop();
    rmSync(directory, { recursive: true, force: true });
  }
}, 120_000);
