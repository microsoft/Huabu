// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';

export type PreviewSearchAdapter = {
  matchCount: number;
  isSearching: boolean;
  canNavigate: boolean;
  navigateToMatch: (matchIndex: number) => void;
};

type PreviewSearchAdapterContextValue = {
  adapter: PreviewSearchAdapter | null;
  register: (adapter: PreviewSearchAdapter | null) => void;
};

const PreviewSearchAdapterContext =
  createContext<PreviewSearchAdapterContextValue | null>(null);

export function PreviewSearchAdapterProvider({
  children,
}: {
  children: ReactNode;
}): React.JSX.Element {
  const [adapter, register] = useState<PreviewSearchAdapter | null>(null);
  return (
    <PreviewSearchAdapterContext.Provider value={{ adapter, register }}>
      {children}
    </PreviewSearchAdapterContext.Provider>
  );
}

export function usePreviewSearchAdapter(): PreviewSearchAdapter | null {
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
