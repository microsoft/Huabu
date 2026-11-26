// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { isSameOrigin } from './server-target.js';

import type { Session, WebFrameMain } from 'electron';

/**
 * Device permissions and downloads are denied unless the application itself
 * asks for them.
 *
 * Electron grants every permission request when a session has no handler, and
 * saves every download. Embedded web previews share the application's
 * sessions, so their only restraint would otherwise be the `sandbox` and
 * `allow` attributes on each `<iframe>`.
 */

/** What the application's own top-level pages use. */
const APPLICATION_PERMISSIONS: ReadonlySet<string> = new Set([
  // Copy and paste on the Canvas.
  'clipboard-read',
  'clipboard-sanitized-write',
  // Audio node recording; narrowed to audio below.
  'media',
  'fullscreen',
]);

/** What a framed page may use: an embedded video player's fullscreen button. */
const EMBEDDED_PERMISSIONS: ReadonlySet<string> = new Set(['fullscreen']);

export interface PermissionSubject {
  permission: string;
  /** The URL or origin of the frame asking. */
  requester: string | undefined;
  isMainFrame: boolean;
  /** Media kinds asked for, when the permission is `media`. */
  mediaTypes?: readonly string[];
}

export function isPermissionAllowed(
  subject: PermissionSubject,
  serverOrigin: string,
): boolean {
  const application =
    subject.isMainFrame &&
    Boolean(subject.requester) &&
    isSameOrigin(subject.requester as string, serverOrigin);
  if (!application) return EMBEDDED_PERMISSIONS.has(subject.permission);
  if (!APPLICATION_PERMISSIONS.has(subject.permission)) return false;
  if (subject.permission !== 'media') return true;
  return (subject.mediaTypes ?? []).every((type) => type === 'audio');
}

/**
 * Only the application's own files may be saved. A `blob:` URL has the origin
 * of the page that created it, so the same comparison covers it. A `data:`
 * URL names no origin, and only the application can start a download of one:
 * framed pages are sandboxed without `allow-downloads`. Image nodes hold such
 * URLs, and their Download action saves them.
 */
export function isDownloadAllowed(url: string, serverOrigin: string): boolean {
  return isSameOrigin(url, serverOrigin) || /^data:/i.test(url);
}

/** A Space's session outlives its Tab, and each reopening guards it again. */
const guarded = new WeakSet<Session>();

export function guardSession(webSession: Session, serverOrigin: string): void {
  if (guarded.has(webSession)) return;
  guarded.add(webSession);
  webSession.setPermissionRequestHandler(
    (_contents, permission, callback, details) => {
      const media = details as { mediaTypes?: readonly string[] };
      callback(
        isPermissionAllowed(
          {
            permission,
            requester: details.requestingUrl,
            isMainFrame: details.isMainFrame,
            mediaTypes: media.mediaTypes,
          },
          serverOrigin,
        ),
      );
    },
  );
  webSession.setPermissionCheckHandler(
    (_contents, permission, requestingOrigin, details) =>
      isPermissionAllowed(
        {
          permission,
          requester: details.requestingUrl ?? requestingOrigin,
          isMainFrame: details.isMainFrame,
          mediaTypes:
            details.mediaType && details.mediaType !== 'unknown'
              ? [details.mediaType]
              : [],
        },
        serverOrigin,
      ),
  );
  webSession.on('will-download', (event, item) => {
    if (isDownloadAllowed(item.getURL(), serverOrigin)) return;
    event.preventDefault();
    console.warn('[desktop] Blocked a download from outside the application.');
  });
}

/** The request header the local Server admits the desktop app's windows by. */
export const DESKTOP_TOKEN_HEADER = 'X-Huabu-Desktop-Token';

export interface OutgoingRequest {
  url: string;
  resourceType: string;
  /**
   * The document URL of the frame making the request, then of each ancestor.
   * `null` when no frame is known: a worker, the main process, or a page
   * that has just closed.
   */
  frameUrls: readonly string[] | null;
  /** The `Referer` the request states, if any. */
  referrer?: string;
  /** Whether a renderer, rather than the main process, makes the request. */
  fromRenderer?: boolean;
}

/**
 * Whether a request is the application's own call to its local Server.
 *
 * The Server's Host, Origin and CORS guards already keep a framed web page
 * from reading the API or writing to it, token or not. This withholds the
 * token wherever the caller cannot be shown to be the application.
 */
export function carriesLaunchToken(
  request: OutgoingRequest,
  serverOrigins: readonly string[],
): boolean {
  // `URL.origin` is the creating page's origin for a `blob:` URL, so a page
  // gains nothing by moving itself to one.
  const isServer = (url: string) =>
    serverOrigins.some((origin) => isSameOrigin(url, origin));
  if (!isServer(request.url)) return false;
  // The navigation guard lets a window load nothing but the application.
  if (request.resourceType === 'mainFrame') return true;
  if (request.frameUrls) {
    // A frame not yet loaded (no URL) and an `about:` document act for the
    // frame that holds them.
    const document = request.frameUrls.find(
      (url) => url !== '' && !/^about:/i.test(url),
    );
    return document !== undefined && isServer(document);
  }
  // No frame to judge by. A worker, and a page's last request as it closes,
  // name the application as their referrer; the main process names none.
  if (request.referrer) return isServer(request.referrer);
  return !request.fromRenderer;
}

export function sendLaunchToken(
  webSession: Session,
  token: string,
  serverOrigins: readonly string[],
): void {
  webSession.webRequest.onBeforeSendHeaders((details, callback) => {
    let frameUrls: string[] | null = null;
    try {
      let frame: WebFrameMain | null = details.frame ?? null;
      if (frame) frameUrls = [];
      for (; frame; frame = frame.parent) frameUrls?.push(frame.url);
    } catch {
      // The frame was disposed mid-request: judged as frameless, so a page's
      // last save while it closes still arrives.
      frameUrls = null;
    }
    callback(
      carriesLaunchToken(
        {
          url: details.url,
          resourceType: details.resourceType,
          frameUrls,
          referrer: details.referrer,
          fromRenderer: details.webContentsId !== undefined,
        },
        serverOrigins,
      )
        ? {
            requestHeaders: {
              ...details.requestHeaders,
              [DESKTOP_TOKEN_HEADER]: token,
            },
          }
        : {},
    );
  });
}
