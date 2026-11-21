// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

interface LivePage {
  interactiveView: boolean;
  kind: 'url' | 'html' | null;
  /** A static archive of an already-rendered page: scripts stay off. */
  snapshot: boolean;
  src: string | null;
  /** The origin the application itself is served from. */
  appOrigin: string;
}

function isOnOrigin(src: string | null, origin: string): boolean {
  if (!src) return false;
  try {
    return new URL(src, origin).origin === origin;
  } catch {
    return false;
  }
}

/**
 * The `sandbox` flags for a live page framed on the Canvas.
 *
 * A remote site gets `allow-same-origin` so it can read its own cookies and
 * storage; being another origin, it still cannot reach the application. A
 * document served from the application's own origin never gets it: with
 * scripts on it would be the application, free to call every API. That holds
 * for a Web node whose `src` spells out an absolute URL to a stored file
 * just as for one that names the file by key.
 */
export function livePageSandboxFor(page: LivePage): string {
  if (page.interactiveView) return 'allow-scripts allow-forms';
  if (page.kind === 'url' && !isOnOrigin(page.src, page.appOrigin))
    return 'allow-scripts allow-forms allow-popups allow-same-origin';
  if (page.snapshot) return 'allow-popups';
  return 'allow-scripts allow-forms allow-popups';
}
