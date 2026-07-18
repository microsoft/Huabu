import { useEffect, useState } from 'react';
import { create } from 'zustand';

import {
  resolveDeviceMode,
  resolveTouchInteractionMode,
  useToolStore,
  type EffectiveDeviceMode,
  type EffectiveTouchInteractionMode,
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

/** Returns `true` when the last interaction was touch. */
export function useIsTouch(): boolean {
  return useInputModeStore((s) => s.mode === 'touch');
}

export function useIsNotMouse(): boolean {
  return useInputModeStore((s) => s.mode !== 'mouse');
}

function detectTouchCapability(): boolean {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') {
    return false;
  }
  return (
    navigator.maxTouchPoints > 0 ||
    window.matchMedia('(any-pointer: coarse)').matches
  );
}

export function useEffectiveDeviceMode(): EffectiveDeviceMode {
  const preference = useToolStore((state) => state.deviceModePreference);
  const inputMode = useInputMode();
  const [touchCapable, setTouchCapable] = useState(detectTouchCapability);

  useEffect(() => {
    const query = window.matchMedia('(any-pointer: coarse)');
    const update = () => setTouchCapable(detectTouchCapability());
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  return resolveDeviceMode(
    preference,
    touchCapable || inputMode === 'touch' || inputMode === 'pen',
  );
}

export function useEffectiveTouchInteractionMode(): EffectiveTouchInteractionMode {
  const preference = useToolStore((state) => state.touchInteractionPreference);
  const penObserved = useToolStore((state) => state.penObserved);
  return resolveTouchInteractionMode(preference, penObserved);
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
