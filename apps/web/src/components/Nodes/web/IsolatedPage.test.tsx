// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { canIsolatePages, IsolatedPage, isolatedPageUrl } from './IsolatedPage';

import type { PagePreviewState } from '@/hooks/useElectron';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const bridge = {
  show: vi.fn(),
  place: vi.fn(),
  hide: vi.fn(),
  reload: vi.fn(),
  close: vi.fn(),
  onState: vi.fn(),
  onFocus: vi.fn(),
};
let reportState: (state: PagePreviewState) => void;
let reportFocus: (id: string) => void;
let frame: FrameRequestCallback | null;
let covering: Element | null;
let root: Root;
let container: HTMLDivElement;

/** Run what the page does over a few animation frames. */
async function nextFrame() {
  // Enough frames for it to look again at what is drawn on top.
  for (let count = 0; count < 3; count += 1) {
    const run = frame;
    frame = null;
    await act(async () => run?.(0));
  }
}

function host(): HTMLElement {
  const found = container.querySelector<HTMLElement>('[data-isolated-page]');
  if (!found) throw new Error('Missing page host');
  return found;
}

beforeEach(() => {
  vi.clearAllMocks();
  bridge.show.mockResolvedValue({ ok: true });
  bridge.hide.mockResolvedValue('data:image/jpeg;base64,AAAA');
  bridge.onState.mockImplementation((callback) => {
    reportState = callback;
    return () => {};
  });
  bridge.onFocus.mockImplementation((callback) => {
    reportFocus = callback;
    return () => {};
  });
  (window as { electronBridge?: unknown }).electronBridge = {
    isElectron: true,
    pagePreview: bridge,
  };
  frame = null;
  covering = null;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frame = callback;
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {
    frame = null;
  });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 600,
    top: 80,
    width: 400,
    height: 500,
    right: 1000,
    bottom: 580,
    x: 600,
    y: 80,
    toJSON: () => ({}),
  });
  document.elementFromPoint = () => covering ?? host();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (window as { electronBridge?: unknown }).electronBridge;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function render(url = 'https://example.com/page', reloadNonce = 0) {
  await act(async () => {
    root.render(<IsolatedPage url={url} reloadNonce={reloadNonce} />);
  });
}

describe('isolatedPageUrl', () => {
  it('is another site’s web page, and nothing else', () => {
    expect(isolatedPageUrl('https://example.com/a')).toBe(
      'https://example.com/a',
    );
    expect(isolatedPageUrl(`${window.location.origin}/api/x`)).toBeNull();
    expect(isolatedPageUrl('/api/canvas/one/artifact/page.html')).toBeNull();
    expect(isolatedPageUrl('data:text/html,hi')).toBeNull();
    expect(isolatedPageUrl('file:///etc/passwd')).toBeNull();
  });
});

describe('IsolatedPage', () => {
  it('is offered only where the desktop app provides it', () => {
    expect(canIsolatePages()).toBe(true);
    delete (window as { electronBridge?: unknown }).electronBridge;
    expect(canIsolatePages()).toBe(false);
  });

  it('asks for the page and places it over its own rectangle', async () => {
    await render();
    expect(container.querySelector('iframe')).toBeNull();
    expect(bridge.show).toHaveBeenCalledExactlyOnceWith(
      expect.any(String),
      'https://example.com/page',
    );
    const id = bridge.show.mock.calls[0][0] as string;
    await nextFrame();
    expect(bridge.place).toHaveBeenCalledExactlyOnceWith(id, {
      x: 600,
      y: 80,
      width: 400,
      height: 500,
    });
    // Nothing moved: nothing is sent.
    await nextFrame();
    expect(bridge.place).toHaveBeenCalledOnce();
  });

  it('steps aside for anything drawn over it, leaving a picture', async () => {
    await render();
    await nextFrame();
    covering = document.body;
    await nextFrame();
    expect(bridge.hide).toHaveBeenCalledOnce();
    const picture = container.querySelector('img');
    expect(picture?.getAttribute('src')).toBe('data:image/jpeg;base64,AAAA');
    // At the size the page had, not stretched to whatever this becomes.
    expect(picture?.style.width).toBe('400px');
    expect(picture?.style.height).toBe('500px');
    expect(picture?.hasAttribute('data-set-aside')).toBe(false);
    await nextFrame();
    expect(bridge.hide).toHaveBeenCalledOnce();

    covering = null;
    await nextFrame();
    expect(bridge.place).toHaveBeenCalledTimes(2);
  });

  it('steps aside while something is dragged, but not for a click', async () => {
    await render();
    await nextFrame();
    const press = (type: string, x: number) =>
      document.body.dispatchEvent(
        new MouseEvent(type, { bubbles: true, clientX: x, clientY: 10 }),
      );
    press('pointerdown', 10);
    press('pointermove', 12);
    await nextFrame();
    expect(bridge.hide).not.toHaveBeenCalled();
    press('pointermove', 40);
    await nextFrame();
    expect(bridge.hide).toHaveBeenCalledOnce();
    expect(container.querySelector('img')?.hasAttribute('data-set-aside')).toBe(
      true,
    );
    press('pointerup', 40);
    await nextFrame();
    expect(bridge.place).toHaveBeenCalledTimes(2);
    expect(container.querySelector('img')?.hasAttribute('data-set-aside')).toBe(
      false,
    );
  });

  it('stays live and follows while a panel is resized', async () => {
    await render();
    await nextFrame();
    const handle = document.createElement('div');
    handle.style.cursor = 'col-resize';
    const grip = document.createElement('span');
    handle.append(grip);
    document.body.append(handle);
    const press = (type: string, x: number) =>
      grip.dispatchEvent(
        new MouseEvent(type, { bubbles: true, clientX: x, clientY: 10 }),
      );
    press('pointerdown', 590);
    press('pointermove', 500);
    vi.mocked(Element.prototype.getBoundingClientRect).mockReturnValue({
      left: 500,
      top: 80,
      width: 500,
      height: 500,
      right: 1000,
      bottom: 580,
      x: 500,
      y: 80,
      toJSON: () => ({}),
    });
    await nextFrame();
    expect(bridge.hide).not.toHaveBeenCalled();
    expect(bridge.place).toHaveBeenLastCalledWith(expect.any(String), {
      x: 500,
      y: 80,
      width: 500,
      height: 500,
    });
    press('pointerup', 500);
    handle.remove();
  });

  it('shows a failed load in place of the page, with a retry', async () => {
    await render();
    await nextFrame();
    const id = bridge.show.mock.calls[0][0] as string;
    act(() =>
      reportState({ id: 'another-page', loading: false, error: 'ignored' }),
    );
    expect(container.textContent).not.toContain('node.failedLoadPage');
    act(() => reportState({ id, loading: false, error: 'ERR_NAME' }));
    expect(container.textContent).toContain('node.failedLoadPage');
    expect(container.textContent).toContain('ERR_NAME');
    // The page would cover the message.
    await nextFrame();
    expect(bridge.hide).toHaveBeenCalledOnce();
    act(() => container.querySelector('button')?.click());
    expect(bridge.reload).toHaveBeenCalledExactlyOnceWith(id);
    expect(container.textContent).not.toContain('node.failedLoadPage');
  });

  it('reports a click into the page as a press here', async () => {
    await render();
    const id = bridge.show.mock.calls[0][0] as string;
    const pressed = vi.fn();
    document.addEventListener('pointerdown', pressed);
    act(() => reportFocus('another-page'));
    expect(pressed).not.toHaveBeenCalled();
    act(() => reportFocus(id));
    expect(pressed).toHaveBeenCalledOnce();
    document.removeEventListener('pointerdown', pressed);
  });

  it('reloads on request, follows a new address, and closes when removed', async () => {
    await render();
    const id = bridge.show.mock.calls[0][0] as string;
    await render('https://example.com/page', 1);
    expect(bridge.reload).toHaveBeenCalledExactlyOnceWith(id);
    await render('https://example.com/other', 1);
    expect(bridge.show).toHaveBeenLastCalledWith(
      id,
      'https://example.com/other',
    );
    expect(bridge.close).not.toHaveBeenCalled();
    act(() => root.unmount());
    expect(bridge.close).toHaveBeenCalledExactlyOnceWith(id);
    root = createRoot(container);
  });
});
