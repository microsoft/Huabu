// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useEffect, useState } from 'react';

import { previewAcpProfileLaunch } from '@/api/acp';

import type {
  AcpProfileLaunchPreviewBody,
  AcpProfileLaunchPreviewResponse,
} from '@huabu/shared';

interface PreviewResult {
  key: string;
  plan?: AcpProfileLaunchPreviewResponse;
  error?: string;
}

/** Debounce daemon compilation and fence results from older form drafts. */
export function useProfileLaunchPreview(
  body: AcpProfileLaunchPreviewBody | null,
) {
  const key = body ? JSON.stringify(body) : null;
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!key) return;
    let active = true;
    const timer = window.setTimeout(() => {
      const request = JSON.parse(key) as AcpProfileLaunchPreviewBody;
      void previewAcpProfileLaunch(request).then(
        (plan) => {
          if (active) setResult({ key, plan });
        },
        (error: unknown) => {
          if (active) {
            setResult({
              key,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
      );
    }, 300);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [key, attempt]);

  const current = result?.key === key ? result : null;
  return {
    plan: current?.plan,
    error: current?.error,
    pending: key !== null && current === null,
    retry: () => {
      setResult(null);
      setAttempt((previous) => previous + 1);
    },
  };
}
