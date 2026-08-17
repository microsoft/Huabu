// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { attachCanvasPanReleaseGuard } from './useCanvasPanReleaseGuard';

describe('attachCanvasPanReleaseGuard', () => {
  let wrapper: HTMLDivElement;
  let detach: (() => void) | null;
  let frameCallback: FrameRequestCallback | null;

  beforeEach(() => {
    wrapper = document.createElement('div');
    document.body.appendChild(wrapper);
    detach = null;
    frameCallback = null;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frameCallback = callback;
      return 1;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {
      frameCallback = null;
    });
  });

  afterEach(() => {
    detach?.();
    wrapper.remove();
    vi.restoreAllMocks();
  });

  const pointer = (type: 'pointerdown' | 'pointerup', init: PointerEventInit) =>
    new PointerEvent(type, { bubbles: true, ...init });

  it('lets the native mouseup finish the pan without a fallback', () => {
    const mouseUp = vi.fn();
    window.addEventListener('mouseup', mouseUp);
    detach = attachCanvasPanReleaseGuard(wrapper, () => true);

    wrapper.dispatchEvent(
      pointer('pointerdown', { pointerId: 1, pointerType: 'mouse', button: 0 }),
    );
    window.dispatchEvent(
      pointer('pointerup', { pointerId: 1, pointerType: 'mouse', button: 0 }),
    );
    window.dispatchEvent(new MouseEvent('mouseup'));
    frameCallback?.(16);

    expect(mouseUp).toHaveBeenCalledTimes(1);
    window.removeEventListener('mouseup', mouseUp);
  });

  it('dispatches a fallback mouseup when pointerup has no matching mouseup', () => {
    const mouseUp = vi.fn();
    window.addEventListener('mouseup', mouseUp);
    detach = attachCanvasPanReleaseGuard(wrapper, () => true);

    wrapper.dispatchEvent(
      pointer('pointerdown', { pointerId: 1, pointerType: 'mouse', button: 0 }),
    );
    window.dispatchEvent(
      pointer('pointerup', {
        pointerId: 1,
        pointerType: 'mouse',
        button: 0,
        clientX: 20,
        clientY: 30,
      }),
    );
    frameCallback?.(16);

    expect(mouseUp).toHaveBeenCalledTimes(1);
    expect(mouseUp.mock.calls[0]?.[0]).toMatchObject({
      button: 0,
      clientX: 20,
      clientY: 30,
    });
    window.removeEventListener('mouseup', mouseUp);
  });

  it('recovers when release events are lost but the pointer has no buttons', () => {
    const mouseUp = vi.fn();
    window.addEventListener('mouseup', mouseUp);
    detach = attachCanvasPanReleaseGuard(wrapper, () => true);

    wrapper.dispatchEvent(
      pointer('pointerdown', { pointerId: 1, pointerType: 'mouse', button: 0 }),
    );
    window.dispatchEvent(
      new PointerEvent('pointermove', {
        pointerId: 1,
        pointerType: 'mouse',
        buttons: 0,
      }),
    );

    expect(mouseUp).toHaveBeenCalledTimes(1);
    window.removeEventListener('mouseup', mouseUp);
  });

  it('ignores a left-button gesture when left-drag Pan is disabled', () => {
    const mouseUp = vi.fn();
    window.addEventListener('mouseup', mouseUp);
    detach = attachCanvasPanReleaseGuard(wrapper, () => false);

    wrapper.dispatchEvent(
      pointer('pointerdown', { pointerId: 1, pointerType: 'mouse', button: 0 }),
    );
    window.dispatchEvent(
      pointer('pointerup', { pointerId: 1, pointerType: 'mouse', button: 0 }),
    );

    expect(frameCallback).toBeNull();
    expect(mouseUp).not.toHaveBeenCalled();
    window.removeEventListener('mouseup', mouseUp);
  });

  it('guards middle-button Pan independently of the selected tool', () => {
    const mouseUp = vi.fn();
    window.addEventListener('mouseup', mouseUp);
    detach = attachCanvasPanReleaseGuard(wrapper, () => false);

    wrapper.dispatchEvent(
      pointer('pointerdown', { pointerId: 1, pointerType: 'mouse', button: 1 }),
    );
    window.dispatchEvent(
      pointer('pointerup', { pointerId: 1, pointerType: 'mouse', button: 1 }),
    );
    frameCallback?.(16);

    expect(mouseUp).toHaveBeenCalledTimes(1);
    expect(mouseUp.mock.calls[0]?.[0]).toMatchObject({ button: 1 });
    window.removeEventListener('mouseup', mouseUp);
  });
});
