// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { z } from 'zod';

import { agentletDeviceNameSchema } from '@huabu/shared';

import { settingsRecordKey } from '../../identity/personal-settings.js';
import { getServerRecords } from '../../storage/index.js';

const deviceNamesSchema = z.record(z.string(), agentletDeviceNameSchema);

export function getDeviceNames(): Record<string, string> {
  return deviceNamesSchema.parse(
    getServerRecords().get(settingsRecordKey('device-names')) ?? {},
  );
}

export async function renameDevice(
  agentletId: string,
  displayName: string,
): Promise<void> {
  const name = agentletDeviceNameSchema.parse(displayName);
  await getServerRecords().update(
    settingsRecordKey('device-names'),
    (current) => ({
      ...deviceNamesSchema.parse(current ?? {}),
      [agentletId]: name,
    }),
  );
}
