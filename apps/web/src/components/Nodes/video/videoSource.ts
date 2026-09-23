// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/** Only known YouTube routes can become embeds; never frame an arbitrary URL. */
export function youtubeEmbedUrl(
  src: string,
  startPlayback = false,
): string | undefined {
  try {
    const url = new URL(src);
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.port
    )
      return;
    const host = url.hostname.toLowerCase();
    let id: string | null | undefined;
    if (host === 'youtu.be') {
      id = /^\/([\w-]{11})\/?$/.exec(url.pathname)?.[1];
    } else if (
      [
        'youtube.com',
        'www.youtube.com',
        'm.youtube.com',
        'www.youtube-nocookie.com',
        'youtube-nocookie.com',
      ].includes(host)
    ) {
      id =
        url.pathname === '/watch'
          ? url.searchParams.get('v')
          : /^\/(?:embed|shorts|live)\/([\w-]{11})\/?$/.exec(url.pathname)?.[1];
    }
    return id && /^[\w-]{11}$/.test(id)
      ? `https://www.youtube-nocookie.com/embed/${id}?autoplay=${startPlayback ? 1 : 0}&playsinline=1`
      : undefined;
  } catch {
    return undefined;
  }
}

/** A preprocess cover belongs to the exact stored source, not a resolved URL. */
export function videoCoverSource(
  data: Record<string, unknown>,
): string | undefined {
  return typeof data.src === 'string' &&
    data.src.length > 0 &&
    data.coverSourceSrc === data.src &&
    typeof data.coverUrl === 'string' &&
    data.coverUrl.length > 0
    ? data.coverUrl
    : undefined;
}
