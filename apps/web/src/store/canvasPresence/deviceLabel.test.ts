// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, it } from 'vitest';

import { presenceDeviceLabel } from './deviceLabel';

const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/';

it.each([
  [
    `${MAC}537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36`,
    'Chrome · Mac',
  ],
  [
    `${MAC}605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15`,
    'Safari · Mac',
  ],
  [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0',
    'Edge · Windows',
  ],
  [
    'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0',
    'Firefox · Linux',
  ],
  [
    'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    'Safari · iPad',
  ],
  ['', ''],
])('labels %s as %s', (userAgent, label) => {
  expect(presenceDeviceLabel(userAgent, false)).toBe(label);
});

it('names the desktop app instead of its embedded browser', () => {
  expect(
    presenceDeviceLabel(
      `${MAC}537.36 Chrome/130.0 Electron/33.0 Safari/537.36`,
      true,
    ),
  ).toBe('Huabu · Mac');
});
