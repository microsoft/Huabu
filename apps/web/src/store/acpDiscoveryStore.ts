// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { create } from 'zustand';

import { listAcpAgentClis, refreshAcpAgentClis } from '@/api/acp';

import type { AcpAgentMachineDiscovery } from '@huabu/shared';

let inFlight: Promise<void> | null = null;

interface AcpDiscoveryState {
  machines: AcpAgentMachineDiscovery[];
  loaded: boolean;
  loading: boolean;
  error: Error | null;
  init: () => Promise<void>;
  refresh: (agentletId?: string) => Promise<void>;
}

export const useAcpDiscoveryStore = create<AcpDiscoveryState>()((set, get) => ({
  machines: [],
  loaded: false,
  loading: false,
  error: null,
  init: async () => {
    if (get().loaded || inFlight) return inFlight ?? Promise.resolve();
    const request = (async () => {
      set({ loading: true });
      try {
        const response = await listAcpAgentClis();
        set({
          machines: response.machines,
          loaded: true,
          loading: false,
          error: null,
        });
      } catch (error) {
        set({
          loading: false,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    })();
    inFlight = request;
    await request.finally(() => {
      if (inFlight === request) inFlight = null;
    });
  },
  refresh: async (agentletId) => {
    if (inFlight) return inFlight;
    const request = (async () => {
      set({ loading: true });
      try {
        const response = await refreshAcpAgentClis(
          agentletId ? { agentletId } : {},
        );
        set({
          machines: response.machines,
          loaded: true,
          loading: false,
          error: null,
        });
      } catch (error) {
        set({
          loading: false,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    })();
    inFlight = request;
    await request.finally(() => {
      if (inFlight === request) inFlight = null;
    });
  },
}));
