import { useEffect, useState } from 'react';
import { create } from 'zustand';

import {
  resolveInputMode,
  useToolStore,
  type EffectiveInputMode,
} from '@/store/toolStore';

export type InputMode = 'mouse' | 'touch' | 'pen';

const INPUT_MODES: ReadonlySet<InputMode> = new Set(['mouse', 'touch', 'pen']);

interface InputModeState {
  mode: InputMode;
}

/**
 * Tracks the most recent pointer input type (mouse / touch / pen).
 * Updated on every `pointerdown` in the capture phase so the value
 * reflects the *current* interaction, enabling seamless switching on
 * hybrid devices (e.g. Surface).
 */
export const useInputModeStore = create<InputModeState>(() => ({
  mode: 'mouse',
}));

/** Returns the current input mode reactively. */
export function useInputMode(): InputMode {
  return useInputModeStore((s) => s.mode);
}

/**
 * Reactive "am I currently using touch or pen?" signal that drives UI density
 * and pointer-appropriate affordances (handle sizes, shortcut hints, on-canvas
 * delete buttons, available tools, pan vs box-select, node draggability).
 *
 * It follows the *most recent* pointer so hybrid devices (e.g. Surface) switch
 * between desktop and touch experiences the moment the user changes pointer.
 * Mouse mode pins this to `false` because it ignores touchscreen and pen input
 * entirely.
 */
export function useIsNotMouse(): boolean {
  const effective = useEffectiveInputMode();
  const lastPointer = useInputMode();
  if (effective === 'mouse') return false;
  return lastPointer !== 'mouse';
}

export function detectTouchCapability(): boolean {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') {
    return false;
  }
  return (
    navigator.maxTouchPoints > 0 ||
    window.matchMedia('(any-pointer: coarse)').matches
  );
}

export function useEffectiveInputMode(): EffectiveInputMode {
  const preference = useToolStore((state) => state.inputModePreference);
  const penObserved = useToolStore((state) => state.penObserved);
  const inputMode = useInputMode();
  const [touchCapable, setTouchCapable] = useState(detectTouchCapability);

  useEffect(() => {
    const query = window.matchMedia('(any-pointer: coarse)');
    const update = () => setTouchCapable(detectTouchCapability());
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  return resolveInputMode(
    preference,
    touchCapable || inputMode === 'touch' || inputMode === 'pen',
    penObserved,
  );
}
/**
 * Call once near the app root to install the global `pointerdown` listener.
 * Safe to call multiple times — the listener is idempotent.
 */
export function useInputModeListener(): void {
  useEffect(() => {
    const handler = (e: PointerEvent) => {
      const next = INPUT_MODES.has(e.pointerType as InputMode)
        ? (e.pointerType as InputMode)
        : 'mouse';
      if (useInputModeStore.getState().mode !== next) {
        useInputModeStore.setState({ mode: next });
      }
      if (e.isTrusted && next === 'pen') {
        useToolStore.getState().observePen();
      }
    };
    window.addEventListener('pointerdown', handler, true);
    return () => window.removeEventListener('pointerdown', handler, true);
  }, []);
}
