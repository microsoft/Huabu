// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { isSameOrigin } from './server-target.js';

import type { Session } from 'electron';

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
 * of the page that created it, so the same comparison covers it.
 */
export function isDownloadAllowed(url: string, serverOrigin: string): boolean {
  return isSameOrigin(url, serverOrigin);
}

export function guardSession(webSession: Session, serverOrigin: string): void {
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
