// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { agentletDeviceNameSchema } from '@huabu/shared';

import { settingsRecordKey } from '../../identity/personal-settings.js';
import { deviceNamesSchema } from '../../server-record-shapes.js';
import { getServerRecords } from '../../storage/index.js';

export async function getDeviceNames(): Promise<Record<string, string>> {
  return deviceNamesSchema.parse(
    (await getServerRecords().get(settingsRecordKey('device-names'))) ?? {},
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
