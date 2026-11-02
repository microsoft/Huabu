// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type { FileReference } from '../types/api/device-files.js';

export function isDeviceFilePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096)
    return false;
  for (let index = 0; index < value.length; index++) {
    if (value.charCodeAt(index) < 32) return false;
  }
  return (
    value.startsWith('/') ||
    /^[a-zA-Z]:[\\/]/.test(value) ||
    /^\\\\[^\\]+\\[^\\]+/.test(value)
  );
}

export function isFileReference(value: unknown): value is FileReference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const reference = value as Record<string, unknown>;
  return (
    typeof reference.agentletId === 'string' &&
    reference.agentletId.length > 0 &&
    reference.agentletId.length <= 255 &&
    isDeviceFilePath(reference.path) &&
    (reference.deviceName === undefined ||
      (typeof reference.deviceName === 'string' &&
        reference.deviceName.length <= 512)) &&
    Object.keys(reference).every((key) =>
      ['agentletId', 'path', 'deviceName'].includes(key),
    )
  );
}
