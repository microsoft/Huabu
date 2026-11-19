// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { openImageViewer } from './image-viewer.js';
import { classifyLink } from './link-targets.js';

import type { WebContents } from 'electron';

/**
 * Open a file the local Server serves, for the application page that asked.
 *
 * The system browser holds no launch token and would be shown a 401, so a
 * raster image is shown in a window of the app and any other file is saved.
 * Only a request over the application's own IPC bridge gets here: a page
 * framed on the Canvas can open a window but has no bridge, so it cannot
 * turn one of these URLs into a download or a viewer.
 */
export function openServerFile(
  rawUrl: unknown,
  sender: WebContents,
  serverOrigin: string,
): void {
  if (typeof rawUrl !== 'string' || rawUrl.length > 4096)
    throw new Error('Invalid file address.');
  let url: string;
  try {
    url = new URL(rawUrl, serverOrigin).href;
  } catch {
    throw new Error('Invalid file address.');
  }
  const target = classifyLink(url, serverOrigin);
  if (target === 'image') openImageViewer(url, sender);
  else if (target === 'file') sender.downloadURL(url);
  else throw new Error('Only a file this Server stores can be opened.');
}
