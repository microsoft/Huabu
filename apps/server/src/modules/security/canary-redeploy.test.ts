// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { execFile, execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  checkCanaryRemote,
  getCanaryRedeployStatus,
  requestCanaryRedeploy,
  resetCanaryRedeployStateForTest,
  resolveCanaryCapability,
  setCanaryRedeployConfig,
  writeCanaryRedeployResult,
} from './canary-redeploy.js';
import {
  getDeploymentEnvironment,
  installDeploymentEnvironment,
  resolveDeploymentEnvironment,
} from '../../security/deployment-settings.js';

describe('Canary readiness probe', () => {
  it.each(['saved', 'environment'])(
    'authenticates the tracked script probe with %s credentials',
    async (source) => {
      const script = readFileSync(
        new URL('../../../../../scripts/start-huabu.sh', import.meta.url),
        'utf8',
      );
      const probe = script.match(
        /if node --input-type=module -e '([\s\S]*?)' "\$server_port"/u,
      )?.[1];
      if (!probe) throw new Error('Tracked Canary readiness probe not found');
      const expected = Buffer.from(
        source === 'saved'
          ? 'saved-owner:saved-password'
          : 'environment-owner:environment-password',
      ).toString('base64');
      const server = createServer((request, response) => {
        response.writeHead(
          request.url === '/api/deployment/readiness' &&
            request.headers.authorization === `Basic ${expected}`
            ? 200
            : 401,
        );
        response.end();
      });
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      try {
        const address = server.address();
        if (!address || typeof address === 'string') {
          throw new Error('Readiness fixture did not bind a TCP port');
        }
        await promisify(execFile)(
          process.execPath,
          ['--input-type=module', '-e', probe, String(address.port)],
          {
            timeout: 10_000,
            env: {
              ...process.env,
              HUABU_BASIC_AUTH_USER: 'environment-owner',
              HUABU_BASIC_AUTH_PASS: 'environment-password',
              HUABU_CANARY_BASIC_AUTH_USER:
                source === 'saved' ? 'saved-owner' : undefined,
              HUABU_CANARY_BASIC_AUTH_PASS:
                source === 'saved' ? 'saved-password' : undefined,
            },
          },
        );
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  );
});

describe('Canary redeployment service', () => {
  let root: string;
  let remote: string;
  let dataDir: string;
  let deploymentEnvironment: NodeJS.ProcessEnv;
  const originalEnv = {
    enabled: process.env.HUABU_CANARY_REDEPLOY_ENABLED,
    repoRoot: process.env.HUABU_REPO_ROOT,
    deployedSha: process.env.HUABU_DEPLOYED_SHA,
    dataDir: process.env.HUABU_DATA_DIR,
    username: process.env.HUABU_BASIC_AUTH_USER,
    password: process.env.HUABU_BASIC_AUTH_PASS,
  };

  beforeEach(() => {
    deploymentEnvironment = getDeploymentEnvironment();
    root = mkdtempSync(join(tmpdir(), 'huabu-canary-repo-'));
    remote = mkdtempSync(join(tmpdir(), 'huabu-canary-remote-'));
    dataDir = mkdtempSync(join(tmpdir(), 'huabu-canary-data-'));
    mkdirSync(join(root, 'scripts'));
    for (const name of ['start-huabu.sh', 'canary-redeploy-runner.mjs']) {
      const file = join(root, 'scripts', name);
      writeFileSync(file, '#!/usr/bin/env bash\nexit 0\n');
      chmodSync(file, 0o755);
    }

    execFileSync('git', ['init', '--bare', remote]);
    execFileSync('git', ['init', '-b', 'alpha'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'canary@example.test'], {
      cwd: root,
    });
    execFileSync('git', ['config', 'user.name', 'Canary Test'], { cwd: root });
    writeFileSync(join(root, 'README.md'), 'canary\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'Initial Canary revision'], {
      cwd: root,
    });
    execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: root });
    execFileSync('git', ['push', '-u', 'origin', 'alpha'], { cwd: root });

    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
    process.env.HUABU_CANARY_REDEPLOY_ENABLED = '1';
    process.env.HUABU_REPO_ROOT = root;
    process.env.HUABU_DEPLOYED_SHA = sha;
    process.env.HUABU_DATA_DIR = dataDir;
    resetCanaryRedeployStateForTest();
  });

  afterEach(() => {
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore('HUABU_CANARY_REDEPLOY_ENABLED', originalEnv.enabled);
    restore('HUABU_REPO_ROOT', originalEnv.repoRoot);
    restore('HUABU_DEPLOYED_SHA', originalEnv.deployedSha);
    restore('HUABU_DATA_DIR', originalEnv.dataDir);
    restore('HUABU_BASIC_AUTH_USER', originalEnv.username);
    restore('HUABU_BASIC_AUTH_PASS', originalEnv.password);
    installDeploymentEnvironment(deploymentEnvironment);
    resetCanaryRedeployStateForTest();
    rmSync(root, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('requires explicit enablement and executable repository scripts', () => {
    expect(resolveCanaryCapability()).toMatchObject({
      available: true,
      reason: 'available',
      repoRoot: root,
    });

    delete process.env.HUABU_CANARY_REDEPLOY_ENABLED;
    expect(resolveCanaryCapability()).toMatchObject({
      available: false,
      reason: 'disabled',
    });
  });

  it('compares the startup revision with origin/alpha', async () => {
    const status = await checkCanaryRemote();
    expect(status).toMatchObject({
      available: true,
      branch: 'alpha',
      configuredBranch: null,
      updateAvailable: false,
      runningSha: status.remoteSha,
    });
    expect(status.checkedAt).toEqual(expect.any(Number));
  });

  it('persists and checks one exact nested origin branch', async () => {
    execFileSync('git', ['branch', 'x/alpha'], { cwd: root });
    execFileSync('git', ['push', 'origin', 'x/alpha'], { cwd: root });

    await expect(
      setCanaryRedeployConfig({ branch: 'x/alpha' }),
    ).resolves.toMatchObject({
      branch: 'x/alpha',
      configuredBranch: 'x/alpha',
      updateAvailable: false,
    });
    await expect(checkCanaryRemote()).resolves.toMatchObject({
      branch: 'x/alpha',
      configuredBranch: 'x/alpha',
    });

    expect(
      JSON.parse(
        readFileSync(join(dataDir, 'canary-redeploy-config.json'), 'utf8'),
      ),
    ).toEqual({ version: 1, branch: 'x/alpha' });
  });

  it('uses alpha only for an explicit reset and rejects invalid or unavailable refs', async () => {
    await expect(
      setCanaryRedeployConfig({ branch: '-bad' }),
    ).rejects.toMatchObject({ code: 'branch_invalid' });
    await expect(
      setCanaryRedeployConfig({ branch: 'HEAD' }),
    ).rejects.toMatchObject({ code: 'branch_invalid' });
    await expect(
      setCanaryRedeployConfig({ branch: 'missing' }),
    ).rejects.toMatchObject({ code: 'branch_unavailable' });
    await expect(
      setCanaryRedeployConfig({ branch: null }),
    ).resolves.toMatchObject({
      branch: 'alpha',
      configuredBranch: null,
    });
  });

  it('fails explicitly for malformed persisted configuration', async () => {
    writeFileSync(
      join(dataDir, 'canary-redeploy-config.json'),
      '{"version":1,"branch":"bad..branch"}',
    );
    await expect(getCanaryRedeployStatus()).rejects.toMatchObject({
      code: 'config_invalid',
    });
  });

  it('rejects stale confirmations and configuration changes during a persistent redeploy', async () => {
    await expect(requestCanaryRedeploy('x/alpha')).rejects.toMatchObject({
      code: 'stale_branch',
    });

    writeFileSync(
      join(dataDir, 'canary-redeploy-status.json'),
      JSON.stringify({
        state: 'running',
        branch: 'alpha',
        startedAt: 10,
        runnerPid: process.pid,
      }),
    );
    await expect(
      setCanaryRedeployConfig({ branch: null }),
    ).rejects.toMatchObject({
      code: 'operation_in_progress',
    });
  });

  it('persists only the bounded redeployment result contract', async () => {
    await writeCanaryRedeployResult({
      state: 'failed',
      branch: 'x/alpha',
      startedAt: 10,
      completedAt: 20,
      exitCode: 1,
      message: 'Redeploy script exited with status 1',
    });

    await expect(getCanaryRedeployStatus()).resolves.toMatchObject({
      redeploy: {
        state: 'failed',
        branch: 'x/alpha',
        exitCode: 1,
      },
    });
  });

  it.each(['basic', 'none'] as const)(
    'passes effective %s authentication only through probe-specific runner variables',
    async (authentication) => {
      delete process.env.HUABU_BASIC_AUTH_USER;
      delete process.env.HUABU_BASIC_AUTH_PASS;
      installDeploymentEnvironment(
        resolveDeploymentEnvironment(
          {},
          {
            version: 1,
            remoteAccess: {
              enabled: true,
              authentication,
              publicOrigin: 'https://canary.example',
              workspacePath: join(root, 'home'),
            },
          },
          authentication === 'basic' ? 'saved-test-password' : null,
        ),
      );
      const resultPath = join(dataDir, 'runner-environment.json');
      writeFileSync(
        join(root, 'scripts/canary-redeploy-runner.mjs'),
        `import { writeFileSync } from 'node:fs';
           writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({
             usernameMatches: process.env.HUABU_CANARY_BASIC_AUTH_USER === 'owner',
             passwordMatches: process.env.HUABU_CANARY_BASIC_AUTH_PASS === 'saved-test-password',
             standardCredentialsPresent: process.env.HUABU_BASIC_AUTH_USER !== undefined || process.env.HUABU_BASIC_AUTH_PASS !== undefined,
             passwordInArguments: process.argv.some(value => value.includes('saved-test-password')),
           }));`,
      );
      await expect(requestCanaryRedeploy('alpha')).resolves.toMatchObject({
        redeploy: { state: 'requested' },
      });
      await expect
        .poll(() => JSON.parse(readFileSync(resultPath, 'utf8')), {
          timeout: 5000,
        })
        .toEqual({
          usernameMatches: authentication === 'basic',
          passwordMatches: authentication === 'basic',
          standardCredentialsPresent: false,
          passwordInArguments: false,
        });
      expect(process.env.HUABU_BASIC_AUTH_USER).toBeUndefined();
      expect(process.env.HUABU_BASIC_AUTH_PASS).toBeUndefined();
      expect(process.env.HUABU_CANARY_BASIC_AUTH_PASS).toBeUndefined();
      expect(
        readFileSync(join(dataDir, 'canary-redeploy-status.json'), 'utf8'),
      ).not.toContain('saved-test-password');
    },
  );

  it('records a detached runner failure without exposing command output', () => {
    const hook = join(root, 'failing-hook.sh');
    const statusPath = join(dataDir, 'runner-status.json');
    const logPath = join(dataDir, 'runner.log');
    writeFileSync(hook, '#!/usr/bin/env bash\necho private-output\nexit 7\n');
    chmodSync(hook, 0o755);

    const runner = join(
      process.cwd(),
      '..',
      '..',
      'scripts',
      'canary-redeploy-runner.mjs',
    );
    const result = spawnSync(
      process.execPath,
      [runner, hook, statusPath, logPath, '100', 'x/alpha'],
      { encoding: 'utf8' },
    );

    expect(result.status).toBe(1);
    const status = readFileSync(statusPath, 'utf8');
    expect(JSON.parse(status)).toMatchObject({
      state: 'failed',
      branch: 'x/alpha',
      startedAt: 100,
      exitCode: 7,
    });
    expect(status).not.toContain('private-output');
    expect(readFileSync(logPath, 'utf8')).toContain('Redeploying x/alpha');
    expect(readFileSync(logPath, 'utf8')).toContain('private-output');
  });

  it('rejects malformed runner branch arguments before executing the hook', () => {
    const marker = join(dataDir, 'unexpected-hook-run');
    const hook = join(root, 'marker-hook.sh');
    writeFileSync(hook, `#!/usr/bin/env bash\ntouch '${marker}'\n`);
    chmodSync(hook, 0o755);
    const runner = join(
      process.cwd(),
      '..',
      '..',
      'scripts',
      'canary-redeploy-runner.mjs',
    );

    const result = spawnSync(
      process.execPath,
      [
        runner,
        hook,
        join(dataDir, 'invalid-status.json'),
        join(dataDir, 'invalid.log'),
        '100',
        '-bad',
      ],
      { encoding: 'utf8' },
    );

    expect(result.status).toBe(2);
    expect(() => readFileSync(marker)).toThrow();
  });
});
