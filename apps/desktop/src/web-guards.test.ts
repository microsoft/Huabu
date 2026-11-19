// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it, vi } from 'vitest';

import {
  carriesLaunchToken,
  guardSession,
  isDownloadAllowed,
  isPermissionAllowed,
  sendLaunchToken,
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
    expect(
      isDownloadAllowed(`${ORIGIN}/api/canvas/a/artifact/x.pdf`, ORIGIN),
    ).toBe(true);
    expect(isDownloadAllowed(`blob:${ORIGIN}/7f3c`, ORIGIN)).toBe(true);
    expect(isDownloadAllowed('https://evil.example/setup.exe', ORIGIN)).toBe(
      false,
    );
    expect(isDownloadAllowed('blob:https://evil.example/7f3c', ORIGIN)).toBe(
      false,
    );
    expect(isDownloadAllowed('blob:null/7f3c', ORIGIN)).toBe(false);
    // An image node may hold its picture as a data URL; only the application
    // can start a download of one.
    expect(isDownloadAllowed('data:image/png;base64,AAAA', ORIGIN)).toBe(true);
    expect(isDownloadAllowed('file:///etc/passwd', ORIGIN)).toBe(false);
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
    expect(check(null, 'clipboard-read', ORIGIN, { isMainFrame: true })).toBe(
      true,
    );
    expect(
      check(null, 'media', ORIGIN, { isMainFrame: true, mediaType: 'video' }),
    ).toBe(false);
    expect(
      check(null, 'clipboard-read', 'https://evil.example', {
        isMainFrame: false,
      }),
    ).toBe(false);
  });

  it('guards a session once, however often its Space is reopened', () => {
    const session = guarded();
    guardSession(session as unknown as Session, ORIGIN);
    guardSession(session as unknown as Session, ORIGIN);
    expect(session.on).toHaveBeenCalledTimes(1);
    expect(session.setPermissionRequestHandler).toHaveBeenCalledTimes(1);
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

describe('carriesLaunchToken', () => {
  const API = `${ORIGIN}/api/canvas/one`;
  const carries = (
    url: string,
    resourceType: string,
    frameUrls: string[] | null,
  ) => carriesLaunchToken({ url, resourceType, frameUrls }, [ORIGIN]);

  it('accompanies the application to its Server', () => {
    expect(carries(`${ORIGIN}/_desktop`, 'mainFrame', ['about:blank'])).toBe(
      true,
    );
    expect(carries(API, 'xhr', [APP])).toBe(true);
    expect(carries(`${ORIGIN}/assets/app.js`, 'script', [APP])).toBe(true);
    // The main process itself.
    expect(carries(API, 'xhr', null)).toBe(true);
  });

  it('accompanies documents the application frames from its own Server', () => {
    // A new frame is blank until its first navigation commits.
    expect(
      carries(`${ORIGIN}/api/canvas/one/artifact/page.html`, 'subFrame', [
        'about:blank',
        APP,
      ]),
    ).toBe(true);
    // Electron reports no URL at all for a frame on its first navigation.
    expect(
      carries(`${ORIGIN}/api/canvas/one/artifact/page.html`, 'subFrame', [
        '',
        APP,
      ]),
    ).toBe(true);
    expect(
      carries(API, 'subFrame', ['', 'https://evil.example/page', APP]),
    ).toBe(false);
    // Sandboxed, so its origin is opaque, yet its document is the Server's.
    expect(
      carries(`${ORIGIN}/api/canvas/one/artifact/style.css`, 'stylesheet', [
        `${ORIGIN}/api/canvas/one/artifact/page.html`,
        APP,
      ]),
    ).toBe(true);
    expect(carries(API, 'image', ['about:srcdoc', APP])).toBe(true);
  });

  it('never leaves for another origin', () => {
    expect(carries('https://evil.example/api', 'xhr', [APP])).toBe(false);
    expect(carries('http://127.0.0.1:9999/api', 'xhr', [APP])).toBe(false);
    expect(carries('not a url', 'xhr', [APP])).toBe(false);
  });

  it('is withheld from a web page framed on the Canvas', () => {
    const page = 'https://evil.example/page';
    expect(carries(API, 'xhr', [page, APP])).toBe(false);
    expect(carries(API, 'image', [page, APP])).toBe(false);
    // The page pointing its own frame, or one it made, at the Server.
    expect(carries(API, 'subFrame', [page, APP])).toBe(false);
    expect(carries(API, 'subFrame', ['about:blank', page, APP])).toBe(false);
    expect(carries(API, 'xhr', ['about:srcdoc', page, APP])).toBe(false);
  });

  it('is not gained by a framed page that moves itself to a blob or data document', () => {
    expect(carries(API, 'xhr', ['blob:https://evil.example/7f3c', APP])).toBe(
      false,
    );
    expect(carries(API, 'xhr', ['blob:null/7f3c', APP])).toBe(false);
    expect(carries(API, 'xhr', ['data:text/html,<p>x</p>', APP])).toBe(false);
    // The application's own blob documents are still its own.
    expect(carries(API, 'xhr', [`blob:${ORIGIN}/7f3c`, APP])).toBe(true);
    // Nothing but `about:` documents all the way up names no application.
    expect(carries(API, 'xhr', ['about:blank'])).toBe(false);
  });

  it('judges a request with no frame by the referrer it states', () => {
    const frameless = (referrer: string | undefined, fromRenderer: boolean) =>
      carriesLaunchToken(
        {
          url: API,
          resourceType: 'xhr',
          frameUrls: null,
          referrer,
          fromRenderer,
        },
        [ORIGIN],
      );
    // The application's worker, and its last save as a Tab closes.
    expect(frameless(`${ORIGIN}/assets/worker.js`, true)).toBe(true);
    expect(frameless(APP, true)).toBe(true);
    // A framed page's worker, whether a file or a blob it made.
    expect(frameless('https://evil.example/worker.js', true)).toBe(false);
    expect(frameless('http://127.0.0.1:9999/worker.js', true)).toBe(false);
    expect(frameless('blob:https://evil.example/7f3c', true)).toBe(false);
    // A renderer that hides its referrer is not taken on trust.
    expect(frameless(undefined, true)).toBe(false);
    expect(frameless('', true)).toBe(false);
    // The main process states none and is the application.
    expect(frameless(undefined, false)).toBe(true);
  });

  it('covers a development web server that proxies to the Server', () => {
    const dev = 'http://localhost:5173';
    const origins = [dev, ORIGIN];
    expect(
      carriesLaunchToken(
        { url: `${dev}/api/x`, resourceType: 'xhr', frameUrls: [`${dev}/`] },
        origins,
      ),
    ).toBe(true);
    expect(
      carriesLaunchToken(
        { url: API, resourceType: 'xhr', frameUrls: [`${dev}/`] },
        origins,
      ),
    ).toBe(true);
  });
});

describe('sendLaunchToken', () => {
  function listener() {
    const onBeforeSendHeaders = vi.fn();
    sendLaunchToken(
      { webRequest: { onBeforeSendHeaders } } as unknown as Session,
      'launch',
      [ORIGIN],
    );
    return onBeforeSendHeaders.mock.calls[0][0] as (
      details: unknown,
      callback: (response: unknown) => void,
    ) => void;
  }
  const frame = (url: string, parent: unknown = null) => ({ url, parent });

  it("adds the token to the application's requests and keeps their headers", () => {
    const callback = vi.fn();
    listener()(
      {
        url: `${ORIGIN}/api/x`,
        resourceType: 'xhr',
        requestHeaders: { Accept: 'application/json' },
        frame: frame(APP),
      },
      callback,
    );
    expect(callback).toHaveBeenCalledWith({
      requestHeaders: {
        Accept: 'application/json',
        'X-Huabu-Desktop-Token': 'launch',
      },
    });
  });

  it('leaves every other request untouched', () => {
    const send = listener();
    for (const details of [
      { url: 'https://example.com/', resourceType: 'xhr', frame: frame(APP) },
      {
        url: `${ORIGIN}/api/x`,
        resourceType: 'xhr',
        frame: frame('https://evil.example/', frame(APP)),
      },
    ]) {
      const callback = vi.fn();
      send({ ...details, requestHeaders: {} }, callback);
      expect(callback).toHaveBeenCalledWith({});
    }
  });

  it("still sends a closing page's last request once its frame is gone", () => {
    const callback = vi.fn();
    listener()(
      {
        url: `${ORIGIN}/api/x`,
        resourceType: 'xhr',
        requestHeaders: {},
        referrer: APP,
        webContentsId: 7,
        get frame() {
          throw new Error('Render frame was disposed');
        },
      },
      callback,
    );
    expect(callback).toHaveBeenCalledWith({
      requestHeaders: { 'X-Huabu-Desktop-Token': 'launch' },
    });
  });
});
