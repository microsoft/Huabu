// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { ACCENT_NONE_TOKEN } from '@huabu/shared';

import {
  nodeAccentPickerOptions,
  nodeAccentPickerValue,
} from './nodeAccentPickerOptions';

describe('nodeAccentPickerOptions', () => {
  it.each(['image', 'video', 'text'])(
    'preserves the transparent sentinel for %s',
    (type) => {
      expect(nodeAccentPickerOptions([type])).toContainEqual(
        expect.objectContaining({ token: ACCENT_NONE_TOKEN }),
      );
      expect(nodeAccentPickerValue(type, null)).toBe(ACCENT_NONE_TOKEN);
    },
  );

  it.each(['audio', 'frame', 'note', 'office', 'pdf', 'spacePreview', 'web'])(
    'omits the transparent sentinel and defaults %s to white',
    (type) => {
      expect(nodeAccentPickerOptions([type])).not.toContainEqual(
        expect.objectContaining({ token: ACCENT_NONE_TOKEN }),
      );
      expect(nodeAccentPickerValue(type, null)).toBe('white');
      expect(nodeAccentPickerValue(type, undefined)).toBe('white');
    },
  );

  it('omits the transparent sentinel from mixed surface selections', () => {
    expect(nodeAccentPickerOptions(['image', 'note'])).not.toContainEqual(
      expect.objectContaining({ token: ACCENT_NONE_TOKEN }),
    );
  });
});
