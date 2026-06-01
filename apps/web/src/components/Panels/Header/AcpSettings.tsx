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
import { SettingRow } from '@/components/Common/SettingRow';
import { SettingSection } from '@/components/Common/SettingSection';
import { toast } from '@/components/Common/Toast';
import { Toggle } from '@/components/Common/Toggle';
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

  // Surface store errors as transient toasts.
  useEffect(() => {
    if (error) {
      toast(error, { variant: 'error' });
    }
  }, [error]);

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

  return (
    <SettingSection title="External Agents">
      <SettingRow
        title="ACP Bridge"
        description="Allow external agents to connect via the ACP bridge."
      >
        <Toggle
          checked={enabled}
          onChange={handleToggle}
          disabled={saving || !config}
          label={enabled ? 'Disable ACP bridge' : 'Enable ACP bridge'}
        />
      </SettingRow>

      {enabled && (
        <SettingRow
          title="Bridge Token"
          description="Paste this into your agentlet launcher's ACP_DEV_TOKEN env var."
        >
          <div className="flex items-center gap-1">
            <code className="text-fg-default border-edge-default rounded border px-2 py-0.5 font-mono text-sm font-semibold tracking-widest">
              {token || '—'}
            </code>
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
        </SettingRow>
      )}
    </SettingSection>
  );
};
