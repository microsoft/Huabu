// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { create } from 'zustand';

import type { IdentityResponse } from '@huabu/shared';

/** The signed-in caller, set once the sign-in gate admits the app. */
export const useIdentityStore = create<{
  identity: IdentityResponse | null;
  setIdentity: (identity: IdentityResponse | null) => void;
}>()((set) => ({
  identity: null,
  setIdentity: (identity) => set({ identity }),
}));

/**
 * Whether the caller manages this deployment: its readiness and redeployment.
 * In Bubble that is the administrator; elsewhere it is the one caller, signed
 * in or not, as it always was.
 */
export function useManagesDeployment(): boolean {
  return useIdentityStore(
    (s) => s.identity?.owner === true || s.identity?.provider !== 'bubble',
  );
}
