// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type { ConnectedAgentletDevice } from '@huabu/shared';

export function resolveConnectedDevice<
  T extends Pick<ConnectedAgentletDevice, 'agentletId' | 'hostname'>,
>(target: string, devices: T[]): T | undefined {
  const exact = devices.find((device) => device.agentletId === target);
  if (exact) return exact;
  const hostnameMatches = devices.filter(
    (device) => device.hostname === target,
  );
  return hostnameMatches.length === 1 ? hostnameMatches[0] : undefined;
}
