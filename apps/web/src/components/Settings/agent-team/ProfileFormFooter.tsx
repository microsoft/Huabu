// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { createContext, useContext } from 'react';
import { createPortal } from 'react-dom';

import type { ReactNode } from 'react';

const ProfileFormFooterTargetContext = createContext<HTMLElement | null>(null);

export function ProfileFormFooterTarget({
  target,
  children,
}: {
  target: HTMLElement | null;
  children: ReactNode;
}) {
  return (
    <ProfileFormFooterTargetContext.Provider value={target}>
      {children}
    </ProfileFormFooterTargetContext.Provider>
  );
}

export function ProfileFormFooter({ children }: { children: ReactNode }) {
  const target = useContext(ProfileFormFooterTargetContext);
  const footer = <div className="flex justify-end gap-2">{children}</div>;

  return target ? createPortal(footer, target) : footer;
}
