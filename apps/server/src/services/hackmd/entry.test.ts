// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { readServicePackageFile } from '../../modules/services/package-loader.js';

async function loadEntry() {
  const source = readServicePackageFile('hackmd', 'entry.mjs');
  if (!source) throw new Error('HackMD entry is missing');
  return import(
    `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
  ) as Promise<{
    main(argv: string[]): Promise<void>;
    noteRequest(input: {
      config: { apiKey: string };
      operation: string;
      noteId?: string;
      content?: string;
      visibility?: string;
    }): Promise<Record<string, unknown>>;
  }>;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('HackMD Service entry', () => {
  it('creates a private note by default through the official API without redirects', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'note-id',
          content: '# Draft',
          readPermission: 'owner',
          writePermission: 'owner',
        }),
        { status: 201 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { noteRequest } = await loadEntry();
    const result = await noteRequest({
      config: { apiKey: 'test-token' },
      operation: 'create',
      content: '# Draft',
    });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      'https://api.hackmd.io/v1/notes',
      expect.objectContaining({
        method: 'POST',
        redirect: 'manual',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          content: '# Draft',
          readPermission: 'owner',
          writePermission: 'owner',
          commentPermission: 'disabled',
        }),
      }),
    );
    expect(result).toMatchObject({
      id: 'note-id',
      url: 'https://hackmd.io/note-id',
    });
  });

  it.each([undefined, 'public', 'private'])(
    'updates content with explicit visibility %s only',
    async (visibility) => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status: 202 }));
      vi.stubGlobal('fetch', fetchMock);
      const { noteRequest } = await loadEntry();
      const result = await noteRequest({
        config: { apiKey: 'test-token' },
        operation: 'update',
        noteId: 'note-id',
        content: '# Revised',
        visibility,
      });
      const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
      expect(body).toEqual({
        content: '# Revised',
        ...(visibility
          ? {
              readPermission: visibility === 'public' ? 'guest' : 'owner',
              writePermission: 'owner',
            }
          : {}),
      });
      expect(result).toEqual({
        id: 'note-id',
        url: 'https://hackmd.io/note-id',
        status: 'accepted',
      });
    },
  );

  it('reads a short-ID note without writes and returns its canonical identity', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ id: 'canonical-id', content: '# Paper' }),
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    const { noteRequest } = await loadEntry();
    expect(
      await noteRequest({
        config: { apiKey: 'test-token' },
        operation: 'read',
        noteId: 'short-id',
      }),
    ).toMatchObject({ id: 'canonical-id', content: '# Paper' });
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'GET' });
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBeUndefined();
  });

  it.each([401, 207, 302])(
    'reports status %s without leaking bodies or retrying',
    async (status) => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response('sensitive provider response', { status }),
        );
      vi.stubGlobal('fetch', fetchMock);
      const { noteRequest } = await loadEntry();
      await expect(
        noteRequest({
          config: { apiKey: 'test-token' },
          operation: 'create',
          content: '# Draft',
        }),
      ).rejects.toThrow(`HackMD create returned ${status}`);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects invalid input before sending a provider request', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    const { noteRequest } = await loadEntry();
    await expect(
      noteRequest({
        config: { apiKey: 'test-token' },
        operation: 'update',
        noteId: '../notes',
        content: 'text',
      }),
    ).rejects.toThrow('note ID');
    await expect(
      noteRequest({
        config: { apiKey: 'test-token' },
        operation: 'read',
        noteId: 'id',
        visibility: 'public',
      }),
    ).rejects.toThrow('Visibility');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not describe unexpected public creation as private success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            id: 'note-id',
            content: '# Draft',
            readPermission: 'guest',
            writePermission: 'owner',
          }),
          { status: 201 },
        ),
      ),
    );
    const { noteRequest } = await loadEntry();
    await expect(
      noteRequest({
        config: { apiKey: 'test-token' },
        operation: 'create',
        content: '# Draft',
      }),
    ).rejects.toThrow('unexpected permissions');
  });

  it('uses the canonical SDK for read and supports help without credentials', async () => {
    const output = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    const { main } = await loadEntry();
    await main(['--help']);
    expect(output).toHaveBeenCalledWith(
      expect.stringContaining('node entry.mjs create'),
    );
    const sdk = `export async function withServiceContext(id, run) {
      if (id !== 'hackmd') throw new Error('Wrong service');
      return run({config:{apiKey:'leased-token'}});
    }`;
    vi.stubEnv(
      'HUABU_SERVICE_SDK_URL',
      `data:text/javascript;base64,${Buffer.from(sdk).toString('base64')}`,
    );
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ id: 'id', content: 'text' })),
      );
    vi.stubGlobal('fetch', fetchMock);
    await main(['read', '--note-id', 'id']);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer leased-token',
    });
    expect(output).toHaveBeenLastCalledWith(
      expect.stringContaining('"id":"id"'),
    );
  });
});
