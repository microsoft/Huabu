// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Behaviour "lock" for the guard-heavy {@link useCanvasShortcuts}, which is
 * intentionally NOT migrated to `matches(catalog)` (its context-specific
 * guards outweigh the drift win). Instead this test synthesises a keydown
 * from each catalog combo the hook owns and asserts the matching store
 * action fires — so if the catalog key and the hardcoded handler key ever
 * drift apart, this fails.
 */

const { canvasActions } = vi.hoisted(() => ({
  canvasActions: {
    frameSelectedNodes: vi.fn(),
    copySelectedNodes: vi.fn(),
    pasteNodes: vi.fn(),
    sendSelectedToOrder: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    deleteNodes: vi.fn(),
    disconnectEdges: vi.fn(),
    addNodes: vi.fn(),
    addNode: vi.fn(),
    canvasId: 'c1',
    nodes: [] as unknown[],
    edges: [] as unknown[],
  },
}));

vi.mock('../../store/canvasStore', () => {
  const useCanvasStore = (selector: (s: typeof canvasActions) => unknown) =>
    selector(canvasActions);
  useCanvasStore.getState = () => canvasActions;
  return { default: useCanvasStore };
});

import {
  useCanvasShortcuts,
  type CanvasShortcutRefs,
} from './useCanvasShortcuts';
import { getCombo } from '../../config/shortcuts';

// react-dom's `act` needs this flag set in a test environment.
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function dispatchCombo(id: string): void {
  const combo = getCombo(id);
  if (!combo) throw new Error(`No combo registered for "${id}"`);
  const primary = Array.isArray(combo.key) ? combo.key[0] : combo.key;
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: primary,
        metaKey: !!combo.mod,
        shiftKey: !!combo.shift,
        altKey: !!combo.alt,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
}

describe('useCanvasShortcuts catalog key lock', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const refs: CanvasShortcutRefs = {
      rfInstanceRef: { current: null },
      mousePositionRef: { current: { x: 0, y: 0 } },
    };
    function Harness() {
      const { tool } = useCanvasShortcuts(refs);
      return createElement('div', { 'data-tool': tool });
    }
    act(() => {
      root.render(createElement(Harness));
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('fires the matching store action for each catalog combo it owns', () => {
    dispatchCombo('edit.undo');
    expect(canvasActions.undo).toHaveBeenCalledTimes(1);

    dispatchCombo('edit.redo');
    expect(canvasActions.redo).toHaveBeenCalledTimes(1);

    dispatchCombo('edit.copy');
    expect(canvasActions.copySelectedNodes).toHaveBeenCalledTimes(1);

    dispatchCombo('layer.group');
    expect(canvasActions.frameSelectedNodes).toHaveBeenCalledTimes(1);

    dispatchCombo('layer.sendBack');
    expect(canvasActions.sendSelectedToOrder).toHaveBeenLastCalledWith(
      'bottom',
    );

    dispatchCombo('layer.bringFront');
    expect(canvasActions.sendSelectedToOrder).toHaveBeenLastCalledWith('top');
  });

  it('copies selected nodes when an editor retains focus without selected text', () => {
    const editor = document.createElement('textarea');
    editor.value = 'Note text';
    editor.setSelectionRange(4, 4);
    container.appendChild(editor);

    act(() => {
      editor.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'c',
          metaKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    expect(canvasActions.copySelectedNodes).toHaveBeenCalledOnce();
  });

  it('preserves native copy when text is selected in an editor', () => {
    const editor = document.createElement('textarea');
    editor.value = 'Note text';
    editor.setSelectionRange(0, 4);
    container.appendChild(editor);

    const event = new KeyboardEvent('keydown', {
      key: 'c',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => editor.dispatchEvent(event));

    expect(canvasActions.copySelectedNodes).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('keeps temporary pan active until the primary pointer is released', () => {
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: ' ', cancelable: true }),
      );
      window.dispatchEvent(
        new PointerEvent('pointerdown', {
          button: 0,
          isPrimary: true,
          pointerId: 1,
          pointerType: 'mouse',
        }),
      );
      window.dispatchEvent(new KeyboardEvent('keyup', { key: ' ' }));
    });
    expect(container.querySelector('[data-tool="pan"]')).not.toBeNull();

    act(() => {
      window.dispatchEvent(
        new PointerEvent('pointerup', {
          pointerId: 2,
          pointerType: 'mouse',
        }),
      );
    });
    expect(container.querySelector('[data-tool="pan"]')).not.toBeNull();

    act(() => {
      window.dispatchEvent(
        new PointerEvent('pointerup', {
          pointerId: 1,
          pointerType: 'mouse',
        }),
      );
    });
    expect(container.querySelector('[data-tool="pan"]')).not.toBeNull();

    act(() => {
      window.dispatchEvent(new MouseEvent('mouseup'));
    });
    expect(container.querySelector('[data-tool="select"]')).not.toBeNull();
  });

  it('keeps temporary pan active until Space is released', () => {
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: ' ', cancelable: true }),
      );
      window.dispatchEvent(
        new PointerEvent('pointerdown', {
          button: 0,
          isPrimary: true,
          pointerId: 1,
          pointerType: 'mouse',
        }),
      );
      window.dispatchEvent(
        new PointerEvent('pointerup', {
          pointerId: 1,
          pointerType: 'mouse',
        }),
      );
      window.dispatchEvent(new MouseEvent('mouseup'));
    });
    expect(container.querySelector('[data-tool="pan"]')).not.toBeNull();

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keyup', { key: ' ' }));
    });
    expect(container.querySelector('[data-tool="select"]')).not.toBeNull();
  });

  it('does not restore temporary pan between pointerup and mouseup', () => {
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: ' ', cancelable: true }),
      );
      window.dispatchEvent(
        new PointerEvent('pointerdown', {
          button: 0,
          isPrimary: true,
          pointerId: 1,
          pointerType: 'mouse',
        }),
      );
      window.dispatchEvent(
        new PointerEvent('pointerup', {
          pointerId: 1,
          pointerType: 'mouse',
        }),
      );
      window.dispatchEvent(new KeyboardEvent('keyup', { key: ' ' }));
    });
    expect(container.querySelector('[data-tool="pan"]')).not.toBeNull();

    act(() => {
      window.dispatchEvent(new MouseEvent('mouseup'));
    });
    expect(container.querySelector('[data-tool="select"]')).not.toBeNull();
  });

  it('restores temporary pan after touch pointerup without mouseup', () => {
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: ' ', cancelable: true }),
      );
      window.dispatchEvent(
        new PointerEvent('pointerdown', {
          button: 0,
          isPrimary: true,
          pointerId: 1,
          pointerType: 'touch',
        }),
      );
      window.dispatchEvent(new KeyboardEvent('keyup', { key: ' ' }));
      window.dispatchEvent(
        new PointerEvent('pointerup', {
          pointerId: 1,
          pointerType: 'touch',
        }),
      );
    });

    expect(container.querySelector('[data-tool="select"]')).not.toBeNull();
  });

  it('restores temporary pan when the window loses focus', () => {
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: ' ', cancelable: true }),
      );
      window.dispatchEvent(new Event('blur'));
    });
    expect(container.querySelector('[data-tool="select"]')).not.toBeNull();
  });
});
