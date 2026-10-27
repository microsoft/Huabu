// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MilkdownMessageCard } from '@/components/Messages/AIMessage/MilkdownMessageCard';
import { NotePreview } from '@/components/Nodes/note/NotePreview';
import { i18n } from '@/i18n';
import { useToolStore } from '@/store/toolStore';
import { registerCanvasDropTarget } from '@/utils/io/canvasDropTargets';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
let canvas: HTMLDivElement;
let pane: HTMLDivElement;
let unregister: () => void;
const drop = vi.fn();

beforeEach(() => {
  useToolStore.setState({ inputModePreference: 'finger' });
  host = document.createElement('div');
  canvas = document.createElement('div');
  canvas.setAttribute('data-canvas-root', '');
  pane = document.createElement('div');
  pane.className = 'react-flow__pane';
  canvas.append(pane);
  document.body.append(host, canvas);
  root = createRoot(host);
  drop.mockClear();
  unregister = registerCanvasDropTarget(canvas, drop);
  vi.spyOn(document, 'elementFromPoint').mockReturnValue(pane);
});

afterEach(() => {
  act(() => root.unmount());
  unregister();
  host.remove();
  canvas.remove();
  useToolStore.setState({ inputModePreference: 'auto' });
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, 'elementsFromPoint');
});

function pointer(
  target: Element,
  type: string,
  x = 10,
  extra: PointerEventInit = {},
) {
  act(() => {
    target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerType: 'touch',
        pointerId: 1,
        isPrimary: true,
        clientX: x,
        clientY: 10,
        button: 0,
        ...extra,
      }),
    );
  });
}

async function grip() {
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(host.querySelector('.milkdown-touch-block-grip')).not.toBeNull();
  });
  const button = host.querySelector<HTMLButtonElement>(
    '.milkdown-touch-block-grip',
  );
  if (!button) throw new Error('Missing touch paragraph grip');
  button.setPointerCapture = vi.fn();
  return button;
}

describe('touch paragraph extraction', () => {
  it('keeps list-item boundaries rather than copying the whole list', async () => {
    act(() =>
      root.render(
        <MilkdownMessageCard
          content={'- First item\n- **Second** item'}
          threadId="thread-test"
        />,
      ),
    );
    const handle = await grip();
    const item = host.querySelectorAll('.ProseMirror li p')[1];
    pointer(item, 'pointerdown');
    pointer(item, 'pointerup');
    pointer(handle, 'pointerdown');
    pointer(handle, 'pointermove', 100);
    pointer(handle, 'pointerup', 100);
    expect(drop).toHaveBeenCalledOnce();
    expect(drop.mock.calls[0][0].data.content).toMatch(
      /^[-*] \*\*Second\*\* item$/,
    );
  });

  it('retains the image payload type for a standalone Agent image', async () => {
    act(() =>
      root.render(
        <MilkdownMessageCard
          content="![Preview](art_preview.png)"
          threadId="thread-test"
        />,
      ),
    );
    const handle = await grip();
    pointer(handle, 'pointerdown');
    pointer(handle, 'pointermove', 100);
    pointer(handle, 'pointerup', 100);
    expect(drop).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        kind: 'image',
        data: { src: 'art_preview.png', label: 'Preview' },
      }),
      { x: 100, y: 10 },
    );
  });

  it('accepts empty canvas under the Pen overlay but never a covered node', async () => {
    act(() =>
      root.render(
        <MilkdownMessageCard
          content="Keep this paragraph."
          threadId="thread-test"
        />,
      ),
    );
    const handle = await grip();
    const overlay = document.createElement('div');
    overlay.setAttribute('data-sketch-overlay', '');
    canvas.append(overlay);
    vi.mocked(document.elementFromPoint).mockReturnValue(overlay);
    const stack = vi.fn().mockReturnValue([overlay, pane, canvas]);
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: stack,
    });
    pointer(handle, 'pointerdown');
    pointer(handle, 'pointermove', 100);
    pointer(handle, 'pointerup', 100);
    expect(drop).toHaveBeenCalledOnce();
    drop.mockClear();
    stack.mockReturnValue([overlay, host, pane, canvas]);
    pointer(handle, 'pointerdown');
    pointer(handle, 'pointermove', 100);
    pointer(handle, 'pointerup', 100);
    expect(drop).not.toHaveBeenCalled();
  });

  it('opens existing Notes without editing or autofocus, and explicitly enters/exits editing', async () => {
    const handled = vi.fn();
    const change = vi.fn();
    act(() =>
      root.render(
        <NotePreview
          id="source-note"
          data={{ content: 'First paragraph.\n\nSecond paragraph.' }}
          focusRequestNonce={1}
          onFocusRequestHandled={handled}
          onDataChange={change}
        />,
      ),
    );
    await grip();
    const editor = host.querySelector<HTMLElement>('.ProseMirror');
    expect(editor?.getAttribute('contenteditable')).toBe('false');
    expect(document.activeElement).not.toBe(editor);
    expect(handled).toHaveBeenCalledWith(1);
    const edit = host.querySelector<HTMLButtonElement>(
      `[aria-label="${i18n.t('editor.editNote')}"]`,
    );
    act(() => edit?.click());
    expect(editor?.getAttribute('contenteditable')).toBe('true');
    expect(host.querySelector('.milkdown-touch-block-grip')).toBeNull();
    const done = host.querySelector<HTMLButtonElement>(
      `[aria-label="${i18n.t('editor.finishNoteEditing')}"]`,
    );
    act(() => done?.click());
    await grip();
    expect(editor?.getAttribute('contenteditable')).toBe('false');
    expect(document.activeElement).not.toBe(editor);
    expect(change).not.toHaveBeenCalled();
  });

  it('copies the tapped paragraph with Note provenance, retaining the complete original', async () => {
    const content = 'First paragraph.\n\nSecond **complete** paragraph.';
    const change = vi.fn();
    act(() =>
      root.render(
        <NotePreview
          id="source-note"
          data={{ content }}
          onDataChange={change}
        />,
      ),
    );
    const handle = await grip();
    const second = host.querySelectorAll('.ProseMirror p')[1];
    pointer(second, 'pointerdown');
    pointer(second, 'pointerup');
    pointer(handle, 'pointerdown');
    pointer(handle, 'pointermove', 100);
    pointer(handle, 'pointerup', 100);
    expect(drop).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        kind: 'note',
        origin: { type: 'user-excerpt', excerptFromNodeId: 'source-note' },
        data: { content: 'Second **complete** paragraph.' },
      }),
      { x: 100, y: 10 },
    );
    expect(change).not.toHaveBeenCalled();
    expect(host.querySelectorAll('.ProseMirror p')).toHaveLength(2);
    expect(host.querySelector('.milkdown-touch-drag-preview')).toBeNull();
  });

  it('makes Agent content genuinely read-only and carries the thread origin', async () => {
    act(() =>
      root.render(
        <MilkdownMessageCard
          content="Agent paragraph."
          threadId="thread-test"
        />,
      ),
    );
    const handle = await grip();
    expect(
      host.querySelector('.ProseMirror')?.getAttribute('contenteditable'),
    ).toBe('false');
    pointer(handle, 'pointerdown');
    pointer(handle, 'pointermove', 18);
    pointer(handle, 'pointerup', 18);
    expect(drop).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        kind: 'note',
        origin: { type: 'user-from-chat', threadId: 'thread-test' },
        data: { content: 'Agent paragraph.' },
      }),
      { x: 18, y: 10 },
    );
  });

  it.each([
    'tap',
    'below-threshold',
    'cancel',
    'lost-capture',
    'second-pointer',
    'outside',
    'unmount',
  ] as const)('does not create an excerpt on %s', async (scenario) => {
    act(() =>
      root.render(
        <MilkdownMessageCard
          content="Keep this paragraph."
          threadId="thread-test"
        />,
      ),
    );
    const handle = await grip();
    pointer(handle, 'pointerdown');
    if (scenario !== 'tap')
      pointer(handle, 'pointermove', scenario === 'below-threshold' ? 17 : 100);
    if (scenario === 'cancel') pointer(handle, 'pointercancel');
    if (scenario === 'lost-capture') pointer(handle, 'lostpointercapture');
    if (scenario === 'second-pointer')
      pointer(document.body, 'pointerdown', 20, {
        pointerId: 2,
        isPrimary: false,
      });
    if (scenario === 'outside')
      vi.mocked(document.elementFromPoint).mockReturnValue(host);
    if (scenario === 'unmount') act(() => root.render(null));
    pointer(handle, 'pointerup', 100);
    expect(drop).not.toHaveBeenCalled();
    expect(document.querySelector('.milkdown-touch-drag-preview')).toBeNull();
  });

  it.each(['empty', 'desktop'] as const)(
    'preserves direct editing for %s Notes',
    async (scenario) => {
      if (scenario === 'desktop')
        useToolStore.setState({ inputModePreference: 'mouse' });
      act(() =>
        root.render(
          <NotePreview
            data={{ content: scenario === 'empty' ? '' : 'Desktop editing.' }}
          />,
        ),
      );
      await act(async () =>
        vi.waitFor(() =>
          expect(
            host.querySelector('.ProseMirror')?.getAttribute('contenteditable'),
          ).toBe('true'),
        ),
      );
      expect(host.querySelector('.milkdown-touch-block-grip')).toBeNull();
    },
  );
});
