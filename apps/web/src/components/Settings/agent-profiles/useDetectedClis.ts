// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { listAcpAgentClis } from '@/api/acp';
import { toast } from '@/components/Common/Toast';

import type { AcpAgentCliInfo, AcpAgentCliQuery } from '@huabu/shared';

/** Reads the daemon's catalogue for Settings without a browser discovery cache. */
export function useDetectedClis(
  enabled = true,
  target: AcpAgentCliQuery,
): {
  detectedClis: AcpAgentCliInfo[];
  loaded: boolean;
} {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<{
    key: string;
    detectedClis: AcpAgentCliInfo[];
    loaded: boolean;
  }>({ key: JSON.stringify(target), detectedClis: [], loaded: false });
  const key = JSON.stringify(target);

  useEffect(() => {
    if (!enabled) return;
    let generation = 0;
    const load = async () => {
      const current = ++generation;
      setSnapshot({ key, loaded: false, detectedClis: [] });
      try {
        const response = await listAcpAgentClis(target);
        if (current === generation) {
          setSnapshot({
            key,
            loaded: true,
            detectedClis: response.agents,
          });
        }
      } catch (error) {
        if (current === generation) {
          setSnapshot({ key, loaded: true, detectedClis: [] });
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
  }, [enabled, key, t]);

  return snapshot.key === key
    ? { detectedClis: snapshot.detectedClis, loaded: snapshot.loaded }
    : { detectedClis: [], loaded: false };
}
