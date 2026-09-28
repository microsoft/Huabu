// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { videoCoverSource, youtubeEmbedUrl } from './videoSource';

describe('video source metadata', () => {
  it('accepts only a cover tied to the exact current source', () => {
    const data = {
      src: 'movie.webm',
      coverUrl: 'cover.jpg',
      coverSourceSrc: 'movie.webm',
    };
    expect(videoCoverSource(data)).toBe('cover.jpg');
    expect(
      videoCoverSource({ ...data, src: 'replacement.webm' }),
    ).toBeUndefined();
    expect(
      videoCoverSource({ ...data, coverSourceSrc: undefined }),
    ).toBeUndefined();
    expect(videoCoverSource({ ...data, coverUrl: 42 })).toBeUndefined();
    expect(
      videoCoverSource({ ...data, src: '', coverSourceSrc: '' }),
    ).toBeUndefined();
  });
  it.each([
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ&autoplay=1',
    'https://youtu.be/dQw4w9WgXcQ?t=12',
    'https://m.youtube.com/shorts/dQw4w9WgXcQ',
    'https://youtube.com/live/dQw4w9WgXcQ',
    'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
  ])(
    'normalizes a known YouTube source without copying URL parameters: %s',
    (src) => {
      expect(youtubeEmbedUrl(src)).toBe(
        'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=0&playsinline=1',
      );
    },
  );
  it.each([
    'movie.mp4',
    'https://example.org/movie.mp4',
    'https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ',
    'https://evil.test/?v=dQw4w9WgXcQ',
    'https://youtube.com/watch?v=bad',
    'https://youtube.com/redirect?v=dQw4w9WgXcQ',
    'javascript:alert(1)',
    'https://user:password@youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtube.com:444/watch?v=dQw4w9WgXcQ',
  ])('never embeds an arbitrary or malformed source: %s', (src) => {
    expect(youtubeEmbedUrl(src)).toBeUndefined();
    expect(youtubeEmbedUrl(src, true)).toBeUndefined();
  });
  it('allows autoplay only by an explicit caller opt-in', () => {
    expect(
      youtubeEmbedUrl('https://youtu.be/dQw4w9WgXcQ?autoplay=0', true),
    ).toBe(
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&playsinline=1',
    );
  });
});
