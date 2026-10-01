// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { execFile, spawn } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import {
  canaryRedeployResultSchema,
  canaryRedeployStatusResponseSchema,
  type CanaryRedeployResult,
  type CanaryRedeployStatusResponse,
} from '@huabu/shared';

import { getDataDir } from '../../data-dir.js';
import { getLogger } from '../../utils/logger.js';

const execFileAsync = promisify(execFile);
const log = getLogger('canary-redeploy');
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const BRANCH = 'alpha' as const;

interface CanaryCapability {
  available: boolean;
  reason: CanaryRedeployStatusResponse['reason'];
  repoRoot: string | null;
  scriptPath: string | null;
  runnerPath: string | null;
  runningSha: string | null;
}

interface StoredRedeployResult {
  result: CanaryRedeployResult;
  runnerPid: number | null;
}

let cachedRemote:
  | { remoteSha: string; checkedAt: number }
  | { remoteSha: null; checkedAt: number }
  | null = null;
let redeployRequestInFlight = false;

function enabled(env: NodeJS.ProcessEnv): boolean {
  return env.HUABU_CANARY_REDEPLOY_ENABLED === '1';
}

function validSha(value: string | undefined): string | null {
  const normalized = value?.trim().toLowerCase() ?? '';
  return SHA_PATTERN.test(normalized) ? normalized : null;
}

export function resolveCanaryCapability(
  env: NodeJS.ProcessEnv = process.env,
): CanaryCapability {
  if (!enabled(env)) {
    return {
      available: false,
      reason: 'disabled',
      repoRoot: null,
      scriptPath: null,
      runnerPath: null,
      runningSha: validSha(env.HUABU_DEPLOYED_SHA),
    };
  }

  const configuredRoot = env.HUABU_REPO_ROOT;
  if (!configuredRoot) {
    return {
      available: false,
      reason: 'repository-unavailable',
      repoRoot: null,
      scriptPath: null,
      runnerPath: null,
      runningSha: validSha(env.HUABU_DEPLOYED_SHA),
    };
  }

  const repoRoot = resolve(configuredRoot);
  const scriptPath = join(repoRoot, 'scripts', 'start-huabu.sh');
  const runnerPath = join(repoRoot, 'scripts', 'canary-redeploy-runner.mjs');
  if (!existsSync(scriptPath) || !existsSync(runnerPath)) {
    return {
      available: false,
      reason: 'script-unavailable',
      repoRoot,
      scriptPath,
      runnerPath,
      runningSha: validSha(env.HUABU_DEPLOYED_SHA),
    };
  }
  try {
    accessSync(scriptPath, constants.X_OK);
  } catch {
    return {
      available: false,
      reason: 'script-unavailable',
      repoRoot,
      scriptPath,
      runnerPath,
      runningSha: validSha(env.HUABU_DEPLOYED_SHA),
    };
  }

  return {
    available: true,
    reason: 'available',
    repoRoot,
    scriptPath,
    runnerPath,
    runningSha: validSha(env.HUABU_DEPLOYED_SHA),
  };
}

export function canaryStatusPath(): string {
  return join(getDataDir(), 'canary-redeploy-status.json');
}

export function canaryLogPath(): string {
  return join(getDataDir(), 'logs', 'canary-redeploy.log');
}

async function readRedeployResult(): Promise<StoredRedeployResult | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(canaryStatusPath(), 'utf8'));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw error;
  }
  const result = canaryRedeployResultSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error('Canary redeployment status is invalid');
  }
  const runnerPid =
    parsed &&
    typeof parsed === 'object' &&
    'runnerPid' in parsed &&
    Number.isSafeInteger(parsed.runnerPid) &&
    Number(parsed.runnerPid) > 0
      ? Number(parsed.runnerPid)
      : null;
  return { result: result.data, runnerPid };
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function writeCanaryRedeployResult(
  result: CanaryRedeployResult,
): Promise<void> {
  const parsed = canaryRedeployResultSchema.parse(result);
  const statusPath = canaryStatusPath();
  await mkdir(dirname(statusPath), { recursive: true });
  const temporaryPath = `${statusPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(parsed, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await rename(temporaryPath, statusPath);
}

export async function getCanaryRedeployStatus(): Promise<CanaryRedeployStatusResponse> {
  const capability = resolveCanaryCapability();
  const storedRedeploy = await readRedeployResult();
  let redeploy = storedRedeploy?.result ?? null;
  if (
    redeploy?.state === 'running' &&
    storedRedeploy?.runnerPid !== null &&
    storedRedeploy?.runnerPid !== undefined &&
    !processIsRunning(storedRedeploy.runnerPid)
  ) {
    redeploy = {
      state: 'failed',
      startedAt: redeploy.startedAt,
      completedAt: Date.now(),
      exitCode: -1,
      message: 'Redeploy runner stopped before recording an outcome',
    };
    await writeCanaryRedeployResult(redeploy);
  }
  if (redeploy?.state === 'succeeded' || redeploy?.state === 'failed') {
    redeployRequestInFlight = false;
  }
  const remoteSha = cachedRemote?.remoteSha ?? null;
  return canaryRedeployStatusResponseSchema.parse({
    available: capability.available,
    reason: capability.reason,
    branch: BRANCH,
    runningSha: capability.runningSha,
    remoteSha,
    updateAvailable:
      capability.runningSha && remoteSha
        ? capability.runningSha !== remoteSha
        : null,
    checkedAt: cachedRemote?.checkedAt ?? null,
    redeploy,
  });
}

export async function checkCanaryRemote(): Promise<CanaryRedeployStatusResponse> {
  const capability = resolveCanaryCapability();
  if (!capability.available || !capability.repoRoot) {
    return getCanaryRedeployStatus();
  }

  const { stdout } = await execFileAsync(
    'git',
    ['ls-remote', 'origin', 'refs/heads/alpha'],
    {
      cwd: capability.repoRoot,
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    },
  );
  const remoteSha = validSha(stdout.trim().split(/\s+/)[0]);
  if (!remoteSha) {
    throw new Error('origin/alpha did not resolve to a commit');
  }
  cachedRemote = { remoteSha, checkedAt: Date.now() };
  return getCanaryRedeployStatus();
}

export async function requestCanaryRedeploy(): Promise<CanaryRedeployStatusResponse> {
  const capability = resolveCanaryCapability();
  if (
    !capability.available ||
    !capability.repoRoot ||
    !capability.scriptPath ||
    !capability.runnerPath
  ) {
    throw new Error('Canary redeployment is unavailable');
  }
  const storedRedeploy = await readRedeployResult();
  const persistentRunnerActive =
    storedRedeploy?.result.state === 'running' &&
    storedRedeploy.runnerPid !== null &&
    processIsRunning(storedRedeploy.runnerPid);
  if (redeployRequestInFlight || persistentRunnerActive) {
    throw new Error('Canary redeployment is already in progress');
  }

  await access(capability.scriptPath, constants.X_OK);
  const startedAt = Date.now();
  await writeCanaryRedeployResult({ state: 'requested', startedAt });

  const child = spawn(
    process.execPath,
    [
      capability.runnerPath,
      capability.scriptPath,
      canaryStatusPath(),
      canaryLogPath(),
      String(startedAt),
    ],
    {
      cwd: capability.repoRoot,
      detached: true,
      stdio: 'ignore',
      env: process.env,
    },
  );
  child.once('error', (error) => {
    redeployRequestInFlight = false;
    log.error({ err: error }, 'Canary redeploy runner failed to start');
    void writeCanaryRedeployResult({
      state: 'failed',
      startedAt,
      completedAt: Date.now(),
      exitCode: -1,
      message: 'Unable to start redeploy runner',
    }).catch((statusError: unknown) => {
      log.error(
        { err: statusError },
        'Unable to persist Canary runner start failure',
      );
    });
  });
  child.unref();
  redeployRequestInFlight = true;
  return getCanaryRedeployStatus();
}

export function resetCanaryRedeployStateForTest(): void {
  cachedRemote = null;
  redeployRequestInFlight = false;
}
