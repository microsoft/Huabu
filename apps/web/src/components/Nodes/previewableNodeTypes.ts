// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Node types that have an expanded preview. Kept apart from the preview
 * component registry so navigation helpers can ask the question without
 * importing every preview component.
 */
export const PREVIEWABLE_NODE_TYPES = [
  'fileReference',
  'note',
  'web',
  'pdf',
  'office',
  'image',
  'video',
  'sketch',
] as const;

export type PreviewableNodeType = (typeof PREVIEWABLE_NODE_TYPES)[number];

export const hasNodePreview = (nodeType: string): boolean =>
  (PREVIEWABLE_NODE_TYPES as readonly string[]).includes(nodeType);
