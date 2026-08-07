// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { attachBlockDragListeners } from '../blockDrag';
import { createMilkdown, type MilkdownInstance } from '../createMilkdown';

import type { MilkdownBlockDragEvent } from '../types';

let instances: MilkdownInstance[] = [];
let roots: HTMLElement[] = [];
let detachers: (() => void)[] = [];

interface Harness {
  instance: MilkdownInstance;
  root: HTMLElement;
  handle: HTMLElement;
  onDragStart: ReturnType<typeof vi.fn>;
  setDraggingSlice: ReturnType<typeof vi.spyOn>;
  clearDraggingSlice: ReturnType<typeof vi.spyOn>;
}

/**
 * Mount a real Crepe instance, attach the shared drag listeners, and
 * expose spies on the two `view.dragging` mutators. A stub block handle
 * is injected because Crepe only renders its own handle on hover, which
 * has no meaning without layout.
 */
async function mountWithDragListeners(markdown: string): Promise<Harness> {
  const root = document.createElement('div');
  document.body.appendChild(root);
  roots.push(root);
  const instance = await createMilkdown({
    root,
    initialMarkdown: markdown,
    toolbarMode: 'none',
  });
  instances.push(instance);

  const handle = document.createElement('div');
  handle.className = 'milkdown-block-handle';
  root.appendChild(handle);

  const onDragStart = vi.fn<(event: MilkdownBlockDragEvent) => void>();
  detachers.push(
    attachBlockDragListeners({
      mountRoot: root,
      instanceRef: { current: instance },
      onDragStartRef: { current: onDragStart },
    }),
  );

  return {
    instance,
    root,
    handle,
    onDragStart,
    setDraggingSlice: vi.spyOn(instance, 'setDraggingSlice'),
    clearDraggingSlice: vi.spyOn(instance, 'clearDraggingSlice'),
  };
}

/**
 * Fire a `dragstart` carrying a DataTransfer stand-in complete enough
 * for ProseMirror's own `handlers.dragstart` to run against it — that
 * handler is exactly what the image path must not have clobbered.
 */
function dispatchDragStart(target: Element): void {
  const event = new Event('dragstart', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', {
    value: {
      effectAllowed: 'uninitialized',
      files: [],
      clearData: vi.fn(),
      getData: vi.fn(() => ''),
      setData: vi.fn(),
      setDragImage: vi.fn(),
    },
  });
  target.dispatchEvent(event);
}

afterEach(async () => {
  for (const detach of detachers) detach();
  await Promise.all(instances.map((instance) => instance.destroy()));
  for (const root of roots) root.remove();
  detachers = [];
  instances = [];
  roots = [];
  vi.restoreAllMocks();
});

describe('attachBlockDragListeners — native dragging ownership', () => {
  it('registers the full-block slice for a multi-block handle drag', async () => {
    const harness = await mountWithDragListeners(
      'first paragraph\n\nsecond paragraph\n\nthird paragraph',
    );
    harness.instance.__selectTextBetweenForTest?.('paragraph', 'third');
    const dragRange = harness.instance.getMultiBlockSelectionRange();
    expect(dragRange).not.toBeNull();

    harness.handle.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true }),
    );
    dispatchDragStart(harness.handle);

    expect(harness.onDragStart).toHaveBeenCalledTimes(1);
    expect(harness.setDraggingSlice).toHaveBeenCalledTimes(1);
    expect(harness.setDraggingSlice).toHaveBeenCalledWith(dragRange);

    harness.handle.dispatchEvent(new Event('dragend', { bubbles: true }));
    expect(harness.clearDraggingSlice).toHaveBeenCalledTimes(1);
  });

  it('leaves ProseMirror to own the dragging slice for an image drag', async () => {
    const harness = await mountWithDragListeners(
      'before\n\n![alt text](art_abc.png)\n\nafter',
    );
    const img = harness.root.querySelector('img');
    expect(img).not.toBeNull();

    dispatchDragStart(img as HTMLImageElement);

    // The image lives inside `view.dom`, so ProseMirror's own dragstart
    // has already stored a `NodeSelection`-backed `Dragging`. Overwriting
    // it would strip the `node` that drives an exact `node.replace(tr)`
    // on drop, turning an in-editor image move into a duplicate.
    expect(harness.onDragStart).toHaveBeenCalledTimes(1);
    expect(harness.onDragStart.mock.calls[0][0].markdown).toContain(
      'art_abc.png',
    );
    expect(harness.setDraggingSlice).not.toHaveBeenCalled();

    // Ownership is symmetric: nothing was registered, so nothing is torn
    // down, and ProseMirror's own delayed cleanup stays authoritative.
    harness.handle.dispatchEvent(new Event('dragend', { bubbles: true }));
    expect(harness.clearDraggingSlice).not.toHaveBeenCalled();
  });

  it('leaves Crepe to own the dragging slice for a single-block handle drag', async () => {
    const harness = await mountWithDragListeners(
      'first paragraph\n\nsecond paragraph',
    );
    // Mirrors the NodeSelection Crepe's own mousedown installs when there
    // is no multi-block selection to preserve.
    harness.instance.__selectCurrentBlockForTest?.();
    expect(harness.instance.getMultiBlockSelectionRange()).toBeNull();

    harness.handle.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true }),
    );
    dispatchDragStart(harness.handle);

    expect(harness.onDragStart).toHaveBeenCalledTimes(1);
    expect(harness.setDraggingSlice).not.toHaveBeenCalled();

    harness.handle.dispatchEvent(new Event('dragend', { bubbles: true }));
    expect(harness.clearDraggingSlice).not.toHaveBeenCalled();
  });
});
