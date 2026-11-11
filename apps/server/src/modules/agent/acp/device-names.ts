// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { z } from 'zod';

import { agentletDeviceNameSchema } from '@huabu/shared';

import { atomicWriteJson, readJsonStrict } from '../../../utils/fs.js';
import { settingsFilePath } from '../../identity/personal-settings.js';

const deviceNamesSchema = z.record(z.string(), agentletDeviceNameSchema);

function namesPath(): string {
  return settingsFilePath('agentlet-device-names.json');
}

export function getDeviceNames(): Record<string, string> {
  return deviceNamesSchema.parse(readJsonStrict(namesPath()) ?? {});
}

export function renameDevice(agentletId: string, displayName: string): void {
  const names = getDeviceNames();
  atomicWriteJson(namesPath(), {
    ...names,
    [agentletId]: agentletDeviceNameSchema.parse(displayName),
  });
}
