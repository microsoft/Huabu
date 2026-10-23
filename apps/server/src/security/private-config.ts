// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { getDataDir } from '../data-dir.js';
import { parseServerMasterKey } from './encrypted-file-secret-store.js';
import { resolveDirectChildPath } from '../utils/fs.js';

export function getConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.HUABU_CONFIG_DIR) {
    if (!isAbsolute(env.HUABU_CONFIG_DIR)) {
      throw new Error('HUABU_CONFIG_DIR must be an absolute path');
    }
    return resolve(env.HUABU_CONFIG_DIR);
  }
  const instance = createHash('sha256')
    .update(resolve(getDataDir(env)))
    .digest('hex')
    .slice(0, 24);
  return join(homedir(), '.huabu', 'servers', instance);
}

function assertPrivatePath(path: string, directory: boolean): void {
  const stat = lstatSync(path);
  if (
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile())
  ) {
    throw new Error(
      `Expected a regular private ${directory ? 'directory' : 'file'}: ${path}`,
    );
  }
  if (
    process.platform !== 'win32' &&
    ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())
  ) {
    throw new Error(
      `Huabu private storage must be owned by the current user with no group/other permissions: ${path}`,
    );
  }
  if (process.platform === 'win32') {
    const script = [
      "$ErrorActionPreference = 'Stop';",
      '$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;',
      '$acl = Get-Acl -LiteralPath $env:HUABU_PRIVATE_PATH;',
      "$trusted = @($sid, 'S-1-5-18', 'S-1-5-32-544');",
      '$owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;',
      "if ($owner -notin $trusted) { throw 'Huabu private storage has an untrusted owner' };",
      '$rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]);',
      "foreach ($rule in $rules) { if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin $trusted) { throw 'Huabu private storage grants access to another account' } };",
    ].join(' ');
    execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        windowsHide: true,
        stdio: 'pipe',
        env: { ...process.env, HUABU_PRIVATE_PATH: path },
      },
    );
  }
}

export function ensurePrivateConfigDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const directory = getConfigDir(env);
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (process.platform === 'win32') {
      const identity = execFileSync('whoami', ['/user', '/fo', 'csv', '/nh'], {
        encoding: 'utf8',
        windowsHide: true,
      });
      const sid = identity.match(/S-1-\d+(?:-\d+)+/)?.[0];
      if (!sid)
        throw new Error(
          'Unable to determine the Windows user SID for private storage',
        );
      execFileSync(
        'icacls',
        [directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`],
        { windowsHide: true, stdio: 'pipe' },
      );
    }
  }
  assertPrivatePath(directory, true);
  return directory;
}

export function readPrivateText(path: string): string {
  assertPrivatePath(path, false);
  return readFileSync(path, 'utf8');
}

/** Publish only a fully written key; a concurrent initializer must reuse it. */
export function resolveStandaloneMasterKey(
  encryptedStoreExists: boolean,
  env: NodeJS.ProcessEnv = process.env,
): Buffer {
  const directory = ensurePrivateConfigDir(env);
  const path = resolveDirectChildPath(directory, 'master-key');
  if (existsSync(path)) return parseServerMasterKey(readPrivateText(path));
  if (encryptedStoreExists) {
    throw new Error(
      'The existing credential store needs its original HUABU_SECRET_KEY or private master-key file. Restore the key; Huabu will not replace it.',
    );
  }
  const temporary = resolveDirectChildPath(
    directory,
    `master-key-${process.pid}-${randomBytes(8).toString('hex')}.tmp`,
  );
  try {
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(fd, randomBytes(32).toString('base64'), 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(temporary, path);
    } catch (error) {
      if (
        !(error instanceof Error && 'code' in error && error.code === 'EEXIST')
      )
        throw error;
    }
  } finally {
    rmSync(temporary, { force: true });
  }
  return parseServerMasterKey(readPrivateText(path));
}
