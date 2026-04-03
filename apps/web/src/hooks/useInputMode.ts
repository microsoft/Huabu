import { useEffect } from 'react';
import { create } from 'zustand';

export type InputMode = 'mouse' | 'touch' | 'pen';

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

/**
 * Call once near the app root to install the global `pointerdown` listener.
 * Safe to call multiple times — the listener is idempotent.
 */
export function useInputModeListener(): void {
  useEffect(() => {
    const handler = (e: PointerEvent) => {
      const next = e.pointerType as InputMode;
      if (useInputModeStore.getState().mode !== next) {
        useInputModeStore.setState({ mode: next });
      }
    };
    window.addEventListener('pointerdown', handler, true);
    return () => window.removeEventListener('pointerdown', handler, true);
  }, []);
}
