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
