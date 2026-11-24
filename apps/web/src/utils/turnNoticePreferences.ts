// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  readApplicationPreference,
  writeApplicationPreference,
} from './desktopStorage';

import type { NoticePreferences } from './turnNotices';

const KEYS = {
  done: 'huabu.notifyTurnDone',
  needsYou: 'huabu.notifyNeedsYou',
} as const;

/** Both kinds of notification are on until the person turns one off. */
export function readNoticePreferences(): NoticePreferences {
  return {
    done: readApplicationPreference(KEYS.done) !== 'false',
    needsYou: readApplicationPreference(KEYS.needsYou) !== 'false',
  };
}

/** Absent means on, so only "off" is stored. */
export function writeNoticePreference(
  kind: keyof NoticePreferences,
  on: boolean,
): void {
  writeApplicationPreference(KEYS[kind], on ? null : 'false');
}
