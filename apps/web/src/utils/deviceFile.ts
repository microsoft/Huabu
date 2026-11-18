// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import useCanvasStore from '@/store/canvasStore';

import type { FileReference } from '@huabu/shared';

/**
 * Last segment of a device path. Only Windows paths split on a backslash: on
 * other devices it is an ordinary character in a file name.
 */
export function deviceFileName(path: string): string {
  const separator = path.startsWith('/') ? '/' : /[\\/]/;
  return path.split(separator).filter(Boolean).pop() ?? path;
}

/** Node data shared by every way a device file becomes a reference card. */
export function fileReferenceData(reference: FileReference) {
  return {
    label: deviceFileName(reference.path),
    fileReference: reference,
  };
}

/** Place a reference card for a device file in the current Space. */
export function addFileReferenceNode(reference: FileReference): void {
  useCanvasStore.getState().addNode({
    nodeType: 'fileReference',
    data: { ...fileReferenceData(reference), origin: { type: 'user-created' } },
    size: { width: 400, height: 180 },
  });
}
