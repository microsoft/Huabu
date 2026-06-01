/**
 * ACP (external agent bridge) configuration section in the Settings
 * popover. Lets the user:
 *
 *  - Toggle the bridge on/off — server persists the flag in
 *    `data/acp-config.json` and seeds/clears the token store in-place,
 *    so the change takes effect with no restart.
 *  - View the shared `agentlet` token (auto-generated on first enable).
 *  - Copy the token to the clipboard so they can paste it into the
 *    `agentlet` launcher in their other workspace.
 *  - Rotate the token (re-generates a fresh 64-char hex value and
 *    invalidates the old one immediately).
 *
 * Visibility: rendered inside the Settings popover, below
 * {@link LLMSettings}. The popover's `init` callback triggers
 * `useAcpConfigStore.init()` so the data is ready by the time the user
 * opens this section.
 */

import { Check, ClipboardCopy, RefreshCw } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/Common/Button';
import { useAcpConfigStore } from '@/store/acpConfigStore';
import { copyToClipboard } from '@/utils/io/clipboard';

export const AcpSettings: React.FC = () => {
  const config = useAcpConfigStore((s) => s.config);
  const saving = useAcpConfigStore((s) => s.saving);
  const error = useAcpConfigStore((s) => s.error);
  const setConfig = useAcpConfigStore((s) => s.setConfig);

  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
    };
  }, []);

  const flashCopied = useCallback(() => {
    setCopied(true);
    if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => {
      setCopied(false);
      copyTimerRef.current = null;
    }, 1500);
  }, []);

  const handleToggle = useCallback(() => {
    if (!config) return;
    void setConfig({ enabled: !config.enabled });
  }, [config, setConfig]);

  const handleCopy = useCallback(() => {
    if (!config?.token) return;
    void copyToClipboard(config.token).then(() => flashCopied());
  }, [config, flashCopied]);

  const handleRegenerate = useCallback(() => {
    if (!config?.enabled) return;
    void setConfig({ enabled: true, regenerateToken: true });
  }, [config, setConfig]);

  const enabled = config?.enabled ?? false;
  const token = config?.token ?? '';
  const maskedToken = token ? `${token.slice(0, 6)}…${token.slice(-4)}` : '—';

  return (
    <div className="border-edge-default mb-3 border-b pb-3">
      <label className="text-fg-muted mb-1.5 block text-xs font-medium">
        External Agents (ACP)
      </label>

      {/* Enable toggle */}
      <div className="border-edge-default bg-bg-default mb-2 flex items-center justify-between rounded-md border px-2 py-1.5">
        <div className="min-w-0">
          <p className="text-fg-default text-xs font-medium">Bridge</p>
          <p className="text-fg-subtle text-[11px]">
            {enabled
              ? 'Accepting agentlet connections'
              : 'Disabled — no external agents can connect'}
          </p>
        </div>
        <Button
          variant={enabled ? 'solid' : 'outline'}
          tone={enabled ? 'info' : 'neutral'}
          size="sm"
          onClick={handleToggle}
          disabled={saving || !config}
          title={enabled ? 'Disable ACP bridge' : 'Enable ACP bridge'}
        >
          {enabled ? 'Disable' : 'Enable'}
        </Button>
      </div>

      {/* Token row — only meaningful while enabled */}
      {enabled && (
        <div className="border-edge-default bg-bg-default mb-2 rounded-md border px-2 py-1.5">
          <div className="mb-1 flex items-center justify-between">
            <p className="text-fg-default text-xs font-medium">Bridge Token</p>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                tone="neutral"
                size="sm"
                iconOnly
                title={copied ? 'Copied!' : 'Copy token'}
                onClick={handleCopy}
                disabled={!token}
              >
                {copied ? <Check /> : <ClipboardCopy />}
              </Button>
              <Button
                variant="ghost"
                tone="neutral"
                size="sm"
                iconOnly
                title="Regenerate token (invalidates the current one)"
                onClick={handleRegenerate}
                disabled={saving}
              >
                <RefreshCw />
              </Button>
            </div>
          </div>
          <code className="text-fg-muted bg-surface block truncate rounded px-1.5 py-1 font-mono text-[11px]">
            {maskedToken}
          </code>
          <p className="text-fg-subtle mt-1 text-[11px] leading-snug">
            Paste this into your <code className="font-mono">agentlet</code>{' '}
            launcher's <code className="font-mono">ACP_DEV_TOKEN</code> env var.
          </p>
        </div>
      )}

      {error && (
        <p className="text-danger mt-1 text-[11px]" role="alert">
          {error}
        </p>
      )}
    </div>
  );
};
