// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const decode = vi.hoisted(() => vi.fn());
vi.mock('./video-cover-decoder.js', () => ({ extractLocalVideoCover: decode }));
vi.mock('../agent/conversation-title.service.js', () => ({
  conversationTitleService: {},
}));

import { extractYoutubeVideoId } from './loaders/youtube-id.js';
import { runPipeline } from './pipeline.js';
import { profiles } from './profiles.js';
import { fetchYoutubeCover } from './video-cover.js';

import type { PipelineDeps } from './pipeline.js';
import type { NodeContent } from '../storage/index.js';
import type { PreprocessNodeRequest } from '@huabu/shared';

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const request: PreprocessNodeRequest = {
  canvasId: 'c',
  nodeId: 'v',
  nodeType: 'video',
  trigger: 'node_updated',
  snapshot: { src: 'video.mp4' },
};

function harness() {
  let record: NodeContent | null = {
    nodeId: 'v',
    type: 'video',
    label: 'User label',
    src: 'video.mp4',
    content: '',
    custom: 'keep',
  };
  const read = vi.fn(async () =>
    record ? { record: { ...record }, revision: 'r' } : null,
  );
  const putNode = vi.fn(async ({ record: next }: { record: NodeContent }) => {
    record = next;
    return { ok: true, record: next, revision: 'r2' };
  });
  const release = vi.fn(async () => {});
  const materialize = vi.fn(async () => ({
    path: '/leased/video.mp4',
    release,
  }));
  const put = vi.fn(async (name: string) => ({
    name,
    size: jpeg.length,
    updatedAt: 0,
  }));
  const head = vi.fn(async () => ({
    name: 'cached.jpg',
    size: 4,
    updatedAt: 0,
  }));
  const deps = {
    nodes: { canvasId: 'c', read, put: putNode },
    artifacts: { materialize, put, head },
    provider: {},
  } as unknown as PipelineDeps;
  return {
    read,
    putNode,
    release,
    materialize,
    put,
    head,
    get record() {
      return record;
    },
    set record(value) {
      record = value;
    },
    current() {
      if (!record) throw new Error('Expected a live video fixture');
      return record;
    },
    run: (r = request) =>
      runPipeline(r, profiles.video.capabilities, 'video', 'derived', deps),
  };
}

beforeEach(() => {
  decode.mockReset().mockResolvedValue(jpeg);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('video cover pipeline', () => {
  it('leases local input, stores a bare JPEG key, refreshes the empty-body record and projects accepted refs', async () => {
    const h = harness();
    const result = await h.run();
    expect(h.materialize).toHaveBeenCalledExactlyOnceWith('video.mp4');
    expect(decode).toHaveBeenCalledExactlyOnceWith('/leased/video.mp4');
    expect(h.release).toHaveBeenCalledOnce();
    expect(h.put).toHaveBeenCalledWith(
      expect.stringMatching(/^cover_[\w-]+\.jpg$/),
      jpeg,
    );
    expect(h.record).toMatchObject({
      label: 'User label',
      custom: 'keep',
      coverSourceSrc: 'video.mp4',
    });
    expect(result.patch).toEqual({
      coverUrl: h.record?.coverUrl,
      coverSourceSrc: 'video.mp4',
    });
  });

  it('reuses only a same-source cover whose blob still exists', async () => {
    const h = harness();
    h.record = {
      ...h.current(),
      coverUrl: 'cached.jpg',
      coverSourceSrc: 'video.mp4',
    };
    const result = await h.run();
    expect(h.head).toHaveBeenCalledWith('cached.jpg');
    expect(decode).not.toHaveBeenCalled();
    expect(h.materialize).not.toHaveBeenCalled();
    expect(h.put).not.toHaveBeenCalled();
    expect(result.patch).toEqual({
      coverUrl: 'cached.jpg',
      coverSourceSrc: 'video.mp4',
    });
  });

  it('regenerates a missing cached blob and force bypasses cache', async () => {
    const h = harness();
    h.record = {
      ...h.current(),
      coverUrl: 'cached.jpg',
      coverSourceSrc: 'video.mp4',
    };
    h.head.mockResolvedValueOnce(null as never);
    await h.run();
    await h.run({ ...request, options: { force: true } });
    expect(decode).toHaveBeenCalledTimes(2);
  });

  it('does not decode, fetch, write blobs or persist when persistence is disabled', async () => {
    const h = harness();
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const result = await h.run({
      ...request,
      options: { allowPersistence: false },
    });
    expect(h.put).not.toHaveBeenCalled();
    expect(h.putNode).not.toHaveBeenCalled();
    expect(decode).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(result.patch).toEqual({});
  });

  it('warns on decoder failure, clears obsolete refs and preserves the video', async () => {
    const h = harness();
    h.record = {
      ...h.current(),
      coverUrl: 'old.jpg',
      coverSourceSrc: 'old.mp4',
    };
    decode.mockRejectedValue(new Error('broken codec'));
    const result = await h.run();
    expect(result.success).toBe(true);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'VIDEO_COVER_FAILED', level: 'warning' }),
    );
    expect(result.patch).toEqual({ coverUrl: null, coverSourceSrc: null });
    expect(h.record).toMatchObject({ src: 'video.mp4', label: 'User label' });
    expect(h.record).not.toHaveProperty('coverUrl');
    expect(h.release).toHaveBeenCalledOnce();
  });

  it.each(['change', 'delete'] as const)(
    'does not persist or project a late result after source %s',
    async (action) => {
      const h = harness();
      decode.mockImplementation(async () => {
        h.record =
          action === 'delete'
            ? null
            : {
                ...h.current(),
                src: 'new.mp4',
                coverUrl: 'new.jpg',
                coverSourceSrc: 'new.mp4',
              };
        return jpeg;
      });
      const result = await h.run();
      expect(h.putNode).not.toHaveBeenCalled();
      expect(result.patch).toEqual({});
      expect(h.release).toHaveBeenCalledOnce();
      if (action === 'change') expect(h.record?.src).toBe('new.mp4');
    },
  );

  it('does not recreate a missing sidecar or extract it', async () => {
    const h = harness();
    h.record = null;
    expect((await h.run()).patch).toEqual({});
    expect(h.putNode).not.toHaveBeenCalled();
    expect(h.put).not.toHaveBeenCalled();
    expect(decode).not.toHaveBeenCalled();
  });

  it('normalizes legacy artifact URLs for atomic source comparison', async () => {
    const h = harness();
    h.record = { ...h.current(), src: '/api/canvas/c/artifact/video.mp4' };
    const result = await h.run({
      ...request,
      snapshot: { src: '/api/canvas/c/artifact/video.mp4' },
    });
    expect(h.record?.src).toBe('video.mp4');
    expect(result.patch).toMatchObject({
      src: 'video.mp4',
      coverSourceSrc: 'video.mp4',
    });
  });

  it('does not fetch unsupported direct remote videos', async () => {
    const h = harness();
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    h.record = {
      ...h.current(),
      src: 'https://example.com/private.mp4',
      coverUrl: 'old.jpg',
      coverSourceSrc: 'old.mp4',
    };
    const result = await h.run({ ...request, snapshot: { src: h.record.src } });
    expect(fetch).not.toHaveBeenCalled();
    expect(decode).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.diagnostics[0]?.message).toContain(
      'direct remote video is not fetched',
    );
    expect(result.patch).toEqual({ coverUrl: null, coverSourceSrc: null });
  });

  it('turns BlobStore failures into warnings without publishing a nonexistent cover', async () => {
    const h = harness();
    h.put.mockRejectedValue(new Error('disk full'));
    const result = await h.run();
    expect(result.success).toBe(true);
    expect(result.patch).toEqual({ coverUrl: null, coverSourceSrc: null });
    expect(h.release).toHaveBeenCalledOnce();
  });

  it('does not project references after the atomic repository write rejects', async () => {
    const h = harness();
    h.putNode.mockResolvedValueOnce({
      ok: false,
      reason: 'revision-conflict',
      currentRevision: 'r2',
    } as never);
    const result = await h.run();
    expect(result.patch).toEqual({});
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'PERSIST_FAILED' }),
    );
  });

  it('warns and clears obsolete covers when the local video blob is missing', async () => {
    const h = harness();
    h.record = {
      ...h.current(),
      coverUrl: 'old.jpg',
      coverSourceSrc: 'old.mp4',
    };
    h.materialize.mockResolvedValueOnce(null as never);
    const result = await h.run();
    expect(result.success).toBe(true);
    expect(result.patch).toEqual({ coverUrl: null, coverSourceSrc: null });
    expect(decode).not.toHaveBeenCalled();
  });

  it('stores a YouTube thumbnail through the same pipeline without a decoder or provider', async () => {
    const h = harness();
    const src = 'https://www.youtube.com/watch?v=abc123_-ABC';
    h.record = { ...h.current(), src };
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(jpeg, { headers: { 'content-type': 'image/jpeg' } }),
        ),
    );
    const result = await h.run({
      ...request,
      snapshot: { src },
      options: { allowLLM: false },
    });
    expect(result.patch).toMatchObject({
      coverSourceSrc: src,
      coverUrl: expect.stringMatching(/^cover_/),
    });
    expect(h.materialize).not.toHaveBeenCalled();
    expect(decode).not.toHaveBeenCalled();
    expect(h.put).toHaveBeenCalledOnce();
  });
});

describe('YouTube cover safety', () => {
  it.each([
    'https://youtu.be/abc123_-ABC',
    'https://youtube.com/watch?v=abc123_-ABC',
    'https://www.youtube.com/shorts/abc123_-ABC',
    'https://www.youtube-nocookie.com/embed/abc123_-ABC',
  ])('validates %s', (url) => {
    expect(extractYoutubeVideoId(url)).toBe('abc123_-ABC');
  });
  it.each([
    'https://evil.test/watch?v=abc123_-ABC',
    'https://youtu.be/../../secret',
    'https://youtube.com/watch?v=bad',
    'file://youtube.com/watch?v=abc123_-ABC',
  ])('rejects %s', (url) => {
    expect(extractYoutubeVideoId(url)).toBeNull();
  });
  it('uses fixed bounded URLs, disables redirects, and falls back on 404', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(
        new Response(jpeg, { headers: { 'content-type': 'image/jpeg' } }),
      );
    vi.stubGlobal('fetch', fetch);
    expect(await fetchYoutubeCover('abc123_-ABC')).toEqual(jpeg);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      'https://i.ytimg.com/vi/abc123_-ABC/maxresdefault.jpg',
      'https://i.ytimg.com/vi/abc123_-ABC/hqdefault.jpg',
    ]);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      redirect: 'error',
      signal: expect.any(AbortSignal),
    });
  });
  it('rejects excessive streamed bytes even without Content-Length', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(new Uint8Array(8 * 1024 * 1024 + 1), {
          headers: { 'content-type': 'image/jpeg' },
        }),
      ),
    );
    await expect(fetchYoutubeCover('abc123_-ABC')).rejects.toThrow('Oversized');
  });
  it('rejects non-images and redirects rather than following arbitrary destinations', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('html', { headers: { 'content-type': 'text/html' } }),
      )
      .mockRejectedValueOnce(new TypeError('redirect rejected'));
    vi.stubGlobal('fetch', fetch);
    await expect(fetchYoutubeCover('abc123_-ABC')).rejects.toThrow('Invalid');
    await expect(fetchYoutubeCover('abc123_-ABC')).rejects.toThrow('redirect');
  });
});
