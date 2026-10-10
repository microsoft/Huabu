// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

export class InvalidPublicOriginError extends Error {}

export function normalizePublicOrigin(rawValue: string): string {
  let url: URL;
  try {
    url = new URL(rawValue.trim());
  } catch {
    throw new InvalidPublicOriginError(
      'HUABU_PUBLIC_ORIGIN must be an absolute HTTP(S) origin',
    );
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new InvalidPublicOriginError(
      'HUABU_PUBLIC_ORIGIN must use HTTP or HTTPS',
    );
  }
  if (url.username || url.password) {
    throw new InvalidPublicOriginError(
      'HUABU_PUBLIC_ORIGIN must not include credentials',
    );
  }
  if (url.search || url.hash) {
    throw new InvalidPublicOriginError(
      'HUABU_PUBLIC_ORIGIN must not include a query or fragment',
    );
  }
  if (url.pathname !== '/') {
    throw new InvalidPublicOriginError(
      'HUABU_PUBLIC_ORIGIN must be an origin without a path prefix',
    );
  }

  return url.origin;
}

export function resolveConfiguredPublicOrigin(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const rawValue = env.HUABU_PUBLIC_ORIGIN?.trim();
  return rawValue ? normalizePublicOrigin(rawValue) : undefined;
}
