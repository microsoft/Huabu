// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Host-CLI detection hook shared by the External Agents editor forms.
 *
 * Fetches and caches host-detected CLIs while an editor is open.
 * Detection failures degrade silently — callers receive `[]` and the
 * editor's Agent dropdown just falls back to "Custom command".
 *
 * `loaded` starts `false` and flips `true` after the first detection
 * attempt settles (success or failure). Callers use it to avoid
 * committing a "no CLI found → custom" default before detection has
 * actually run, which would otherwise flash the Custom tab open on
 * mount and then snap to a detected CLI once the CLIs arrive.
 */

import { useEffect, useState } from 'react';

import { listAcpAgentClis } from '@/api/acp';

import type { AcpAgentCliInfo } from '@huabu/shared';

let detectedClisCache: AcpAgentCliInfo[] | null = null;
let detectedClisRequest: Promise<AcpAgentCliInfo[]> | null = null;

function loadDetectedClis(force = false): Promise<AcpAgentCliInfo[]> {
  if (!force && detectedClisCache) return Promise.resolve(detectedClisCache);
  if (detectedClisRequest) return detectedClisRequest;
  const request: Promise<AcpAgentCliInfo[]> = listAcpAgentClis()
    .then((response) => {
      detectedClisCache = response.agents;
      return response.agents;
    })
    .finally(() => {
      if (detectedClisRequest === request) detectedClisRequest = null;
    });
  detectedClisRequest = request;
  return request;
}

export function useDetectedClis(enabled = true): {
  detectedClis: AcpAgentCliInfo[];
  loaded: boolean;
} {
  const [detectedClis, setDetectedClis] = useState<AcpAgentCliInfo[]>(
    () => detectedClisCache ?? [],
  );
  const [loaded, setLoaded] = useState(detectedClisCache !== null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    /**
     * Fire-and-forget. We refetch on every workspace-ready transition
     * because `/api/acp/agent-cli` sits behind the server's workspace
     * guard — if Settings was opened on the WorkspaceSetupPage the
     * initial fetch 503s and we'd otherwise be stuck with an empty
     * Built-in list until the user reloads.
     */
    const load = (force = false) => {
      loadDetectedClis(force)
        .then((agents) => {
          if (!cancelled) setDetectedClis(agents);
        })
        .catch(() => {
          // Detection failure is non-fatal — Custom command still
          // works. Don't pop a toast; the dropdown just shows "Custom"
          // as the only entry.
        })
        .finally(() => {
          if (!cancelled) setLoaded(true);
        });
    };
    load();
    const handler = () => {
      detectedClisCache = null;
      load(true);
    };
    window.addEventListener('workspace-changed', handler);
    return () => {
      cancelled = true;
      window.removeEventListener('workspace-changed', handler);
    };
  }, [enabled]);
  return { detectedClis, loaded };
}
