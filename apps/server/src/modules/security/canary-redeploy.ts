// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { execFile, execFileSync, spawn } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { z } from 'zod';

import {
  canaryBranchSchema,
  canaryRedeployResultSchema,
  canaryRedeployStatusResponseSchema,
  type CanaryBranch,
  type CanaryRedeployConfigUpdate,
  type CanaryRedeployResult,
  type CanaryRedeployStatusResponse,
} from '@huabu/shared';

import { getDataDir } from '../../data-dir.js';
import { atomicWriteJson, readJsonStrict } from '../../utils/fs.js';
import { getLogger } from '../../utils/logger.js';

const execFileAsync = promisify(execFile);
const log = getLogger('canary-redeploy');
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const DEFAULT_BRANCH = 'alpha';

const configRecordSchema = z
  .object({
    version: z.literal(1),
    branch: canaryBranchSchema.nullable(),
  })
  .strict();

const legacyRedeployResultSchema = canaryRedeployResultSchema.omit({
  branch: true,
});

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

type CanaryOperation = 'check' | 'configure' | 'redeploy';

let cachedRemote: {
  branch: CanaryBranch;
  remoteSha: string;
  checkedAt: number;
} | null = null;
let activeOperation: CanaryOperation | null = null;
let redeployRequestInFlight = false;

export class CanaryRedeployError extends Error {
  constructor(
    readonly code:
      | 'branch_invalid'
      | 'branch_unavailable'
      | 'config_invalid'
      | 'operation_in_progress'
      | 'redeploy_unavailable'
      | 'stale_branch',
    message: string,
  ) {
    super(message);
    this.name = 'CanaryRedeployError';
  }
}

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

export function canaryConfigPath(): string {
  return join(getDataDir(), 'canary-redeploy-config.json');
}

export function canaryStatusPath(): string {
  return join(getDataDir(), 'canary-redeploy-status.json');
}

export function canaryLogPath(): string {
  return join(getDataDir(), 'logs', 'canary-redeploy.log');
}

function readCanaryConfig(): {
  branch: CanaryBranch;
  configuredBranch: CanaryBranch | null;
} {
  let stored: unknown;
  try {
    stored = readJsonStrict<unknown>(canaryConfigPath());
  } catch {
    throw new CanaryRedeployError(
      'config_invalid',
      'Stored Canary branch configuration is unreadable',
    );
  }
  if (stored === null) {
    return { branch: DEFAULT_BRANCH, configuredBranch: null };
  }
  const parsed = configRecordSchema.safeParse(stored);
  if (!parsed.success) {
    throw new CanaryRedeployError(
      'config_invalid',
      'Stored Canary branch configuration is invalid',
    );
  }
  try {
    validateBranchFormat(parsed.data.branch ?? DEFAULT_BRANCH);
  } catch {
    throw new CanaryRedeployError(
      'config_invalid',
      'Stored Canary branch configuration is invalid',
    );
  }
  return {
    branch: parsed.data.branch ?? DEFAULT_BRANCH,
    configuredBranch: parsed.data.branch,
  };
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
  const current = canaryRedeployResultSchema.safeParse(parsed);
  let result: CanaryRedeployResult;
  if (current.success) {
    result = current.data;
  } else {
    const legacy = legacyRedeployResultSchema.safeParse(parsed);
    if (!legacy.success) {
      throw new Error('Canary redeployment status is invalid');
    }
    result = { ...legacy.data, branch: DEFAULT_BRANCH };
  }
  const runnerPid =
    parsed &&
    typeof parsed === 'object' &&
    'runnerPid' in parsed &&
    Number.isSafeInteger(parsed.runnerPid) &&
    Number(parsed.runnerPid) > 0
      ? Number(parsed.runnerPid)
      : null;
  return { result, runnerPid };
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function redeployIsActive(): Promise<boolean> {
  const stored = await readRedeployResult();
  if (
    stored?.result.state === 'succeeded' ||
    stored?.result.state === 'failed'
  ) {
    redeployRequestInFlight = false;
    return false;
  }
  const persistentRunnerActive = Boolean(
    stored?.result.state === 'running' &&
    stored.runnerPid !== null &&
    processIsRunning(stored.runnerPid),
  );
  return (
    persistentRunnerActive ||
    (redeployRequestInFlight &&
      (stored?.result.state === 'requested' ||
        stored?.result.state === 'running'))
  );
}

async function beginOperation(operation: CanaryOperation): Promise<void> {
  if (activeOperation) {
    throw new CanaryRedeployError(
      'operation_in_progress',
      'Another Canary operation is already in progress',
    );
  }
  activeOperation = operation;
  try {
    if (await redeployIsActive()) {
      throw new CanaryRedeployError(
        'operation_in_progress',
        'Canary redeployment is already in progress',
      );
    }
  } catch (error) {
    activeOperation = null;
    throw error;
  }
}

function validateBranchFormat(branch: CanaryBranch): void {
  if (branch.startsWith('-')) {
    throw new CanaryRedeployError(
      'branch_invalid',
      `Invalid Canary branch: ${branch}`,
    );
  }
  try {
    execFileSync('git', ['check-ref-format', '--branch', branch], {
      stdio: 'ignore',
      timeout: 5_000,
    });
    execFileSync('git', ['check-ref-format', `refs/heads/${branch}`], {
      stdio: 'ignore',
      timeout: 5_000,
    });
  } catch {
    throw new CanaryRedeployError(
      'branch_invalid',
      `Invalid Canary branch: ${branch}`,
    );
  }
}

async function resolveRemoteBranch(
  repoRoot: string,
  branch: CanaryBranch,
): Promise<string> {
  validateBranchFormat(branch);
  const fullRef = `refs/heads/${branch}`;
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      'git',
      ['ls-remote', '--exit-code', '--refs', 'origin', fullRef],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 10_000,
        maxBuffer: 64 * 1024,
      },
    ));
  } catch {
    throw new CanaryRedeployError(
      'branch_unavailable',
      `Unable to resolve origin/${branch}`,
    );
  }
  const fields = stdout.trim().split(/\s+/);
  const remoteSha = validSha(fields[0]);
  if (!remoteSha || fields[1] !== fullRef || fields.length !== 2) {
    throw new CanaryRedeployError(
      'branch_unavailable',
      `Unable to resolve origin/${branch}`,
    );
  }
  return remoteSha;
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
  const config = readCanaryConfig();
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
      branch: redeploy.branch,
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
  const remote = cachedRemote?.branch === config.branch ? cachedRemote : null;
  return canaryRedeployStatusResponseSchema.parse({
    available: capability.available,
    reason: capability.reason,
    branch: config.branch,
    configuredBranch: config.configuredBranch,
    runningSha: capability.runningSha,
    remoteSha: remote?.remoteSha ?? null,
    updateAvailable:
      capability.runningSha && remote?.remoteSha
        ? capability.runningSha !== remote.remoteSha
        : null,
    checkedAt: remote?.checkedAt ?? null,
    redeploy,
  });
}

export async function setCanaryRedeployConfig(
  update: CanaryRedeployConfigUpdate,
): Promise<CanaryRedeployStatusResponse> {
  const capability = resolveCanaryCapability();
  if (!capability.available || !capability.repoRoot) {
    throw new CanaryRedeployError(
      'redeploy_unavailable',
      'Canary redeployment is unavailable',
    );
  }
  await beginOperation('configure');
  try {
    const branch = update.branch ?? DEFAULT_BRANCH;
    const remoteSha = await resolveRemoteBranch(capability.repoRoot, branch);
    atomicWriteJson(canaryConfigPath(), {
      version: 1,
      branch: update.branch,
    });
    cachedRemote = { branch, remoteSha, checkedAt: Date.now() };
    return await getCanaryRedeployStatus();
  } finally {
    activeOperation = null;
  }
}

export async function checkCanaryRemote(): Promise<CanaryRedeployStatusResponse> {
  const capability = resolveCanaryCapability();
  if (!capability.available || !capability.repoRoot) {
    return getCanaryRedeployStatus();
  }
  await beginOperation('check');
  try {
    const { branch } = readCanaryConfig();
    const remoteSha = await resolveRemoteBranch(capability.repoRoot, branch);
    cachedRemote = { branch, remoteSha, checkedAt: Date.now() };
    return await getCanaryRedeployStatus();
  } finally {
    activeOperation = null;
  }
}

export async function requestCanaryRedeploy(
  expectedBranch: CanaryBranch,
): Promise<CanaryRedeployStatusResponse> {
  const capability = resolveCanaryCapability();
  if (
    !capability.available ||
    !capability.repoRoot ||
    !capability.scriptPath ||
    !capability.runnerPath
  ) {
    throw new CanaryRedeployError(
      'redeploy_unavailable',
      'Canary redeployment is unavailable',
    );
  }
  await beginOperation('redeploy');
  let branch: CanaryBranch | null = null;
  let startedAt: number | null = null;
  try {
    branch = readCanaryConfig().branch;
    if (expectedBranch !== branch) {
      throw new CanaryRedeployError(
        'stale_branch',
        `Canary branch changed from ${expectedBranch} to ${branch}; review and confirm again`,
      );
    }
    const remoteSha = await resolveRemoteBranch(capability.repoRoot, branch);
    cachedRemote = { branch, remoteSha, checkedAt: Date.now() };
    await access(capability.scriptPath, constants.X_OK);
    startedAt = Date.now();
    await writeCanaryRedeployResult({
      state: 'requested',
      branch,
      startedAt,
    });

    const child = spawn(
      process.execPath,
      [
        capability.runnerPath,
        capability.scriptPath,
        canaryStatusPath(),
        canaryLogPath(),
        String(startedAt),
        branch,
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
        branch: branch ?? DEFAULT_BRANCH,
        startedAt: startedAt ?? Date.now(),
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
    return await getCanaryRedeployStatus();
  } finally {
    activeOperation = null;
  }
}

export function resetCanaryRedeployStateForTest(): void {
  cachedRemote = null;
  activeOperation = null;
  redeployRequestInFlight = false;
}
