// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  DevicePdfLoadError,
  loadDeviceFileBytes,
  MAX_DEVICE_FILE_DOWNLOAD_BYTES,
} from '@/api/device-files';
import { deviceFileName } from '@/utils/deviceFile';
import {
  resolveDownloadFilename,
  triggerBlobDownload,
} from '@/utils/io/nodeDownload';

import type { TFunction } from 'i18next';

const LIMIT_MIB = Math.round(MAX_DEVICE_FILE_DOWNLOAD_BYTES / (1024 * 1024));

/**
 * Resolve a safe Save-As filename for a connected-device file path.
 * Preserves the device basename's extension (when present) and dotfile prefix,
 * while stripping OS-illegal filename characters via `resolveDownloadFilename`.
 */
export function resolveDeviceDownloadFilename(path: string): string {
  const rawName = deviceFileName(path).trim();
  const lastDot = rawName.lastIndexOf('.');
  const hasExt =
    lastDot > 0 &&
    lastDot < rawName.length - 1 &&
    /^\.[a-z0-9]{1,16}$/i.test(rawName.slice(lastDot));
  const ext = hasExt ? rawName.slice(lastDot) : '';
  const stem = hasExt ? rawName.slice(0, lastDot) : rawName;
  const leadingDot = !hasExt && rawName.startsWith('.') && rawName.length > 1;
  const resolved = resolveDownloadFilename(
    leadingDot ? rawName.slice(1) : stem,
    ext,
    'file',
  );
  return leadingDot ? `.${resolved}` : resolved;
}

export function formatDeviceDownloadError(
  error: unknown,
  t: TFunction,
): string {
  if (error instanceof DevicePdfLoadError) {
    switch (error.kind) {
      case 'offline':
        return t('files.offline');
      case 'proxy_incompatible':
        return t('files.downloadProxyIncompatible');
      case 'not_found':
        return t('files.downloadNotFound');
      case 'permission_denied':
        return t('files.downloadPermissionDenied');
      case 'too_large':
        return t('files.downloadTooLarge', { limitMiB: LIMIT_MIB });
      case 'changed':
        return t('files.changed');
      case 'invalid_pdf':
      case 'failed':
        return error.message || t('files.downloadFailed');
    }
  }
  return error instanceof Error && error.message
    ? error.message
    : t('files.downloadFailed');
}

export async function downloadDeviceFile(
  agentletId: string,
  path: string,
  options?: {
    signal?: AbortSignal;
    maxBytes?: number;
    mimeType?: string;
    onProgress?: (loadedBytes: number, totalBytes: number) => void;
  },
): Promise<void> {
  const loaded = await loadDeviceFileBytes(agentletId, path, {
    signal: options?.signal,
    maxBytes: options?.maxBytes,
    onProgress: options?.onProgress,
  });
  options?.signal?.throwIfAborted();
  const blob = new Blob([loaded.bytes], {
    type: options?.mimeType ?? 'application/octet-stream',
  });
  triggerBlobDownload(blob, resolveDeviceDownloadFilename(loaded.path || path));
}
