// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/** Parse untrusted links once, accepting only absolute HTTP(S) URLs. */
export function parseSafeLinkUrl(href: string | null | undefined): URL | null {
  const trimmed = href?.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/** Validate at activation boundaries, preserving the trimmed original href. */
export function normalizeSafeLinkHref(
  href: string | null | undefined,
): string | null {
  const trimmed = href?.trim();
  return trimmed && parseSafeLinkUrl(trimmed) ? trimmed : null;
}
