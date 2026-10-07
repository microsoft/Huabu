// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

describe('Canary redeployment service', () => {
  let root: string;
  let remote: string;
  let dataDir: string;
  const originalEnv = {
    enabled: process.env.HUABU_CANARY_REDEPLOY_ENABLED,
    repoRoot: process.env.HUABU_REPO_ROOT,
    deployedSha: process.env.HUABU_DEPLOYED_SHA,
    dataDir: process.env.HUABU_DATA_DIR,
  };

  beforeEach(() => {
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
