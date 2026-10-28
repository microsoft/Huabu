// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { apiFetch } from './_client';
import { routes } from './_routes';

import type {
  DeviceFilesBody,
  DeviceFilesResponse,
  FileListResult,
  FileReadResult,
} from '@huabu/shared';

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
