// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from './_client';
import {
  DEVICE_BINARY_CHUNK_BYTES,
  DevicePdfLoadError,
  loadDeviceFileBytes,
  loadDevicePdfBytes,
} from './device-files';

import type * as ClientModule from './_client';

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('./_client', async (original) => {
  const actual = await original<typeof ClientModule>();
  return {
    ...actual,
    apiFetch: fetchMock,
  };
});

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('loadDevicePdfBytes', () => {
  it('reassembles multi-chunk Base64 PDF bytes with version consistency and progress callbacks', async () => {
    const raw = new Uint8Array([
      0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x00, 0xff, 0x45,
      0x4f, 0x46,
    ]);
    const version = 'a'.repeat(64);
    fetchMock
      .mockResolvedValueOnce({
        operation: 'fs-read-bytes',
        result: {
          path: '/docs/paper.pdf',
          encoding: 'base64',
          data: toBase64(raw.subarray(0, 8)),
          byteLength: 8,
          size: raw.length,
          contentVersion: version,
          nextCursor: 'cursor-1',
        },
      })
      .mockResolvedValueOnce({
        operation: 'fs-read-bytes',
        result: {
          path: '/docs/paper.pdf',
          encoding: 'base64',
          data: toBase64(raw.subarray(8)),
          byteLength: raw.length - 8,
          size: raw.length,
          contentVersion: version,
        },
      });

    const progress: Array<[number, number]> = [];
    const loaded = await loadDevicePdfBytes('device-1', '/docs/paper.pdf', {
      maxBytes: 1024,
      onProgress: (loadedBytes, totalBytes) =>
        progress.push([loadedBytes, totalBytes]),
    });

    expect(Array.from(loaded.bytes)).toEqual(Array.from(raw));
    expect(loaded.size).toBe(raw.length);
    expect(loaded.contentVersion).toBe(version);
    expect(progress).toEqual([
      [8, raw.length],
      [raw.length, raw.length],
    ]);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      json: {
        agentletId: 'device-1',
        operation: 'fs-read-bytes',
        args: {
          path: '/docs/paper.pdf',
          limitBytes: DEVICE_BINARY_CHUNK_BYTES,
          maxSizeBytes: 1024,
        },
      },
    });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      json: {
        agentletId: 'device-1',
        operation: 'fs-read-bytes',
        args: {
          path: '/docs/paper.pdf',
          cursor: 'cursor-1',
          limitBytes: DEVICE_BINARY_CHUNK_BYTES,
          maxSizeBytes: 1024,
        },
      },
    });
  });

  it('rejects non-PDF files on the first chunk without fetching remaining chunks', async () => {
    const nonPdf = new TextEncoder().encode('PNG\r\nnot a pdf file at all');
    fetchMock.mockResolvedValueOnce({
      operation: 'fs-read-bytes',
      result: {
        path: '/docs/fake.pdf',
        encoding: 'base64',
        data: toBase64(nonPdf),
        byteLength: nonPdf.length,
        size: nonPdf.length * 2,
        contentVersion: 'b'.repeat(64),
        nextCursor: 'cursor-2',
      },
    });

    await expect(
      loadDevicePdfBytes('device-1', '/docs/fake.pdf'),
    ).rejects.toMatchObject({
      name: 'DevicePdfLoadError',
      kind: 'invalid_pdf',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('rejects mid-read file mutations when contentVersion changes across chunks', async () => {
    const raw = new TextEncoder().encode('%PDF-1.7\nchunk-one-and-two');
    fetchMock
      .mockResolvedValueOnce({
        operation: 'fs-read-bytes',
        result: {
          path: '/docs/paper.pdf',
          encoding: 'base64',
          data: toBase64(raw.subarray(0, 10)),
          byteLength: 10,
          size: raw.length,
          contentVersion: 'a'.repeat(64),
          nextCursor: 'cursor-1',
        },
      })
      .mockResolvedValueOnce({
        operation: 'fs-read-bytes',
        result: {
          path: '/docs/paper.pdf',
          encoding: 'base64',
          data: toBase64(raw.subarray(10)),
          byteLength: raw.length - 10,
          size: raw.length,
          contentVersion: 'c'.repeat(64),
        },
      });

    await expect(
      loadDevicePdfBytes('device-1', '/docs/paper.pdf'),
    ).rejects.toMatchObject({
      kind: 'changed',
    });
  });

  it.each([
    [
      new ApiError(
        413,
        { code: 'file_too_large', message: 'Too large' },
        'Failed',
      ),
      'too_large',
    ],
    [
      new ApiError(
        409,
        { code: 'files_disconnected', message: 'Offline' },
        'Failed',
      ),
      'offline',
    ],
    [
      new ApiError(
        503,
        { code: 'files_proxy_incompatible', message: 'Old proxy' },
        'Failed',
      ),
      'proxy_incompatible',
    ],
    [
      new ApiError(404, { code: 'not_found', message: 'Missing' }, 'Failed'),
      'not_found',
    ],
    [
      new ApiError(
        403,
        { code: 'permission_denied', message: 'Denied' },
        'Failed',
      ),
      'permission_denied',
    ],
    [
      new ApiError(400, { code: 'stale_cursor', message: 'Changed' }, 'Failed'),
      'changed',
    ],
  ])('maps %o to DevicePdfLoadError kind %s', async (apiError, expected) => {
    fetchMock.mockRejectedValueOnce(apiError);
    try {
      await loadDevicePdfBytes('device-1', '/docs/paper.pdf');
      throw new Error('Expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(DevicePdfLoadError);
      expect((error as DevicePdfLoadError).kind).toBe(expected);
    }
  });

  it('stops reading further chunks when AbortSignal aborts', async () => {
    const controller = new AbortController();
    const raw = new TextEncoder().encode('%PDF-1.7\nhello world');
    fetchMock.mockImplementationOnce(async () => {
      controller.abort();
      return {
        operation: 'fs-read-bytes',
        result: {
          path: '/docs/paper.pdf',
          encoding: 'base64',
          data: toBase64(raw.subarray(0, 9)),
          byteLength: 9,
          size: raw.length,
          contentVersion: 'd'.repeat(64),
          nextCursor: 'cursor-1',
        },
      };
    });

    await expect(
      loadDevicePdfBytes('device-1', '/docs/paper.pdf', {
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe('loadDeviceFileBytes', () => {
  it('loads arbitrary regular files (including empty and non-PDF binary files) without requiring a %PDF- header', async () => {
    const raw = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    fetchMock.mockResolvedValueOnce({
      operation: 'fs-read-bytes',
      result: {
        path: '/assets/logo.png',
        encoding: 'base64',
        data: toBase64(raw),
        byteLength: raw.length,
        size: raw.length,
        contentVersion: 'e'.repeat(64),
      },
    });

    const loaded = await loadDeviceFileBytes('device-1', '/assets/logo.png');
    expect(Array.from(loaded.bytes)).toEqual(Array.from(raw));
    expect(loaded.size).toBe(raw.length);

    fetchMock.mockResolvedValueOnce({
      operation: 'fs-read-bytes',
      result: {
        path: '/assets/empty.txt',
        encoding: 'base64',
        data: '',
        byteLength: 0,
        size: 0,
        contentVersion: 'f'.repeat(64),
      },
    });

    const empty = await loadDeviceFileBytes('device-1', '/assets/empty.txt');
    expect(empty.bytes.byteLength).toBe(0);
    expect(empty.size).toBe(0);
  });
});
