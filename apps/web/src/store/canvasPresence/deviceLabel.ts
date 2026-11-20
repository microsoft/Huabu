// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { CANVAS_PRESENCE_LIMITS } from '@huabu/shared';

/** Name of the app shell in a presence label; a product name, not translated. */
const DESKTOP_APP = 'Huabu';

function browserName(userAgent: string): string | null {
  // Order matters: Edge and Opera also say Chrome, Chrome also says Safari.
  if (/\bEdg(e|A|iOS)?\//.test(userAgent)) return 'Edge';
  if (/\bOPR\//.test(userAgent)) return 'Opera';
  if (/\b(Firefox|FxiOS)\//.test(userAgent)) return 'Firefox';
  if (/\b(Chrome|CriOS)\//.test(userAgent)) return 'Chrome';
  if (/\bSafari\//.test(userAgent)) return 'Safari';
  return null;
}

function systemName(userAgent: string): string | null {
  if (/iPhone|iPod/.test(userAgent)) return 'iPhone';
  if (/iPad/.test(userAgent)) return 'iPad';
  if (/Android/.test(userAgent)) return 'Android';
  if (/Mac OS X|Macintosh/.test(userAgent)) return 'Mac';
  if (/Windows/.test(userAgent)) return 'Windows';
  if (/CrOS/.test(userAgent)) return 'ChromeOS';
  if (/Linux/.test(userAgent)) return 'Linux';
  return null;
}

/**
 * Short label that tells this page's device apart from the others, such as
 * `Chrome · Mac`. Empty when nothing can be told; the viewer then shows its
 * own fallback text.
 */
export function presenceDeviceLabel(
  userAgent: string,
  desktopApp: boolean,
): string {
  const app = desktopApp ? DESKTOP_APP : browserName(userAgent);
  return [app, systemName(userAgent)]
    .filter((part): part is string => part !== null)
    .join(' · ')
    .slice(0, CANVAS_PRESENCE_LIMITS.labelMaxLength);
}
