// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { create } from 'zustand';

import { getDeploymentReadiness } from '@/api/deployment';

import type { DeploymentReadinessResponse } from '@huabu/shared';

interface DeploymentReadinessState {
  readiness: DeploymentReadinessResponse | null;
  loading: boolean;
  error: string | null;
  load: () => Promise<void>;
}

export const useDeploymentReadinessStore = create<DeploymentReadinessState>()(
  (set) => ({
    readiness: null,
    loading: false,
    error: null,
    load: async () => {
      set({ loading: true, error: null });
      try {
        const readiness = await getDeploymentReadiness();
        set({ readiness, loading: false });
      } catch (error) {
        set({
          readiness: null,
          loading: false,
          error:
            error instanceof Error
              ? error.message
              : 'Failed to load deployment readiness',
        });
      }
    },
  }),
);
