// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

export function validateHandbookUrl(
  configuredUrl: string,
  isProduction: boolean,
): string {
  let url: URL;
  try {
    url = new URL(configuredUrl);
  } catch {
    throw new Error(
      `VITE_HANDBOOK_URL must be an absolute URL: ${configuredUrl}`,
    );
  }

  const isLoopbackHost =
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1' ||
    url.hostname === '[::1]';
  const isLocalDevelopment =
    !isProduction && url.protocol === 'http:' && isLoopbackHost;
  if (url.protocol !== 'https:' && !isLocalDevelopment) {
    throw new Error(
      'VITE_HANDBOOK_URL must use HTTPS, except for HTTP localhost during development.',
    );
  }
  if (url.username || url.password || url.hash) {
    throw new Error(
      'VITE_HANDBOOK_URL must not include credentials or a fragment.',
    );
  }

  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
  return url.toString();
}

export function resolveHandbookUrl(
  configuredUrl: string | undefined,
  isProduction: boolean,
  developmentOrigin?: string,
): string {
  const configured = configuredUrl?.trim();
  if (configured) return validateHandbookUrl(configured, isProduction);
  if (isProduction) {
    throw new Error('VITE_HANDBOOK_URL is required in production.');
  }
  return validateHandbookUrl(
    new URL('/docs/', developmentOrigin).toString(),
    false,
  );
}

export const userHandbookUrl = resolveHandbookUrl(
  import.meta.env.VITE_HANDBOOK_URL,
  import.meta.env.PROD,
  window.location.origin,
);

export function openUserHandbook(): Window | null {
  return window.open(userHandbookUrl, '_blank', 'noopener,noreferrer');
}
