import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  getAgentTeamSettings,
  subscribeAgentTeamSettings,
} from '@/api/agent-team';

import type { AgentTeamSettingsState } from '@sediment/shared';

export function useAgentTeamSettings() {
  const { t } = useTranslation('agentTeam');
  const [state, setState] = useState<AgentTeamSettingsState | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const streamSnapshotVersion = useRef(0);

  useEffect(() => {
    let active = true;
    let unsubscribe = () => {};

    const initialize = async () => {
      try {
        const snapshot = await getAgentTeamSettings();
        if (active) setState(snapshot);
      } catch (error) {
        if (active) {
          setStreamError(
            error instanceof Error ? error.message : t('loadFailed'),
          );
        }
      }
      if (!active) return;
      unsubscribe = subscribeAgentTeamSettings(
        (snapshot) => {
          streamSnapshotVersion.current += 1;
          setState(snapshot);
          setStreamError(null);
        },
        (error) => setStreamError(error.message),
      );
    };

    void initialize();
    return () => {
      active = false;
      unsubscribe();
    };
  }, [t]);

  const mutate = useCallback(
    async (
      action: string,
      operation: () => Promise<AgentTeamSettingsState>,
    ): Promise<void> => {
      setPendingAction(action);
      const startingStreamVersion = streamSnapshotVersion.current;
      try {
        const snapshot = await operation();
        if (streamSnapshotVersion.current === startingStreamVersion) {
          setState(snapshot);
        }
        setStreamError(null);
      } finally {
        setPendingAction(null);
      }
    },
    [],
  );

  return {
    state,
    streamError,
    pendingAction,
    mutate,
  };
}
