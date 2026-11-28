// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { ApiError, apiFetch } from './_client';
import { routes } from './_routes';

import type {
  DeviceFilesBody,
  DeviceFilesResponse,
  FileBinaryReadResult,
  FileListResult,
  FileReadResult,
} from '@huabu/shared';

export const MAX_DEVICE_FILE_DOWNLOAD_BYTES = 33_554_432;
export const MAX_DEVICE_PDF_BYTES = MAX_DEVICE_FILE_DOWNLOAD_BYTES;
export const DEVICE_BINARY_CHUNK_BYTES = 262_144;

export type DeviceBinaryErrorKind =
  | 'offline'
  | 'proxy_incompatible'
  | 'not_found'
  | 'permission_denied'
  | 'too_large'
  | 'changed'
  | 'failed';

export type DevicePdfErrorKind = DeviceBinaryErrorKind | 'invalid_pdf';

export class DevicePdfLoadError extends Error {
  constructor(
    readonly kind: DevicePdfErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'DevicePdfLoadError';
  }
}

async function requestFiles(
  body: DeviceFilesBody,
  signal?: AbortSignal,
): Promise<DeviceFilesResponse> {
  return apiFetch<DeviceFilesResponse>(routes.deviceFiles, {
    method: 'POST',
    json: body,
    signal,
    fallbackMessage: 'Filesystem request failed',
  });
}
export async function listDeviceFiles(
  agentletId: string,
  args: Extract<DeviceFilesBody, { operation: 'fs-list' }>['args'],
  signal?: AbortSignal,
): Promise<FileListResult> {
  const response = await requestFiles(
    { agentletId, operation: 'fs-list', args },
    signal,
  );
  if (response.operation !== 'fs-list')
    throw new Error('Invalid filesystem response');
  return response.result;
}
export async function readDeviceFile(
  agentletId: string,
  args: Extract<DeviceFilesBody, { operation: 'fs-read' }>['args'],
  signal?: AbortSignal,
): Promise<FileReadResult> {
  const response = await requestFiles(
    { agentletId, operation: 'fs-read', args },
    signal,
  );
  if (response.operation !== 'fs-read')
    throw new Error('Invalid filesystem response');
  return response.result;
}
export async function readDeviceFileBytes(
  agentletId: string,
  args: Extract<DeviceFilesBody, { operation: 'fs-read-bytes' }>['args'],
  signal?: AbortSignal,
): Promise<FileBinaryReadResult> {
  const response = await requestFiles(
    { agentletId, operation: 'fs-read-bytes', args },
    signal,
  );
  if (response.operation !== 'fs-read-bytes')
    throw new Error('Invalid filesystem response');
  return response.result;
}

function hasPdfMagicHeader(bytes: Uint8Array): boolean {
  // ISO 32000-1 permits `%PDF-` within the first 1024 bytes of a document.
  const limit = Math.min(bytes.length, 1024) - 5;
  for (let index = 0; index <= limit; index++) {
    if (
      bytes[index] === 0x25 &&
      bytes[index + 1] === 0x50 &&
      bytes[index + 2] === 0x44 &&
      bytes[index + 3] === 0x46 &&
      bytes[index + 4] === 0x2d
    ) {
      return true;
    }
  }
  return false;
}

function mapDevicePdfApiError(error: unknown): never {
  if (error instanceof DevicePdfLoadError) throw error;
  if (error instanceof ApiError) {
    if (error.code === 'files_disconnected' || error.status === 409) {
      throw new DevicePdfLoadError('offline', error.message);
    }
    if (
      error.code === 'files_proxy_incompatible' ||
      error.code === 'files_proxy_missing'
    ) {
      throw new DevicePdfLoadError('proxy_incompatible', error.message);
    }
    if (error.code === 'not_found' || error.status === 404) {
      throw new DevicePdfLoadError('not_found', error.message);
    }
    if (error.code === 'permission_denied' || error.status === 403) {
      throw new DevicePdfLoadError('permission_denied', error.message);
    }
    if (error.code === 'file_too_large' || error.status === 413) {
      throw new DevicePdfLoadError('too_large', error.message);
    }
    if (error.code === 'stale_cursor') {
      throw new DevicePdfLoadError('changed', error.message);
    }
    throw new DevicePdfLoadError('failed', error.message);
  }
  throw error;
}

interface LoadDeviceFileBytesInternalOptions {
  signal?: AbortSignal;
  maxBytes?: number;
  onProgress?: (loadedBytes: number, totalBytes: number) => void;
  validateFirstChunk?: (firstChunkBytes: Uint8Array) => void;
}

async function loadDeviceFileBytesInternal(
  agentletId: string,
  path: string,
  options?: LoadDeviceFileBytesInternalOptions,
): Promise<{
  bytes: Uint8Array<ArrayBuffer>;
  size: number;
  contentVersion: string;
  path: string;
}> {
  const maxBytes = options?.maxBytes ?? MAX_DEVICE_FILE_DOWNLOAD_BYTES;
  const signal = options?.signal;
  let cursor: string | undefined;
  let target: Uint8Array<ArrayBuffer> | null = null;
  let expectedSize = 0;
  let expectedVersion = '';
  let resolvedPath = path;
  let offset = 0;

  try {
    do {
      signal?.throwIfAborted();
      const chunk = await readDeviceFileBytes(
        agentletId,
        {
          path,
          limitBytes: DEVICE_BINARY_CHUNK_BYTES,
          maxSizeBytes: maxBytes,
          ...(cursor ? { cursor } : {}),
        },
        signal,
      );
      signal?.throwIfAborted();
      if (chunk.size > maxBytes) {
        throw new DevicePdfLoadError(
          'too_large',
          'File exceeds the download size limit',
        );
      }
      if (!target) {
        expectedSize = chunk.size;
        expectedVersion = chunk.contentVersion;
        resolvedPath = chunk.path;
        target = new Uint8Array(new ArrayBuffer(expectedSize));
      } else if (
        chunk.contentVersion !== expectedVersion ||
        chunk.size !== expectedSize
      ) {
        throw new DevicePdfLoadError(
          'changed',
          'File changed while reading from device',
        );
      }

      let binary: string;
      try {
        binary = atob(chunk.data);
      } catch {
        throw new DevicePdfLoadError(
          'failed',
          'Invalid binary encoding in filesystem response',
        );
      }
      if (
        binary.length !== chunk.byteLength ||
        offset + binary.length > expectedSize
      ) {
        throw new DevicePdfLoadError(
          'changed',
          'Unexpected byte length while reading from device',
        );
      }
      for (let index = 0; index < binary.length; index++) {
        target[offset + index] = binary.charCodeAt(index);
      }
      const firstChunk = offset === 0;
      offset += binary.length;
      if (firstChunk) {
        options?.validateFirstChunk?.(target.subarray(0, offset));
      }
      options?.onProgress?.(offset, expectedSize);
      cursor = chunk.nextCursor;
    } while (cursor);
  } catch (error) {
    if (
      signal?.aborted ||
      (error instanceof Error && error.name === 'AbortError')
    ) {
      throw error;
    }
    mapDevicePdfApiError(error);
  }

  if (!target || offset !== expectedSize) {
    throw new DevicePdfLoadError(
      'changed',
      'Incomplete file read; refresh to try again',
    );
  }
  return {
    bytes: target,
    size: expectedSize,
    contentVersion: expectedVersion,
    path: resolvedPath,
  };
}

export async function loadDeviceFileBytes(
  agentletId: string,
  path: string,
  options?: {
    signal?: AbortSignal;
    maxBytes?: number;
    onProgress?: (loadedBytes: number, totalBytes: number) => void;
  },
): Promise<{
  bytes: Uint8Array<ArrayBuffer>;
  size: number;
  contentVersion: string;
  path: string;
}> {
  return loadDeviceFileBytesInternal(agentletId, path, options);
}

export async function loadDevicePdfBytes(
  agentletId: string,
  path: string,
  options?: {
    signal?: AbortSignal;
    maxBytes?: number;
    onProgress?: (loadedBytes: number, totalBytes: number) => void;
  },
): Promise<{
  bytes: Uint8Array<ArrayBuffer>;
  size: number;
  contentVersion: string;
  path: string;
}> {
  return loadDeviceFileBytesInternal(agentletId, path, {
    ...options,
    maxBytes: options?.maxBytes ?? MAX_DEVICE_PDF_BYTES,
    validateFirstChunk: (firstChunk) => {
      if (
        firstChunk.length < 5 ||
        !hasPdfMagicHeader(
          firstChunk.subarray(0, Math.min(firstChunk.length, 1024)),
        )
      ) {
        throw new DevicePdfLoadError(
          'invalid_pdf',
          'File does not start with a valid PDF header',
        );
      }
    },
  });
}
