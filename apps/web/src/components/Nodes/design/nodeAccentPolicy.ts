// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

const TRUE_NO_ACCENT_TYPES = new Set(['image', 'video', 'text']);
const DEFAULT_WHITE_ACCENT_TYPES = new Set([
  'audio',
  'frame',
  'note',
  'office',
  'pdf',
  'question',
  'spacePreview',
  'web',
]);

export function nodeUsesAccent(type: string | undefined): boolean {
  return type !== 'sketch';
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
