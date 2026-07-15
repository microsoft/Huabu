import { useEffect, useState } from 'react';

import { getAgentTeamSettings } from '@/api/agent-team';

import type { AgentTeamSettingsState } from '@sediment/shared';

export function useAgentTeamSettings() {
  const [state, setState] = useState<AgentTeamSettingsState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

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

  return {
    state,
    loadError,
  };
}
