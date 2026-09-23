// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  NODE_CONNECTION_CHROME,
  nodeToolbarOffset,
} from './nodeInteractionChrome';

describe('selected node chrome clearance', () => {
  it.each([false, true])(
    'leaves 8px beyond the whole port hit area (touch=%s)',
    (touch) => {
      const pointer = touch ? 'touch' : 'mouse';
      const chrome = NODE_CONNECTION_CHROME;
      const outerHit =
        chrome.outwardOffset +
        chrome.hitSize[pointer] -
        chrome.dotSize[pointer] / 2;
      expect(nodeToolbarOffset(touch) - outerHit).toBe(8);
      expect(nodeToolbarOffset(touch)).toBe(touch ? 45 : 40);
      expect(
        chrome.outwardOffset - chrome.dotSize[pointer] / 2,
      ).toBeGreaterThan(6);
    },
  );
});
