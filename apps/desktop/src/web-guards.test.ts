// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it, vi } from 'vitest';

import {
  guardSession,
  isDownloadAllowed,
  isPermissionAllowed,
} from './web-guards';

import type { Session } from 'electron';

const ORIGIN = 'http://127.0.0.1:3001';
const APP = `${ORIGIN}/canvas/one`;

describe('isPermissionAllowed', () => {
  it.each(['clipboard-read', 'clipboard-sanitized-write', 'fullscreen'])(
    'lets the application use %s',
    (permission) => {
      expect(
        isPermissionAllowed(
          { permission, requester: APP, isMainFrame: true },
          ORIGIN,
        ),
      ).toBe(true);
    },
  );

  it('lets the application record audio but not video', () => {
    const media = (mediaTypes: string[]) =>
      isPermissionAllowed(
        { permission: 'media', requester: APP, isMainFrame: true, mediaTypes },
        ORIGIN,
      );
    expect(media(['audio'])).toBe(true);
    expect(media(['video'])).toBe(false);
    expect(media(['audio', 'video'])).toBe(false);
  });

  it.each(['geolocation', 'notifications', 'hid', 'openExternal'])(
    'denies the application %s, which it never asks for',
    (permission) => {
      expect(
        isPermissionAllowed(
          { permission, requester: APP, isMainFrame: true },
          ORIGIN,
        ),
      ).toBe(false);
    },
  );

  it('grants a framed page fullscreen and nothing else', () => {
    const framed = (permission: string, requester: string | undefined) =>
      isPermissionAllowed(
        { permission, requester, isMainFrame: false, mediaTypes: ['audio'] },
        ORIGIN,
      );
    expect(framed('fullscreen', 'https://video.example/embed')).toBe(true);
    for (const permission of ['media', 'clipboard-read', 'geolocation']) {
      expect(framed(permission, 'https://evil.example/')).toBe(false);
      // Same origin but framed, such as an Interactive View document.
      expect(framed(permission, APP)).toBe(false);
      expect(framed(permission, undefined)).toBe(false);
    }
  });

  it('denies another origin in a top-level frame', () => {
    expect(
      isPermissionAllowed(
        {
          permission: 'clipboard-read',
          requester: 'http://127.0.0.1:9999/',
          isMainFrame: true,
        },
        ORIGIN,
      ),
    ).toBe(false);
  });
});

describe('isDownloadAllowed', () => {
  it('saves only files the application serves or creates', () => {
    expect(isDownloadAllowed(`${ORIGIN}/api/canvas/a/artifact/x.pdf`, ORIGIN)).toBe(
      true,
    );
    expect(isDownloadAllowed(`blob:${ORIGIN}/7f3c`, ORIGIN)).toBe(true);
    expect(isDownloadAllowed('https://evil.example/setup.exe', ORIGIN)).toBe(
      false,
    );
    expect(isDownloadAllowed('blob:https://evil.example/7f3c', ORIGIN)).toBe(
      false,
    );
    expect(isDownloadAllowed('blob:null/7f3c', ORIGIN)).toBe(false);
    expect(isDownloadAllowed('data:text/plain,hello', ORIGIN)).toBe(false);
  });
});

describe('guardSession', () => {
  function guarded() {
    const session = {
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      on: vi.fn(),
    };
    guardSession(session as unknown as Session, ORIGIN);
    return session;
  }

  it('answers permission requests and checks with the same policy', () => {
    const session = guarded();
    const request = session.setPermissionRequestHandler.mock.calls[0][0];
    const granted = vi.fn();
    request(null, 'media', granted, {
      requestingUrl: APP,
      isMainFrame: true,
      mediaTypes: ['audio'],
    });
    expect(granted).toHaveBeenCalledWith(true);
    const denied = vi.fn();
    request(null, 'media', denied, {
      requestingUrl: 'https://evil.example/',
      isMainFrame: false,
      mediaTypes: ['audio'],
    });
    expect(denied).toHaveBeenCalledWith(false);

    const check = session.setPermissionCheckHandler.mock.calls[0][0];
    expect(
      check(null, 'clipboard-read', ORIGIN, { isMainFrame: true }),
    ).toBe(true);
    expect(
      check(null, 'media', ORIGIN, { isMainFrame: true, mediaType: 'video' }),
    ).toBe(false);
    expect(
      check(null, 'clipboard-read', 'https://evil.example', {
        isMainFrame: false,
      }),
    ).toBe(false);
  });

  it('cancels a download from outside the application', () => {
    const session = guarded();
    const [event, listener] = session.on.mock.calls[0];
    expect(event).toBe('will-download');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const blocked = { preventDefault: vi.fn() };
    listener(blocked, { getURL: () => 'https://evil.example/setup.exe' });
    expect(blocked.preventDefault).toHaveBeenCalled();
    const kept = { preventDefault: vi.fn() };
    listener(kept, { getURL: () => `${ORIGIN}/api/canvas/a/artifact/x.pdf` });
    expect(kept.preventDefault).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
