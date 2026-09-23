// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useLayoutEffect, useRef, useState } from 'react';

/** Reserve identity and status first; never infer text fit from a zoom threshold. */
export function resolveQuestionHeaderFit({
  width,
  avatar,
  gap,
  alias,
  label,
  icon,
}: {
  width: number;
  avatar: number;
  gap: number;
  alias: number;
  label: number;
  icon: number;
}) {
  const available = Math.max(0, width - avatar - gap);
  const fullStatus = label + (icon > 0 ? icon + gap / 2 : 0);
  const statusText = label > 0 && fullStatus <= available;
  const status = statusText || (icon > 0 && icon <= available);
  const statusWidth = statusText ? fullStatus : status ? icon : 0;
  return {
    status,
    statusText,
    alias: alias > 0 && alias + (status ? gap + statusWidth : 0) <= available,
  };
}

/** Local fit policy; follows the existing card ResizeObserver/font remeasurement pattern. */
export function useQuestionHeaderFit(
  avatar: number,
  gap: number,
  icon: number,
  alias: string,
  label: string,
) {
  const headerRef = useRef<HTMLDivElement>(null);
  const aliasRef = useRef<HTMLSpanElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const [fit, setFit] = useState({
    status: true,
    statusText: true,
    alias: true,
  });
  useLayoutEffect(() => {
    const header = headerRef.current;
    const aliasProbe = aliasRef.current;
    const labelProbe = labelRef.current;
    if (!header || !aliasProbe || !labelProbe) return;
    let active = true;
    const measure = () => {
      if (!active || header.getClientRects().length === 0) return;
      const next = resolveQuestionHeaderFit({
        width: Number.parseFloat(getComputedStyle(header).width) || 0,
        avatar,
        gap,
        icon,
        alias: Number.parseFloat(getComputedStyle(aliasProbe).width) || 0,
        label: Number.parseFloat(getComputedStyle(labelProbe).width) || 0,
      });
      setFit((previous) =>
        previous.alias === next.alias &&
        previous.status === next.status &&
        previous.statusText === next.statusText
          ? previous
          : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    [header, aliasProbe, labelProbe].forEach((element) =>
      observer.observe(element),
    );
    const fonts = document.fonts;
    // Intrinsic probes also resize when fonts change, including later font loads.
    void fonts?.ready.then(measure);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [avatar, gap, icon, alias, label]);
  return { fit, headerRef, aliasRef, labelRef };
}
