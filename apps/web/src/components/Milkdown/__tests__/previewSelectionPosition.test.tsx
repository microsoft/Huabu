// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MilkdownPreview } from '../MilkdownPreview';

const mocks = vi.hoisted(() => ({
  getSelectionClientRect: vi.fn(),
  getTextSelection: vi.fn(),
  setMarkdown: vi.fn(),
}));

vi.mock('../createMilkdown', () => ({
  createMilkdown: async ({ root }: { root: HTMLElement }) => {
    const editor = document.createElement('div');
    editor.className = 'ProseMirror';
    editor.textContent = 'Selected passage';
    root.appendChild(editor);
    return {
      setAriaLabel: vi.fn(),
      setReadonly: vi.fn(),
      destroy: vi.fn(),
      getSelectionClientRect: mocks.getSelectionClientRect,
      getTextSelection: mocks.getTextSelection,
      setMarkdown: mocks.setMarkdown,
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
  mocks.setMarkdown.mockClear();
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
  async function update(markdown: string, enabled = true) {
    await act(async () => {
      root.render(
        <MilkdownPreview
          markdown={markdown}
          onTextSelection={enabled ? onTextSelection : undefined}
        />,
      );
    });
  }

  it('defers streaming updates until the selection clears and applies only the latest', async () => {
    await dispatch(editor, new MouseEvent('mouseup', { bubbles: true }));
    await update('Selected passage, more');
    await update('Selected passage, latest');
    expect(mocks.setMarkdown).not.toHaveBeenCalled();
    expect(document.getSelection()?.toString()).toBe('Selected passage');
    document.getSelection()?.collapseToEnd();
    await dispatch(document, new Event('selectionchange'));
    expect(mocks.setMarkdown).toHaveBeenCalledExactlyOnceWith(
      'Selected passage, latest',
    );
    expect(onTextSelection).toHaveBeenLastCalledWith(null);
  });

  it('defers updates during a mouse drag even before a text range exists', async () => {
    document.getSelection()?.removeAllRanges();
    await dispatch(editor, new MouseEvent('mousedown', { bubbles: true }));
    await update('Selected passage, streaming');
    expect(mocks.setMarkdown).not.toHaveBeenCalled();
    await dispatch(document.body, new MouseEvent('mouseup', { bubbles: true }));
    expect(mocks.setMarkdown).toHaveBeenCalledExactlyOnceWith(
      'Selected passage, streaming',
    );
  });

  it.each(['copy', 'none'])(
    'resumes updates after native image dragging ends without mouseup (dropEffect=%s)',
    async (dropEffect) => {
      document.getSelection()?.removeAllRanges();
      const image = document.createElement('img');
      editor.appendChild(image);
      await dispatch(image, new MouseEvent('mousedown', { bubbles: true }));
      await dispatch(image, new Event('dragstart', { bubbles: true }));
      await update('Selected passage, more');
      await update('Selected passage, latest');
      expect(mocks.setMarkdown).not.toHaveBeenCalled();
      const dragEnd = new Event('dragend', { bubbles: true });
      Object.defineProperty(dragEnd, 'dataTransfer', {
        value: { dropEffect },
      });
      await dispatch(image, dragEnd);
      expect(mocks.setMarkdown).toHaveBeenCalledExactlyOnceWith(
        'Selected passage, latest',
      );
      expect(onTextSelection).toHaveBeenLastCalledWith(null);
      await update('Selected passage, next');
      expect(mocks.setMarkdown).toHaveBeenLastCalledWith(
        'Selected passage, next',
      );
    },
  );

  it('preserves a genuine text-selection hold after native drag ends', async () => {
    await dispatch(editor, new MouseEvent('mousedown', { bubbles: true }));
    await dispatch(editor, new Event('dragstart', { bubbles: true }));
    await update('Selected passage, streaming');
    await dispatch(editor, new Event('dragend', { bubbles: true }));
    expect(mocks.setMarkdown).not.toHaveBeenCalled();
    expect(document.getSelection()?.toString()).toBe('Selected passage');
    expect(onTextSelection).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: 'Selected passage' }),
    );
    document.getSelection()?.collapseToEnd();
    await dispatch(document, new Event('selectionchange'));
    expect(mocks.setMarkdown).toHaveBeenCalledExactlyOnceWith(
      'Selected passage, streaming',
    );
  });

  it('applies pending content when the panel disables selection reporting', async () => {
    await update('Selected passage, streaming');
    expect(mocks.setMarkdown).not.toHaveBeenCalled();
    await update('Selected passage, streaming', false);
    expect(mocks.setMarkdown).toHaveBeenCalledExactlyOnceWith(
      'Selected passage, streaming',
    );
  });

  it('discards a deferred update when the source returns to the displayed content', async () => {
    await update('Selected passage, temporary');
    await update('Selected passage');
    document.getSelection()?.collapseToEnd();
    await dispatch(document, new Event('selectionchange'));
    expect(mocks.setMarkdown).not.toHaveBeenCalled();
  });

  it('updates immediately when there is no text selection', async () => {
    document.getSelection()?.removeAllRanges();
    await update('Selected passage, streaming');
    expect(mocks.setMarkdown).toHaveBeenCalledExactlyOnceWith(
      'Selected passage, streaming',
    );
  });

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
