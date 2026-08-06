// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it, vi } from 'vitest';

import { createHandlerOwnerRecognizer } from './handlerOwner';

import type { CanvasPointerRouterContext } from '@/handler/canvasPointerRouterContext';

const event = {} as PointerEvent;
const ctx = {} as CanvasPointerRouterContext;

describe('createHandlerOwnerRecognizer', () => {
  it('claims only when the handler confirms that the gesture started', () => {
    const onPointerDown = vi.fn(() => false);
    const recognizer = createHandlerOwnerRecognizer(
      'gesture',
      () => ({
        onPointerDown,
        onPointerMove: vi.fn(),
        onPointerUp: vi.fn(),
        onPointerCancel: vi.fn(),
      }),
      () => true,
    );

    expect(recognizer.canClaim(event, ctx)).toBe(true);
    expect(recognizer.onDown(event, ctx)).toBe('pass');

    onPointerDown.mockReturnValue(true);
    expect(recognizer.onDown(event, ctx)).toBe('claim');
  });
});
