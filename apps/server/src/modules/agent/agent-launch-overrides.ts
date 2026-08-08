// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import path from 'node:path';

import type { AgentLaunchOverrides } from '@huabu/shared';

export const MAX_AGENT_WORKING_DIR_PATH_LENGTH = 4096;
export const MAX_AGENT_ADDITIONAL_PREAMBLE_BYTES = 16 * 1024;

export class InvalidAgentLaunchOverridesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidAgentLaunchOverridesError';
  }
}

function isAbsolutePath(value: string): boolean {
  return (
    path.isAbsolute(value) ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.startsWith('\\\\')
  );
}

/** Validate persisted or incoming launch overrides at the application boundary. */
export function parseAgentLaunchOverrides(
  value: unknown,
): AgentLaunchOverrides | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidAgentLaunchOverridesError(
      'Agent launch overrides must be an object',
    );
  }

  const record = value as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter(
    (key) => key !== 'workingDirPath' && key !== 'additionalInitialPreamble',
  );
  if (unknownKeys.length > 0) {
    throw new InvalidAgentLaunchOverridesError(
      `Unknown Agent launch override: ${unknownKeys[0]}`,
    );
  }

  const workingDirPath = record.workingDirPath;
  if (
    workingDirPath !== undefined &&
    (typeof workingDirPath !== 'string' ||
      workingDirPath.length === 0 ||
      workingDirPath.trim() !== workingDirPath ||
      workingDirPath.length > MAX_AGENT_WORKING_DIR_PATH_LENGTH ||
      !isAbsolutePath(workingDirPath))
  ) {
    throw new InvalidAgentLaunchOverridesError(
      `workingDirPath must be an absolute path no longer than ${MAX_AGENT_WORKING_DIR_PATH_LENGTH} characters`,
    );
  }

  const additionalInitialPreamble = record.additionalInitialPreamble;
  if (
    additionalInitialPreamble !== undefined &&
    (typeof additionalInitialPreamble !== 'string' ||
      additionalInitialPreamble.trim().length === 0 ||
      Buffer.byteLength(additionalInitialPreamble, 'utf8') >
        MAX_AGENT_ADDITIONAL_PREAMBLE_BYTES)
  ) {
    throw new InvalidAgentLaunchOverridesError(
      `additionalInitialPreamble must be non-empty and no longer than ${MAX_AGENT_ADDITIONAL_PREAMBLE_BYTES} UTF-8 bytes`,
    );
  }

  if (workingDirPath === undefined && additionalInitialPreamble === undefined) {
    return undefined;
  }
  return {
    ...(typeof workingDirPath === 'string' ? { workingDirPath } : {}),
    ...(typeof additionalInitialPreamble === 'string'
      ? { additionalInitialPreamble }
      : {}),
  };
}
