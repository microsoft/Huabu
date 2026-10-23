// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useCallback, type ReactNode } from 'react';
import { create } from 'zustand';

const useHighlightHosts = create(() => new Map<string, HTMLDivElement>());

export function useInkSigilHighlightHost(nodeId: string) {
  return useHighlightHosts((hosts) => hosts.get(nodeId));
}

export function InkSigilHighlightHost({
  nodeId,
  children,
}: {
  nodeId: string;
  children: ReactNode;
}) {
  const register = useCallback(
    (element: HTMLDivElement | null) => {
      if (!element) return;
      useHighlightHosts.setState(
        (hosts) => new Map(hosts).set(nodeId, element),
        true,
      );
      return () => {
        useHighlightHosts.setState((hosts) => {
          if (hosts.get(nodeId) !== element) return hosts;
          const next = new Map(hosts);
          next.delete(nodeId);
          return next;
        }, true);
      };
    },
    [nodeId],
  );
  return (
    <div className="relative h-full w-full">
      <div
        ref={register}
        data-ink-sigil-highlights={nodeId}
        inert
        className="pointer-events-none absolute inset-0"
      />
      {children}
    </div>
  );
}
