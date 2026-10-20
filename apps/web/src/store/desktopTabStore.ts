// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { create } from 'zustand';

export const useDesktopTabStore = create<{ isActive: boolean }>()(() => ({
  isActive: false,
}));
