import { useCallback, useEffect, useRef } from 'react';

export { TEXT_INPUT_CLASS } from '@/components/Common/Input';

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
): (arg: TArg) => void {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fnRef = useRef(fn);
  useEffect(() => {
    fnRef.current = fn;
  }, [fn]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return useCallback(
    (arg: TArg) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => fnRef.current(arg), delay);
    },
    [delay],
  );
}
