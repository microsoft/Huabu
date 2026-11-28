// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

export const FS_PROTOCOL_VERSION = 1;
export const FS_PROXY_CAPABILITY_KEY = 'com.microsoft.agentlet/filesystem';
export const FS_PROXY_CAPABILITY = Object.freeze({
  version: FS_PROTOCOL_VERSION,
  binaryRead: true,
});
export const FS_MAX_TEXT_BYTES = 65_536;
export const FS_MAX_BINARY_BYTES = 262_144;
export const FS_MAX_RESPONSE_BYTES = 524_288;
export const FS_MAX_ENTRIES = 100;

function readFsCapability(
  agentCapabilities: unknown,
): Record<string, unknown> | null {
  if (
    !agentCapabilities ||
    typeof agentCapabilities !== 'object' ||
    Array.isArray(agentCapabilities) ||
    !('_meta' in agentCapabilities)
  )
    return null;
  const meta = agentCapabilities._meta;
  if (
    !meta ||
    typeof meta !== 'object' ||
    Array.isArray(meta) ||
    !(FS_PROXY_CAPABILITY_KEY in meta)
  )
    return null;
  const capability = meta[FS_PROXY_CAPABILITY_KEY];
  if (
    capability === null ||
    typeof capability !== 'object' ||
    Array.isArray(capability) ||
    !('version' in capability) ||
    capability.version !== FS_PROTOCOL_VERSION
  )
    return null;
  if (
    'binaryRead' in capability &&
    capability.binaryRead !== undefined &&
    typeof capability.binaryRead !== 'boolean'
  ) {
    return null;
  }
  return capability as Record<string, unknown>;
}

export function supportsFsProtocol(agentCapabilities: unknown): boolean {
  return readFsCapability(agentCapabilities) !== null;
}

export function supportsFsBinaryRead(agentCapabilities: unknown): boolean {
  return readFsCapability(agentCapabilities)?.binaryRead === true;
}

export type FsOperation = 'fs-list' | 'fs-read' | 'fs-read-bytes';
export interface FsRequest {
  path: string;
  cursor?: string;
  limit?: number;
  limitBytes?: number;
  maxSizeBytes?: number;
  showHidden?: boolean;
}
export interface FsEntry {
  name: string;
  path: string;
  kind: 'directory' | 'file' | 'symlink' | 'other';
}
export interface FsListResult {
  path: string;
  parentPath: string;
  entries: FsEntry[];
  nextCursor?: string;
}
export interface FsReadResult {
  path: string;
  encoding: 'utf-8';
  text: string;
  byteLength: number;
  size: number;
  contentVersion: string;
  nextCursor?: string;
}
export interface FsBinaryReadResult {
  path: string;
  encoding: 'base64';
  data: string;
  byteLength: number;
  size: number;
  contentVersion: string;
  nextCursor?: string;
}
export type FsResult = FsListResult | FsReadResult | FsBinaryReadResult;
export const FS_ERROR_CODES = [
  'invalid_request',
  'permission_denied',
  'not_found',
  'not_directory',
  'unsupported_file',
  'unsupported_encoding',
  'file_too_large',
  'directory_too_large',
  'stale_cursor',
  'cancelled',
  'busy',
  'io_error',
] as const;
export type FsErrorCode = (typeof FS_ERROR_CODES)[number];
export type FsResponse =
  | { version: 1; operation: FsOperation; ok: true; result: FsResult }
  | {
      version: 1;
      operation: FsOperation;
      ok: false;
      error: { code: FsErrorCode; message: string };
    };

export function parseFsRequest(
  operation: FsOperation,
  value: unknown,
): FsRequest {
  if (
    operation !== 'fs-list' &&
    operation !== 'fs-read' &&
    operation !== 'fs-read-bytes'
  ) {
    throw new Error('Invalid filesystem operation');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected a JSON object');
  }
  const record = value as Record<string, unknown>;
  const keys =
    operation === 'fs-list'
      ? ['path', 'cursor', 'limit', 'showHidden']
      : operation === 'fs-read'
        ? ['path', 'cursor', 'limitBytes']
        : ['path', 'cursor', 'limitBytes', 'maxSizeBytes'];
  if (
    Object.keys(record).some((key) => !keys.includes(key)) ||
    typeof record.path !== 'string' ||
    record.path.length === 0 ||
    record.path.length > 4096 ||
    /[\u0000-\u001f]/.test(record.path) ||
    (record.cursor !== undefined &&
      (typeof record.cursor !== 'string' ||
        record.cursor.length === 0 ||
        record.cursor.length > 16_384)) ||
    (record.showHidden !== undefined &&
      typeof record.showHidden !== 'boolean') ||
    (record.maxSizeBytes !== undefined &&
      (typeof record.maxSizeBytes !== 'number' ||
        !Number.isSafeInteger(record.maxSizeBytes) ||
        record.maxSizeBytes < 1))
  ) {
    throw new Error('Invalid filesystem request');
  }
  const limitKey = operation === 'fs-list' ? 'limit' : 'limitBytes';
  const maximum =
    operation === 'fs-list'
      ? FS_MAX_ENTRIES
      : operation === 'fs-read'
        ? FS_MAX_TEXT_BYTES
        : FS_MAX_BINARY_BYTES;
  const minimum = operation === 'fs-read' ? 4 : 1;
  const limit = record[limitKey];
  if (
    limit !== undefined &&
    (typeof limit !== 'number' ||
      !Number.isSafeInteger(limit) ||
      limit < minimum ||
      limit > maximum)
  ) {
    throw new Error('Invalid filesystem request limit');
  }
  return {
    path: record.path,
    ...(typeof record.cursor === 'string' ? { cursor: record.cursor } : {}),
    ...(typeof record.showHidden === 'boolean'
      ? { showHidden: record.showHidden }
      : {}),
    ...(typeof limit === 'number'
      ? operation === 'fs-list'
        ? { limit }
        : { limitBytes: limit }
      : {}),
    ...(operation === 'fs-read-bytes' && typeof record.maxSizeBytes === 'number'
      ? { maxSizeBytes: record.maxSizeBytes }
      : {}),
  };
}
