import { useCallback, useEffect, useState } from 'react';

import { getAgentTeamSettings } from '@/api/agent-team';

import type { AgentTeamSettingsState } from '@sediment/shared';

export function useAgentTeamSettings() {
  const [state, setState] = useState<AgentTeamSettingsState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void getAgentTeamSettings()
      .then((snapshot) => {
        if (!active) return;
        setState(snapshot);
        setLoadError(null);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setLoadError(
          error instanceof Error
            ? error.message
            : 'Failed to load Agent Team Settings',
        );
      });
    return () => {
      active = false;
    };
  }, []);

  const mutate = useCallback(
    async (
      action: string,
      operation: () => Promise<AgentTeamSettingsState>,
    ): Promise<void> => {
      setPendingAction(action);
      try {
        const snapshot = await operation();
        setState(snapshot);
        setLoadError(null);
      } finally {
        setPendingAction(null);
      }
    },
    [],
  );

  return {
    state,
    loadError,
    pendingAction,
    mutate,
  };
}
