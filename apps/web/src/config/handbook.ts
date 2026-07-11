const DEFAULT_HANDBOOK_URL = 'https://cxxxxxn.github.io/Sediment/docs/';

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

  const isLocalDevelopment =
    !isProduction && url.protocol === 'http:' && url.hostname === 'localhost';
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

export const userHandbookUrl = validateHandbookUrl(
  import.meta.env.VITE_HANDBOOK_URL?.trim() || DEFAULT_HANDBOOK_URL,
  import.meta.env.PROD,
);

export function openUserHandbook(): Window | null {
  return window.open(userHandbookUrl, '_blank', 'noopener,noreferrer');
}
