// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

function Harness({ inputMode }: { inputMode: EffectiveInputMode }) {
  useCanvasPointerRouter(
    { current: wrapper },
    { current: {} as ReactFlowInstance },
    {
      inputMode,
      explicitToolActive: false,
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
  useToolStore.setState({ inputModePreference: 'auto', penObserved: false });
  useInputModeStore.setState({ mode: 'touch' });
  container = document.createElement('div');
  wrapper = document.createElement('div');
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
});

describe('useCanvasPointerRouter live input policy', () => {
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
