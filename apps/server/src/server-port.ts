// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

export const DEFAULT_SERVER_PORT = 3001;

export function resolveServerPort(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const rawValue = env.SERVER_PORT?.trim();
  if (rawValue === undefined || rawValue === '') return DEFAULT_SERVER_PORT;
  if (!/^\d+$/.test(rawValue)) {
    throw new Error('SERVER_PORT must be an integer between 1 and 65535');
  }

  const port = Number(rawValue);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('SERVER_PORT must be an integer between 1 and 65535');
  }
  return port;
}
