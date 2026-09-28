// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/** Extract and validate an ID before it is used in a provider URL. */
export function extractYoutubeVideoId(source: string): string | null {
  const valid = (id: string | null | undefined) =>
    id && /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
  if (valid(source)) return source;
  try {
    const url = new URL(source);
    if (!['https:', 'http:'].includes(url.protocol)) return null;
    const host = url.hostname.toLowerCase();
    if (host === 'youtu.be') return valid(url.pathname.slice(1));
    if (
      host === 'youtube.com' ||
      host.endsWith('.youtube.com') ||
      host === 'www.youtube-nocookie.com' ||
      host === 'youtube-nocookie.com'
    ) {
      const pathId = /^\/(?:embed|shorts|live)\/([^/]+)\/?$/.exec(
        url.pathname,
      )?.[1];
      return valid(pathId ?? url.searchParams.get('v'));
    }
  } catch {
    // Non-URL source that is not a validated video ID.
  }
  return null;
}
