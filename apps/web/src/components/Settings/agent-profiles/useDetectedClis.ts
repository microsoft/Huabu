// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { listAcpAgentClis } from '@/api/acp';
import { toast } from '@/components/Common/Toast';

import type { AcpAgentCliInfo, AcpAgentCliQuery } from '@huabu/shared';

/** Reads the daemon's catalogue for Settings without a browser discovery cache. */
export function useDetectedClis(
  enabled = true,
  target: AcpAgentCliQuery,
  connectionKey = '',
): {
  detectedClis: AcpAgentCliInfo[];
  loaded: boolean;
  error: string | null;
  recheck: () => void;
} {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<{
    key: string;
    detectedClis: AcpAgentCliInfo[];
    loaded: boolean;
    error: string | null;
  }>({ key: '', detectedClis: [], loaded: false, error: null });
  const [revision, setRevision] = useState(0);
  const recheck = useCallback(() => setRevision((value) => value + 1), []);
  const { agentletId, profileId } = target;
  const key = JSON.stringify([agentletId, profileId, connectionKey, revision]);

  useEffect(() => {
    if (!enabled) return;
    let generation = 0;
    const load = async () => {
      const current = ++generation;
      setSnapshot({ key, loaded: false, detectedClis: [], error: null });
      try {
        const response = await listAcpAgentClis(
          profileId === undefined ? { agentletId } : { profileId },
        );
        if (current === generation) {
          setSnapshot({
            key,
            loaded: true,
            detectedClis: response.agents,
            error: null,
          });
        }
      } catch (error) {
        if (current === generation) {
          const message =
            error instanceof Error
              ? error.message
              : t('settings.agentDetectionFailed');
          setSnapshot({ key, loaded: true, detectedClis: [], error: message });
          toast(message, { tone: 'danger' });
        }
      }
    };
    void load();
    const handler = () => void load();
    window.addEventListener('workspace-changed', handler);
    return () => {
      generation++;
      window.removeEventListener('workspace-changed', handler);
    };
  }, [enabled, key, agentletId, profileId, t]);

  return snapshot.key === key
    ? {
        detectedClis: snapshot.detectedClis,
        loaded: snapshot.loaded,
        error: snapshot.error,
        recheck,
      }
    : { detectedClis: [], loaded: false, error: null, recheck };
}
