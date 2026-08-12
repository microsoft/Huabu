// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { shouldExposeConnectionPorts } from './NodeConnectAffordance';

describe('shouldExposeConnectionPorts', () => {
  it('exposes ports only for an idle sole selection', () => {
    expect(
      shouldExposeConnectionPorts({
        selected: true,
        connecting: false,
        hovered: false,
        dragging: false,
        multiSelectModifierHeld: false,
      }),
    ).toBe(true);
  });

  it('exposes target ports only while hovering a node during a connection drag', () => {
    expect(
      shouldExposeConnectionPorts({
        selected: false,
        connecting: true,
        hovered: true,
        dragging: false,
        multiSelectModifierHeld: false,
      }),
    ).toBe(true);

    expect(
      shouldExposeConnectionPorts({
        selected: false,
        connecting: true,
        hovered: false,
        dragging: false,
        multiSelectModifierHeld: false,
      }),
    ).toBe(false);
  });

  it.each([
    {
      selected: false,
      connecting: false,
      hovered: false,
      dragging: false,
      multiSelectModifierHeld: false,
    },
    {
      selected: true,
      connecting: false,
      hovered: false,
      dragging: true,
      multiSelectModifierHeld: false,
    },
    {
      selected: true,
      connecting: false,
      hovered: false,
      dragging: false,
      multiSelectModifierHeld: true,
    },
  ])('keeps ports hidden for %o', (state) => {
    expect(shouldExposeConnectionPorts(state)).toBe(false);
  });
});
