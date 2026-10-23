// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  createContext,
  useContext,
  useEffect,
  useCallback,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import type { CanvasSearchSource } from '@huabu/shared';

export type PreviewSearchAdapter = {
  query: string;
  matchCount: number;
  isSearching: boolean;
  canNavigate: boolean;
  failed?: boolean;
  resolveSourceMatch?: (source: CanvasSearchSource) => Promise<number | null>;
  getMatchRange?: (matchIndex: number) => Range | null;
  navigateToMatch: (
    matchIndex: number,
    onResult: (visible: boolean, range?: Range) => void,
  ) => (() => void) | void;
};

type PreviewSearchAdapterContextValue = {
  adapter: (PreviewSearchAdapter & { isCurrent: () => boolean }) | null;
  register: (adapter: PreviewSearchAdapter | null) => void;
};

const PreviewSearchAdapterContext =
  createContext<PreviewSearchAdapterContextValue | null>(null);

export function PreviewSearchAdapterProvider({
  children,
}: {
  children: ReactNode;
}): React.JSX.Element {
  const [adapter, setAdapter] =
    useState<PreviewSearchAdapterContextValue['adapter']>(null);
  const current = useRef<symbol | null>(null);
  const register = useCallback((next: PreviewSearchAdapter | null) => {
    const registration = next ? Symbol('preview-search-adapter') : null;
    current.current = registration;
    setAdapter(
      next
        ? { ...next, isCurrent: () => current.current === registration }
        : null,
    );
  }, []);
  return (
    <PreviewSearchAdapterContext.Provider value={{ adapter, register }}>
      {children}
    </PreviewSearchAdapterContext.Provider>
  );
}

export function usePreviewSearchAdapter(): PreviewSearchAdapterContextValue['adapter'] {
  return useContext(PreviewSearchAdapterContext)?.adapter ?? null;
}

export function useRegisterPreviewSearchAdapter(
  adapter: PreviewSearchAdapter | null,
): void {
  const register = useContext(PreviewSearchAdapterContext)?.register;
  useEffect(() => {
    if (!register) return;
    register(adapter);
    return () => register(null);
  }, [adapter, register]);
}
