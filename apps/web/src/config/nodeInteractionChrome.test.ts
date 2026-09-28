// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  NODE_CONNECTION_CHROME,
  nodeToolbarOffset,
} from './nodeInteractionChrome';

describe('selected node chrome clearance', () => {
  it.each([false, true])(
    'clears the full port hit area without entering the node (touch=%s)',
    (touch) => {
      const pointer = touch ? 'touch' : 'mouse';
      const chrome = NODE_CONNECTION_CHROME;
      const outerHit =
        chrome.outwardOffset +
        (touch
          ? chrome.hitSize[pointer] - chrome.dotSize[pointer] / 2
          : chrome.hitSize[pointer] / 2);
      expect(nodeToolbarOffset(touch) - outerHit).toBe(touch ? 8 : 2);
      expect(nodeToolbarOffset(touch)).toBe(touch ? 45 : 28);
      expect(
        chrome.outwardOffset - chrome.hitSize[pointer] / 2,
      ).toBeGreaterThan(0);
      expect(
        chrome.outwardOffset - chrome.dotSize[pointer] / 2,
      ).toBeGreaterThan(6);
    },
  );
});
