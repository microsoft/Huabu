// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useLayoutEffect, useRef, useState } from 'react';

import type { SpaceCardAgent } from '@huabu/shared';

export function fitSpaceAgentCount(
  width: number,
  entries: readonly number[],
  overflowWidths: readonly number[],
  gap: number,
): number {
  let used = 0;
  let count = 0;
  for (let index = 0; index < entries.length; index++) {
    used += entries[index] + (index ? gap : 0);
    if (used > width) break;
    const remaining = entries.length - index - 1;
    const reserved = remaining
      ? gap + overflowWidths[String(remaining).length - 1]
      : 0;
    if (used + reserved <= width) count = index + 1;
  }
  return count;
}

export function useSpaceAgentFit(
  sessions: readonly SpaceCardAgent[],
  language: string,
  failed: boolean,
) {
  const rowRef = useRef<HTMLDivElement>(null);
  const probesRef = useRef<HTMLDivElement>(null);
  const [visibleCount, setVisibleCount] = useState(0);
  useLayoutEffect(() => {
    const row = rowRef.current;
    const probes = probesRef.current;
    if (!row || !probes) return;
    let active = true;
    const statusProbes = Array.from(
      probes.querySelectorAll<HTMLElement>('[data-agent-fit-status]'),
    );
    const overflowProbes = Array.from(
      probes.querySelectorAll<HTMLElement>('[data-agent-fit-digits]'),
    );
    const measure = () => {
      if (!active || row.getClientRects().length === 0) return;
      // Computed widths remain in canvas units when the viewport is zoomed.
      const widths = new Map(
        statusProbes.map((element) => [
          element.dataset.agentFitStatus,
          Number.parseFloat(getComputedStyle(element).width),
        ]),
      );
      const style = getComputedStyle(row);
      const entryWidths: number[] = [];
      for (const entry of sessions) {
        const width = widths.get(entry.status);
        if (width === undefined) return;
        entryWidths.push(width);
      }
      const next = fitSpaceAgentCount(
        Number.parseFloat(style.width),
        entryWidths,
        overflowProbes.map((element) =>
          Number.parseFloat(getComputedStyle(element).width),
        ),
        Number.parseFloat(style.columnGap),
      );
      setVisibleCount((previous) => (previous === next ? previous : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    [row, ...statusProbes, ...overflowProbes].forEach((element) =>
      observer.observe(element),
    );
    void document.fonts?.ready.then(measure);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [sessions, language, failed]);
  return { rowRef, probesRef, visibleCount };
}
