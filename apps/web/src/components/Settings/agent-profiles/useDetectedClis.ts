// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { listAcpAgentClis } from '@/api/acp';
import { toast } from '@/components/Common/Toast';

import type { AcpAgentCliInfo } from '@huabu/shared';

/** Reads the daemon's catalogue for Settings without a browser discovery cache. */
export function useDetectedClis(enabled = true): {
  detectedClis: AcpAgentCliInfo[];
  loaded: boolean;
} {
  const { t } = useTranslation();
  const [detectedClis, setDetectedClis] = useState<AcpAgentCliInfo[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let generation = 0;
    const load = async () => {
      const current = ++generation;
      setLoaded(false);
      setDetectedClis([]);
      try {
        const response = await listAcpAgentClis();
        if (current === generation) setDetectedClis(response.agents);
      } catch (error) {
        if (current === generation) {
          toast(
            error instanceof Error
              ? error.message
              : t('settings.agentDetectionFailed'),
            { tone: 'danger' },
          );
        }
      } finally {
        if (current === generation) setLoaded(true);
      }
    };
    void load();
    const handler = () => void load();
    window.addEventListener('workspace-changed', handler);
    return () => {
      generation++;
      window.removeEventListener('workspace-changed', handler);
    };
  }, [enabled, t]);

  return { detectedClis, loaded };
}
