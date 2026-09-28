// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type { ExecFileOptions } from 'node:child_process';

export function mediaTargets(platform: string, arch: string): string[];

export function prepareVideoMedia(options: {
  serverRoot: string;
  platform?: string;
  arch?: string;
  runInstaller?: (
    executable: string,
    args: string[],
    options: ExecFileOptions,
  ) => Promise<unknown>;
  runAudit?: (
    executable: string,
    args: string[],
    options: ExecFileOptions,
  ) => Promise<{ stdout: string; stderr: string }>;
  buildMac?: (arch: string) => Promise<{
    directory: string;
    archive: string;
    audit: { sha256: string };
  }>;
}): Promise<void>;
