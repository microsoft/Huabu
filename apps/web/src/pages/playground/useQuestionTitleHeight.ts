// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useLayoutEffect, useRef, useState } from 'react';

/** Measure authored wrapping, excluding the viewport transform. */
export function useQuestionTitleHeight(
  title: string,
  width: number,
  fontSize: number,
) {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    let active = true;
    const measure = () => {
      if (active && element.getClientRects().length > 0) {
        setHeight(Number.parseFloat(getComputedStyle(element).height) || 0);
      }
    };
    measure();
    // As with the header probes, wrapping and font changes resize this element.
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    void document.fonts?.ready.then(measure);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [title, width, fontSize]);
  return { ref, height };
}
