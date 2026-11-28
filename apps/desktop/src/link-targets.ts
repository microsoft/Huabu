// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { isSameOrigin } from './server-target.js';

/**
 * Where a link a page asked to open in a new window belongs.
 *
 * - `application`: a Home or Space route, opened as a Tab.
 * - `image`: a raster image the local Server stores for a Space.
 * - `file`: anything else the Server serves.
 * - `external`: another web site, handed to the system browser.
 */
export type LinkTarget = 'application' | 'image' | 'file' | 'external' | 'none';

// SVG is left out: opened as a document it runs the scripts it carries.
const ARTIFACT_IMAGE =
  /^\/api\/canvas\/[^/]+\/artifact\/[^?#]+\.(?:png|jpe?g|gif|webp|avif)$/i;

export function classifyLink(url: string, serverOrigin: string): LinkTarget {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'none';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    return 'none';
  if (!isSameOrigin(url, serverOrigin)) return 'external';
  const path = parsed.pathname;
  if (
    path === '/' ||
    path === '/spaces' ||
    path === '/setup' ||
    path.startsWith('/canvas/')
  )
    return 'application';
  return ARTIFACT_IMAGE.test(path) ? 'image' : 'file';
}
