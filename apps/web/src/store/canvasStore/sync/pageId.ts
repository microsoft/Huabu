// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Identifies this page: in `originator.tabId` of the structure edits it
 * sends, and as its page id in Space presence. A reload gets a new one.
 */
export const CANVAS_PAGE_ID =
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `page-${Date.now()}-${Math.random().toString(36).slice(2)}`;
