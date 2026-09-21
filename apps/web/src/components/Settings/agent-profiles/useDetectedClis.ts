// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { listAcpAgentClis } from '@/api/acp';
import { toast } from '@/components/Common/Toast';

import type { AcpAgentCliInfo } from '@huabu/shared';

/** Reads the daemon's catalogue for Settings without a browser discovery cache. */
export function useDetectedClis(
  enabled = true,
  profileId?: string,
): {
  detectedClis: AcpAgentCliInfo[];
  loaded: boolean;
} {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<{
    profileId?: string;
    detectedClis: AcpAgentCliInfo[];
    loaded: boolean;
  }>({ profileId, detectedClis: [], loaded: false });

  useEffect(() => {
    if (!enabled) return;
    let generation = 0;
    const load = async () => {
      const current = ++generation;
      setSnapshot({ profileId, loaded: false, detectedClis: [] });
      try {
        const response = await listAcpAgentClis(profileId);
        if (current === generation) {
          setSnapshot({
            profileId,
            loaded: true,
            detectedClis: response.agents,
          });
        }
      } catch (error) {
        if (current === generation) {
          setSnapshot({ profileId, loaded: true, detectedClis: [] });
          toast(
            error instanceof Error
              ? error.message
              : t('settings.agentDetectionFailed'),
            { tone: 'danger' },
          );
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
  }, [enabled, profileId, t]);

  return snapshot.profileId === profileId
    ? { detectedClis: snapshot.detectedClis, loaded: snapshot.loaded }
    : { detectedClis: [], loaded: false };
}
