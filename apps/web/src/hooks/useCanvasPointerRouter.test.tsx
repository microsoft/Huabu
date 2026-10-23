// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useGesturePreviewStore } from '@/store/gesturePreviewStore';
import * as inkSigil from '@/store/inkSigilStore';
import { useToolStore } from '@/store/toolStore';

import { useCanvasPointerRouter } from './useCanvasPointerRouter';
import { observeInputPointer, useInputModeStore } from './useInputMode';

import type { CanvasPointerRouterContext } from '@/handler/canvasPointerRouterContext';
import type { PointerRecognizer } from '@/handler/pointerRouter';
import type {
  EffectiveInputMode,
  InputModePreference,
} from '@/store/toolStore';
import type { ReactFlowInstance } from '@xyflow/react';

let root: Root;
let container: HTMLDivElement;
let wrapper: HTMLDivElement;
const initialTools = useToolStore.getState();
const initialInput = useInputModeStore.getState();
const onDown = vi.fn();
const recognizers: PointerRecognizer<
  PointerEvent,
  CanvasPointerRouterContext
>[] = [
  {
    id: 'test-pen',
    canClaim: (_event, context) => context.inputMode === 'pen',
    onDown: (event, context) => {
      onDown(event, context.inputMode);
      return 'claim';
    },
  },
];

// Simulate the trusted window capture listener; DOM-created pen events are untrusted.
const observePen = () => observeInputPointer('pen');

function Harness({
  inputMode,
  explicitToolActive = false,
  inkToolActive = false,
}: {
  inputMode: EffectiveInputMode;
  explicitToolActive?: boolean;
  inkToolActive?: boolean;
}) {
  useCanvasPointerRouter(
    { current: wrapper },
    { current: {} as ReactFlowInstance },
    {
      inputMode,
      explicitToolActive,
      inkToolActive,
      onTouchTakeover: vi.fn(),
      onEmptyCanvasTap: vi.fn(),
      onNodeTap: vi.fn(),
    },
    recognizers,
  );
  return null;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  onDown.mockClear();
  inkSigil.resetInkSigilSession();
  useGesturePreviewStore.getState().resetCanvasScopedTransients();
  useToolStore.setState({ inputModePreference: 'auto', penObserved: false });
  useInputModeStore.setState({ mode: 'touch' });
  container = document.createElement('div');
  wrapper = document.createElement('div');
  const captures = new Set<number>();
  wrapper.setPointerCapture = vi.fn((id: number) => {
    captures.add(id);
  });
  wrapper.hasPointerCapture = vi.fn((id: number) => captures.has(id));
  wrapper.releasePointerCapture = vi.fn((id: number) => {
    captures.delete(id);
  });
  document.body.append(container, wrapper);
  root = createRoot(container);
  window.addEventListener('pointerdown', observePen, true);
});

afterEach(() => {
  act(() => root.unmount());
  window.removeEventListener('pointerdown', observePen, true);
  container.remove();
  wrapper.remove();
  useToolStore.setState(initialTools);
  useInputModeStore.setState(initialInput);
  vi.unstubAllGlobals();
  inkSigil.resetInkSigilSession();
  vi.restoreAllMocks();
});

describe('useCanvasPointerRouter live input policy', () => {
  it('preserves reading across Select and Ink tools in Pen mode but clears it for other placement tools', () => {
    useToolStore.setState({ inputModePreference: 'pen' });
    act(() => root.render(<Harness inputMode="pen" />));
    useGesturePreviewStore.setState({ noteReadingNodeId: 'note' });
    act(() =>
      root.render(<Harness inputMode="pen" explicitToolActive inkToolActive />),
    );
    expect(useGesturePreviewStore.getState().noteReadingNodeId).toBe('note');
    act(() => root.render(<Harness inputMode="pen" />));
    expect(useGesturePreviewStore.getState().noteReadingNodeId).toBe('note');
    act(() =>
      root.render(<Harness inputMode="pen" explicitToolActive inkToolActive />),
    );
    act(() => root.render(<Harness inputMode="pen" explicitToolActive />));
    expect(useGesturePreviewStore.getState().noteReadingNodeId).toBeNull();
  });

  it.each(['finger', 'mouse'] as const)(
    'clears Ink-tool reading when the input preference changes to %s',
    (inputMode) => {
      useToolStore.setState({ inputModePreference: 'pen' });
      act(() =>
        root.render(
          <Harness inputMode="pen" explicitToolActive inkToolActive />,
        ),
      );
      useGesturePreviewStore.setState({ noteReadingNodeId: 'note' });
      useToolStore.setState({ inputModePreference: inputMode });
      act(() =>
        root.render(
          <Harness inputMode={inputMode} explicitToolActive inkToolActive />,
        ),
      );
      expect(useGesturePreviewStore.getState().noteReadingNodeId).toBeNull();
    },
  );
  function openPending() {
    inkSigil.useInkSigilStore.setState({
      pending: {
        canvasId: 'space',
        strokeIds: ['s0', 's1', 's2', 's3'],
        fingerprint: '1234567890abcdef',
      },
    });
  }

  function pointer(target: Element, type: string, x = 120) {
    const event = new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerType: 'mouse',
      pointerId: 1,
      isPrimary: true,
      button: 0,
      clientX: x,
      clientY: 140,
    });
    act(() => target.dispatchEvent(event));
    return event;
  }

  it.each([
    '<button><span>Play</span></button>',
    '<input type="range">',
    '<textarea></textarea>',
    '<select><option>Choice</option></select>',
    '<div contenteditable="true"><span>Editor</span></div>',
    '<div role="slider"><span>Seek</span></div>',
  ])(
    'keeps native controls and editors usable while a binding is pending: %s',
    (html) => {
      useToolStore.setState({ inputModePreference: 'mouse' });
      openPending();
      const pending = inkSigil.useInkSigilStore.getState().pending;
      const resolve = vi
        .spyOn(inkSigil, 'resolvePendingInkSigilTap')
        .mockReturnValue(true);
      act(() => root.render(<Harness inputMode="mouse" />));
      const node = document.createElement('div');
      node.className = 'react-flow__node react-flow__node-audio';
      node.innerHTML = html;
      wrapper.append(node);
      const target = node.querySelector('span') ?? node.firstElementChild;
      if (!target) throw new Error('Missing native control fixture');
      const click = vi.fn();
      target.addEventListener('click', click);
      expect(pointer(target, 'pointerdown').defaultPrevented).toBe(false);
      pointer(target, 'pointerup');
      target.dispatchEvent(
        new MouseEvent('click', { bubbles: true, detail: 1 }),
      );
      expect(click).toHaveBeenCalledOnce();
      expect(resolve).not.toHaveBeenCalled();
      expect(inkSigil.useInkSigilStore.getState().pending).toBe(pending);
    },
  );

  it('still binds a Web link surface instead of following the link', () => {
    useToolStore.setState({ inputModePreference: 'mouse' });
    openPending();
    const resolve = vi
      .spyOn(inkSigil, 'resolvePendingInkSigilTap')
      .mockReturnValue(true);
    act(() => root.render(<Harness inputMode="mouse" />));
    const link = document.createElement('a');
    link.href = '/resource';
    wrapper.append(link);
    const click = vi.fn();
    link.addEventListener('click', click);
    pointer(link, 'pointerdown');
    pointer(link, 'pointerup');
    link.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }),
    );
    expect(resolve).toHaveBeenCalledOnce();
    expect(click).not.toHaveBeenCalled();
  });

  it.each(['pointerup', 'pointercancel', 'lostpointercapture'])(
    'cleans up capture on %s and accepts the next press with the same pointer ID',
    (completion) => {
      useToolStore.setState({ inputModePreference: 'mouse' });
      openPending();
      const resolve = vi
        .spyOn(inkSigil, 'resolvePendingInkSigilTap')
        .mockReturnValue(true);
      act(() => root.render(<Harness inputMode="mouse" />));
      const node = document.createElement('div');
      wrapper.append(node);
      pointer(node, 'pointerdown');
      expect(wrapper.setPointerCapture).toHaveBeenCalledWith(1);
      expect(wrapper.hasPointerCapture(1)).toBe(true);
      // Captured release is delivered to the wrapper even outside its bounds.
      pointer(wrapper, completion, 2000);
      expect(wrapper.releasePointerCapture).toHaveBeenCalledWith(1);
      expect(inkSigil.useInkSigilStore.getState().pending).toBeNull();
      expect(resolve).not.toHaveBeenCalled();
      openPending();
      pointer(node, 'pointerdown');
      pointer(wrapper, 'pointerup');
      expect(wrapper.setPointerCapture).toHaveBeenCalledTimes(2);
      expect(resolve).toHaveBeenCalledExactlyOnceWith(120, 140);
      expect(wrapper.hasPointerCapture(1)).toBe(false);
    },
  );

  it('releases pending binding capture on router teardown', () => {
    useToolStore.setState({ inputModePreference: 'mouse' });
    openPending();
    act(() => root.render(<Harness inputMode="mouse" />));
    pointer(wrapper, 'pointerdown');
    expect(wrapper.hasPointerCapture(1)).toBe(true);
    act(() => root.render(null));
    expect(wrapper.hasPointerCapture(1)).toBe(false);
    expect(inkSigil.useInkSigilStore.getState().pending).toBeNull();
  });

  it.each([
    ['mouse', 'mouse'],
    ['pen', 'pen'],
    ['touch', 'finger'],
  ] as const)(
    'resolves a pending Select-mode binding with %s without native selection',
    (pointerType, inputMode) => {
      useToolStore.setState({ inputModePreference: inputMode });
      inkSigil.useInkSigilStore.setState({
        pending: {
          canvasId: 'space',
          strokeIds: ['s0', 's1', 's2', 's3'],
          fingerprint: '1234567890abcdef',
        },
      });
      const resolve = vi
        .spyOn(inkSigil, 'resolvePendingInkSigilTap')
        .mockReturnValue(true);
      act(() => root.render(<Harness inputMode={inputMode} />));
      const node = document.createElement('div');
      node.className = 'react-flow__node';
      wrapper.append(node);
      const nativeDown = vi.fn();
      const nativeClick = vi.fn();
      node.addEventListener('pointerdown', nativeDown);
      node.addEventListener('click', nativeClick);
      for (const type of ['pointerdown', 'pointerup']) {
        act(() =>
          node.dispatchEvent(
            new PointerEvent(type, {
              bubbles: true,
              cancelable: true,
              pointerType,
              pointerId: 1,
              isPrimary: true,
              button: 0,
              clientX: 120,
              clientY: 140,
            }),
          ),
        );
      }
      node.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }),
      );
      expect(resolve).toHaveBeenCalledExactlyOnceWith(120, 140);
      expect(nativeDown).not.toHaveBeenCalled();
      expect(nativeClick).not.toHaveBeenCalled();
    },
  );

  it.each(['pointermove', 'pointercancel'])(
    'cancels Select-mode binding on %s rather than binding after a drag or cancellation',
    (eventType) => {
      useToolStore.setState({ inputModePreference: 'mouse' });
      inkSigil.useInkSigilStore.setState({
        pending: {
          canvasId: 'space',
          strokeIds: ['s0', 's1', 's2', 's3'],
          fingerprint: '1234567890abcdef',
        },
      });
      const resolve = vi
        .spyOn(inkSigil, 'resolvePendingInkSigilTap')
        .mockReturnValue(true);
      act(() => root.render(<Harness inputMode="mouse" />));
      for (const [type, x] of [
        ['pointerdown', 0],
        [eventType, 30],
        ['pointerup', 0],
      ] as const) {
        act(() =>
          wrapper.dispatchEvent(
            new PointerEvent(type, {
              bubbles: true,
              cancelable: true,
              pointerType: 'mouse',
              pointerId: 1,
              isPrimary: true,
              button: 0,
              clientX: x,
            }),
          ),
        );
      }
      expect(resolve).not.toHaveBeenCalled();
      expect(inkSigil.useInkSigilStore.getState().pending).toBeNull();
    },
  );

  it.each(['auto', 'finger', 'mouse'] satisfies InputModePreference[])(
    'resolves the first pen contact before gating and claiming under %s',
    (preference) => {
      useToolStore.setState({ inputModePreference: preference });
      act(() =>
        root.render(
          <Harness inputMode={preference === 'mouse' ? 'mouse' : 'finger'} />,
        ),
      );
      const event = new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        pointerType: 'pen',
        pointerId: 1,
        isPrimary: true,
        button: 0,
      });
      act(() => wrapper.dispatchEvent(event));

      expect(useToolStore.getState().penObserved).toBe(true);
      expect(useToolStore.getState().inputModePreference).toBe(preference);
      if (preference === 'auto') {
        expect(event.defaultPrevented).toBe(false);
        expect(onDown).toHaveBeenCalledExactlyOnceWith(event, 'pen');
      } else {
        expect(event.defaultPrevented).toBe(true);
        expect(onDown).not.toHaveBeenCalled();
      }
    },
  );
});
