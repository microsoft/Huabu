// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

export type MissingFileKind = 'sidecar' | 'artifact';

export interface MissingFileData {
  contentMissing?: boolean;
  artifactMissing?: boolean;
}

export function getMissingFileKind(
  data: Record<string, unknown> | MissingFileData,
): MissingFileKind | null {
  if (data.contentMissing === true) return 'sidecar';
  if (data.artifactMissing === true) return 'artifact';
  return null;
}

export function hasMissingFile(
  data: Record<string, unknown> | MissingFileData,
): boolean {
  return getMissingFileKind(data) !== null;
}
