// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MilkdownPreview } from '../MilkdownPreview';

const mocks = vi.hoisted(() => ({
  getSelectionClientRect: vi.fn(),
  getTextSelection: vi.fn(),
}));

vi.mock('../createMilkdown', () => ({
  createMilkdown: async ({ root }: { root: HTMLElement }) => {
    const editor = document.createElement('div');
    editor.className = 'ProseMirror';
    editor.textContent = 'Selected passage';
    root.appendChild(editor);
    return {
      setAriaLabel: vi.fn(),
      destroy: vi.fn(),
      getSelectionClientRect: mocks.getSelectionClientRect,
      getTextSelection: mocks.getTextSelection,
    };
  },
}));
vi.mock('../blockDrag', () => ({
  attachBlockDragListeners: () => () => {},
}));

let host: HTMLDivElement;
let root: Root;
let editor: HTMLElement;
const onTextSelection = vi.fn();

beforeEach(async () => {
  mocks.getSelectionClientRect.mockReturnValue(new DOMRect(20, 30, 180, 40));
  mocks.getTextSelection.mockReturnValue({
    range: { from: 1, to: 17 },
    text: 'Selected passage',
    markdown: 'Selected passage',
    contextBefore: '',
    contextAfter: '',
  });
  onTextSelection.mockClear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <MilkdownPreview
        markdown="Selected passage"
        onTextSelection={onTextSelection}
      />,
    );
  });
  const element = host.querySelector<HTMLElement>('.ProseMirror');
  if (!element?.firstChild) throw new Error('Missing preview text');
  editor = element;
  const range = document.createRange();
  range.selectNodeContents(editor);
  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  vi.spyOn(Range.prototype, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(190, 50, 0, 20),
  );
});

afterEach(() => {
  act(() => root.unmount());
  document.getSelection()?.removeAllRanges();
  host.remove();
  vi.restoreAllMocks();
});

async function dispatch(target: EventTarget, event: Event) {
  await act(async () => {
    target.dispatchEvent(event);
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
  });
}

describe('preview selection popover positioning', () => {
  it.each([
    [170, 65],
    [25, 35],
  ])(
    'anchors at mouse release %s, %s and does not follow movement',
    async (x, y) => {
      await dispatch(
        editor,
        new MouseEvent('mouseup', { bubbles: true, clientX: x, clientY: y }),
      );
      expect(onTextSelection).toHaveBeenLastCalledWith(
        expect.objectContaining({ position: { x, y } }),
      );
      onTextSelection.mockClear();
      await dispatch(
        document,
        new MouseEvent('mousemove', {
          bubbles: true,
          clientX: 400,
          clientY: 300,
        }),
      );
      expect(onTextSelection).not.toHaveBeenCalled();
    },
  );

  it('captures release outside the preview when selection started inside', async () => {
    await dispatch(editor, new MouseEvent('mousedown', { bubbles: true }));
    await dispatch(
      document.body,
      new MouseEvent('mouseup', { bubbles: true, clientX: 250, clientY: 80 }),
    );
    expect(onTextSelection).toHaveBeenLastCalledWith(
      expect.objectContaining({ position: { x: 250, y: 80 } }),
    );
  });

  it('moves the mouse anchor with the selected content on scroll', async () => {
    await dispatch(
      editor,
      new MouseEvent('mouseup', { bubbles: true, clientX: 170, clientY: 65 }),
    );
    mocks.getSelectionClientRect.mockReturnValue(new DOMRect(20, 10, 180, 40));
    await dispatch(window, new Event('scroll'));
    expect(onTextSelection).toHaveBeenLastCalledWith(
      expect.objectContaining({ position: { x: 170, y: 45 } }),
    );
  });

  it('uses the keyboard focus endpoint instead of the previous mouse position', async () => {
    await dispatch(
      editor,
      new MouseEvent('mouseup', { bubbles: true, clientX: 100, clientY: 60 }),
    );
    await dispatch(
      editor,
      new KeyboardEvent('keyup', {
        bubbles: true,
        key: 'ArrowRight',
        shiftKey: true,
      }),
    );
    expect(onTextSelection).toHaveBeenLastCalledWith(
      expect.objectContaining({ position: { x: 190, y: 70 } }),
    );
  });

  it('positions backward keyboard selections at the focus endpoint', async () => {
    const text = editor.firstChild;
    if (!text) throw new Error('Missing preview text');
    document.getSelection()?.setBaseAndExtent(text, 16, text, 0);
    vi.mocked(Range.prototype.getBoundingClientRect).mockReturnValue(
      new DOMRect(20, 30, 0, 20),
    );
    await dispatch(
      editor,
      new KeyboardEvent('keyup', {
        bubbles: true,
        key: 'ArrowLeft',
        shiftKey: true,
      }),
    );
    expect(onTextSelection).toHaveBeenLastCalledWith(
      expect.objectContaining({ position: { x: 20, y: 50 } }),
    );
  });

  it('clears the popover when the selection collapses', async () => {
    await dispatch(
      editor,
      new MouseEvent('mouseup', { bubbles: true, clientX: 100, clientY: 60 }),
    );
    document.getSelection()?.collapseToEnd();
    await dispatch(document, new Event('selectionchange'));
    expect(onTextSelection).toHaveBeenLastCalledWith(null);
  });
});
