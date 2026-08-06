// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useCallback, useEffect, useRef } from 'react';

export interface DebouncedSave<TArg> {
  (arg: TArg): void;
  flush: () => void;
}

/**
 * Debounce a save callback so the caller can invoke it on every keystroke
 * but the network round-trip only fires after the user pauses typing for
 * {@link delay} ms. The callback is replaced lazily via a ref so each save
 * sees the latest closure (current store state, current selection, …)
 * without re-allocating the returned function.
 */
export function useDebouncedSave<TArg>(
  fn: (arg: TArg) => void,
  delay = 600,
): DebouncedSave<TArg> {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingArg = useRef<TArg | undefined>(undefined);
  const fnRef = useRef(fn);
  useEffect(() => {
    fnRef.current = fn;
  }, [fn]);
  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (pendingArg.current === undefined) return;
    const arg = pendingArg.current;
    pendingArg.current = undefined;
    fnRef.current(arg);
  }, []);
  useEffect(() => () => flush(), [flush]);
  const schedule = useCallback(
    (arg: TArg) => {
      if (timer.current) clearTimeout(timer.current);
      pendingArg.current = arg;
      timer.current = setTimeout(flush, delay);
    },
    [delay, flush],
  ) as DebouncedSave<TArg>;
  schedule.flush = flush;
  return schedule;
}
