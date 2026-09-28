// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { parseArtifactRef } from '@huabu/shared';

/** Accept only artifacts owned by this Space, never arbitrary filesystem paths. */
export function videoArtifactKey(
  src: string,
  canvasId: string,
): string | undefined {
  const ref = parseArtifactRef(src.trim());
  if (!ref || (ref.canvasId !== null && ref.canvasId !== canvasId))
    return undefined;
  if (
    !ref.key ||
    /[/\\]/.test(ref.key) ||
    ref.key.includes('\0') ||
    ref.key === '.' ||
    ref.key === '..'
  )
    return undefined;
  return ref.key;
}

/** Legacy artifact API URLs and bare keys identify the same source. */
export function canonicalVideoSrc(src: unknown, canvasId: string): string {
  if (typeof src !== 'string') return '';
  return videoArtifactKey(src, canvasId) ?? src.trim();
}
