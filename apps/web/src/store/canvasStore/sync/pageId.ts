// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { createUuid } from '@huabu/shared';

/**
 * Identifies this page: in `originator.tabId` of the structure edits it
 * sends, and as its page id in Space presence. A reload gets a new one.
 *
 * `crypto.randomUUID` exists only in a secure context; a deployment reached
 * over plain HTTP has `getRandomValues` alone, which `createUuid` uses.
 */
export const CANVAS_PAGE_ID = createUuid();
