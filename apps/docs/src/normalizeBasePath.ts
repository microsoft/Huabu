// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

export function normalizeBasePath(value: string | undefined): string {
  const segments = (value ?? '/').split('/').filter(Boolean);
  return segments.length === 0 ? '/' : `/${segments.join('/')}/`;
}
