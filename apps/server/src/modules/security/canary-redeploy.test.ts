// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { execFile, execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
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
    serviceManager: process.env.HUABU_SERVICE_MANAGER,
    path: process.env.PATH,
  };

  beforeEach(() => {
    deploymentEnvironment = getDeploymentEnvironment();
    root = mkdtempSync(join(tmpdir(), 'huabu-canary-repo-'));
    remote = mkdtempSync(join(tmpdir(), 'huabu-canary-remote-'));
    dataDir = mkdtempSync(join(tmpdir(), 'huabu-canary-data-'));
    mkdirSync(join(root, 'scripts'));
    for (const name of [
      'start-huabu.sh',
      'build-web.mjs',
      'canary-redeploy-runner.mjs',
    ]) {
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
    delete process.env.HUABU_SERVICE_MANAGER;
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
    restore('HUABU_SERVICE_MANAGER', originalEnv.serviceManager);
    restore('PATH', originalEnv.path);
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

  it('uses the readable build entry instead of the legacy shell for systemd', () => {
    process.env.HUABU_SERVICE_MANAGER = 'systemd-user';
    rmSync(join(root, 'scripts', 'start-huabu.sh'));
    chmodSync(join(root, 'scripts', 'build-web.mjs'), 0o644);
    expect(resolveCanaryCapability()).toMatchObject({
      available: true,
      scriptPath: join(root, 'scripts', 'build-web.mjs'),
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

  it('starts a separate systemd user unit and sends credentials only through stdin', async () => {
    const bin = join(root, 'bin');
    const resultPath = join(dataDir, 'systemd-launch.json');
    mkdirSync(bin);
    const launcher = join(bin, 'systemd-run');
    writeFileSync(
      launcher,
      `#!${process.execPath}
const { readFileSync, writeFileSync } = require('node:fs');
const { createInterface } = require('node:readline');
(async () => {
const input = createInterface({ input: process.stdin });
const lines = input[Symbol.asyncIterator]();
const environment = JSON.parse((await lines.next()).value);
const result = {
  args: process.argv.slice(2),
  passwordMatches: environment.HUABU_CANARY_BASIC_AUTH_PASS === 'saved-test-password',
};
process.stdout.write('Huabu redeploy runner ready ' + process.pid + '\\n');
const confirmation = (await lines.next()).value;
const status = JSON.parse(readFileSync(${JSON.stringify(join(dataDir, 'canary-redeploy-status.json'))}, 'utf8'));
writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({
  ...result,
  confirmed: confirmation === 'Huabu redeploy runner accepted',
  runningPersisted: status.state === 'running' && status.runnerPid === process.pid,
}));
input.close();
process.stdin.destroy();
})();
`,
    );
    chmodSync(launcher, 0o755);
    process.env.PATH = `${bin}:${process.env.PATH}`;
    process.env.HUABU_SERVICE_MANAGER = 'systemd-user';
    installDeploymentEnvironment({
      HUABU_BASIC_AUTH_USER: 'owner',
      HUABU_BASIC_AUTH_PASS: 'saved-test-password',
    });

    await expect(requestCanaryRedeploy('alpha')).resolves.toMatchObject({
      redeploy: { branch: 'alpha' },
    });
    await expect
      .poll(() => JSON.parse(readFileSync(resultPath, 'utf8')))
      .toMatchObject({ confirmed: true, runningPersisted: true });
    const launch = JSON.parse(readFileSync(resultPath, 'utf8'));
    expect(launch.passwordMatches).toBe(true);
    expect(launch.args).toEqual([
      '--user',
      '--quiet',
      '--collect',
      '--pipe',
      '--service-type=exec',
      '--unit=huabu-redeploy.service',
      '--expand-environment=no',
      `--working-directory=${root}`,
      process.execPath,
      join(root, 'scripts', 'canary-redeploy-runner.mjs'),
      join(root, 'scripts', 'build-web.mjs'),
      join(dataDir, 'canary-redeploy-status.json'),
      join(dataDir, 'logs', 'canary-redeploy.log'),
      expect.stringMatching(/^\d+$/u),
      'alpha',
      '--environment-stdin',
    ]);
    expect(JSON.stringify(launch)).not.toContain('saved-test-password');
    expect(
      readFileSync(join(dataDir, 'canary-redeploy-status.json'), 'utf8'),
    ).not.toContain('saved-test-password');
  });

  it('records systemd admission failures without leaving a requested deployment', async () => {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const launcher = join(bin, 'systemd-run');
    writeFileSync(launcher, '#!/usr/bin/env bash\nexit 7\n');
    chmodSync(launcher, 0o755);
    process.env.PATH = `${bin}:${process.env.PATH}`;
    process.env.HUABU_SERVICE_MANAGER = 'systemd-user';
    await expect(requestCanaryRedeploy('alpha')).rejects.toMatchObject({
      code: 'redeploy_unavailable',
    });
    await expect(getCanaryRedeployStatus()).resolves.toMatchObject({
      redeploy: { state: 'failed', message: 'Unable to start redeploy runner' },
    });
  });

  it('prevents a late runner from deploying or overwriting a timed-out admission', async () => {
    const bin = join(root, 'bin');
    const finished = join(dataDir, 'late-launcher-finished');
    const executed = join(dataDir, 'unexpected-build');
    mkdirSync(bin);
    writeFileSync(
      join(root, 'scripts', 'canary-redeploy-runner.mjs'),
      readFileSync(
        new URL(
          '../../../../../scripts/canary-redeploy-runner.mjs',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    writeFileSync(
      join(root, 'scripts', 'build-web.mjs'),
      `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(executed)}, 'executed');
process.exit(7);
`,
    );
    const launcher = join(bin, 'systemd-run');
    writeFileSync(
      launcher,
      `#!${process.execPath}
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
setTimeout(() => {
  const nodeIndex = process.argv.indexOf(${JSON.stringify(process.execPath)}, 2);
  const child = spawn(process.execPath, process.argv.slice(nodeIndex + 1), { stdio: 'inherit' });
  child.once('error', () => writeFileSync(${JSON.stringify(finished)}, 'spawn failed'));
  child.once('close', () => writeFileSync(${JSON.stringify(finished)}, 'finished'));
}, 11000);
`,
    );
    chmodSync(launcher, 0o755);
    process.env.PATH = `${bin}:${process.env.PATH}`;
    process.env.HUABU_SERVICE_MANAGER = 'systemd-user';

    await expect(requestCanaryRedeploy('alpha')).rejects.toMatchObject({
      code: 'redeploy_unavailable',
    });
    const rejectedStatus = readFileSync(
      join(dataDir, 'canary-redeploy-status.json'),
      'utf8',
    );
    expect(JSON.parse(rejectedStatus)).toMatchObject({
      state: 'failed',
      exitCode: -1,
      message: 'Unable to start redeploy runner',
    });
    await expect.poll(() => existsSync(finished), { timeout: 5000 }).toBe(true);
    expect(existsSync(executed)).toBe(false);
    expect(
      readFileSync(join(dataDir, 'canary-redeploy-status.json'), 'utf8'),
    ).toBe(rejectedStatus);
  }, 20_000);

  it('receives the systemd runner environment without persisting probe credentials', () => {
    const hook = join(root, 'stdin-hook.sh');
    const statusPath = join(dataDir, 'stdin-status.json');
    const logPath = join(dataDir, 'stdin.log');
    writeFileSync(
      hook,
      '#!/usr/bin/env bash\n[[ "$HUABU_CANARY_BASIC_AUTH_PASS" == "probe-test-password" ]]\n',
    );
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
        statusPath,
        logPath,
        '100',
        'alpha',
        '--environment-stdin',
      ],
      {
        encoding: 'utf8',
        input: `${JSON.stringify({
          ...process.env,
          HUABU_CANARY_BASIC_AUTH_PASS: 'probe-test-password',
        })}\nHuabu redeploy runner accepted\n`,
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(
      /^Huabu redeploy runner ready [1-9][0-9]*\n$/u,
    );
    expect(JSON.parse(readFileSync(statusPath, 'utf8'))).toMatchObject({
      state: 'succeeded',
      branch: 'alpha',
    });
    expect(readFileSync(statusPath, 'utf8')).not.toContain(
      'probe-test-password',
    );
    expect(readFileSync(logPath, 'utf8')).not.toContain('probe-test-password');
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
