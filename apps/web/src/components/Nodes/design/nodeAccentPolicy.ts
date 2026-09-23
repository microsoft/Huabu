// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { resolveAccent } from '@huabu/shared';

const TRUE_NO_ACCENT_TYPES = new Set(['image', 'video', 'text']);
const DEFAULT_WHITE_ACCENT_TYPES = new Set([
  'audio',
  'frame',
  'note',
  'office',
  'pdf',
  'spacePreview',
  'web',
]);

export function nodeUsesAccent(type: string | undefined): boolean {
  return type !== 'question' && type !== 'sketch';
}

export function nodeSupportsNoAccent(type: string | undefined): boolean {
  return !!type && TRUE_NO_ACCENT_TYPES.has(type);
}

export function nodeAccentToken(
  type: string | undefined,
  accent: string | null | undefined,
): string | null {
  return (
    accent ?? (type && DEFAULT_WHITE_ACCENT_TYPES.has(type) ? 'white' : null)
  );
}

export function resolveNodeAccent(
  type: string | undefined,
  accent: string | null | undefined,
): string | null {
  return resolveAccent(nodeAccentToken(type, accent));
}
