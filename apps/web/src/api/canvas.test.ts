// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { exportCanvas } from './canvas';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Space export download', () => {
  it.each([400, 404, 500])(
    'does not navigate or download on HTTP %s',
    async (status) => {
      const click = vi
        .spyOn(HTMLAnchorElement.prototype, 'click')
        .mockImplementation(() => {});
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              message: 'Export is unavailable',
              code: 'STORAGE_CAPABILITY_UNAVAILABLE',
            }),
            { status },
          ),
        ),
      );

      await expect(exportCanvas('space-1')).rejects.toMatchObject({
        status,
        message: 'Export is unavailable',
      });
      expect(click).not.toHaveBeenCalled();
      expect(document.querySelector('a')).toBeNull();
    },
  );

  it('preflights eligibility then preserves the native streamed Disk download', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetch);
    let download: string | undefined;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      download = this.getAttribute('href') ?? undefined;
    });

    await exportCanvas('space-1');

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toMatch(
      /\/canvas\/space-1\/export\?check=true$/,
    );
    expect(download).toMatch(/\/canvas\/space-1\/export$/);
    expect(document.querySelector('a')).toBeNull();
  });
});
