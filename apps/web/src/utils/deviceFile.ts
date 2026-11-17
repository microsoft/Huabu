// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import useCanvasStore from '@/store/canvasStore';

import type { FileReference } from '@huabu/shared';

/** Last segment of a device path, whichever separator the device uses. */
export function deviceFileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
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
