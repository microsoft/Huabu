// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { join } from 'node:path';

import { z } from 'zod';

import { agentletDeviceNameSchema } from '@huabu/shared';

import { getDataDir } from '../../../data-dir.js';
import { atomicWriteJson, readJsonStrict } from '../../../utils/fs.js';

const deviceNamesSchema = z.record(z.string(), agentletDeviceNameSchema);

function namesPath(): string {
  return join(getDataDir(), 'agentlet-device-names.json');
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
