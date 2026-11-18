// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Folder } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { pickFolder } from '@/api/workspace';
import {
  isAgentletFolderPickerSupported,
  useAgentletFolderPicker,
} from '@/hooks/useAgentletFolderPicker';
import { useAcpProfilesStore } from '@/store/acpProfilesStore';
import {
  resolveFolderPickerSupported,
  useWorkspaceStore,
} from '@/store/workspaceStore';

import { Button } from './Button';
import { Loading } from './Loading';
import { toast } from './Toast';

interface FolderPickerButtonProps {
  targetAgentletId?: string;
  enabled?: boolean;
  disabled?: boolean;
  size?: 'sm' | 'md' | 'field';
  /** Defaults to the outlined field companion; toolbars pass `ghost`. */
  variant?: 'outline' | 'ghost';
  title?: string;
  className?: string;
  onPicked: (path: string) => void;
  onError?: (message: string) => void;
  onPickingChange?: (picking: boolean) => void;
}

export function FolderPickerButton({
  targetAgentletId,
  enabled = true,
  disabled,
  size = 'sm',
  variant = 'outline',
  title,
  className,
  onPicked,
  onError,
  onPickingChange,
}: FolderPickerButtonProps) {
  const { t } = useTranslation();
  const supported = useAgentletFolderPicker(targetAgentletId);
  const [picking, setPicking] = useState(false);
  const inFlight = useRef(false);
  const scopeRevision = useRef(0);
  const current = useRef({ targetAgentletId, enabled, onPicked, onError });
  const mounted = useRef(false);
  useEffect(() => {
    current.current = { targetAgentletId, enabled, onPicked, onError };
  }, [targetAgentletId, enabled, onPicked, onError]);
  useEffect(() => {
    scopeRevision.current += 1;
  }, [targetAgentletId, enabled]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const handlePick = async () => {
    if (inFlight.current || disabled || !enabled || !supported) return;
    inFlight.current = true;
    const revision = scopeRevision.current;
    const pickerDeviceId =
      useAcpProfilesStore.getState().folderPickerAgentletId;
    setPicking(true);
    onPickingChange?.(true);
    const reportError = (message: string) => {
      if (current.current.onError) current.current.onError(message);
      else toast(message, { tone: 'danger' });
    };
    try {
      const result = await pickFolder();
      if (!mounted.current) return;
      if (result.ok) {
        const stillSupported = resolveFolderPickerSupported(
          useWorkspaceStore.getState().capabilities?.nativePicker ?? false,
        );
        if (
          !current.current.enabled ||
          scopeRevision.current !== revision ||
          current.current.targetAgentletId !== targetAgentletId ||
          !stillSupported ||
          (targetAgentletId !== undefined &&
            (pickerDeviceId !==
              useAcpProfilesStore.getState().folderPickerAgentletId ||
              !isAgentletFolderPickerSupported(
                targetAgentletId,
                useAcpProfilesStore.getState(),
              )))
        ) {
          reportError(t('settings.folderPickerTargetChanged'));
          return;
        }
        current.current.onPicked(result.path);
      } else if (result.reason === 'no-picker') {
        reportError(t('settings.folderPickerUnavailable'));
      }
    } catch (error) {
      if (mounted.current)
        reportError(
          error instanceof Error
            ? error.message
            : t('settings.folderPickerFailed'),
        );
    } finally {
      inFlight.current = false;
      if (mounted.current) {
        setPicking(false);
        onPickingChange?.(false);
      }
    }
  };

  if (!enabled || !supported) return null;
  return (
    <Button
      variant={variant}
      tone="neutral"
      size={size}
      iconOnly
      title={title ?? t('settings.pickFolder')}
      aria-label={title ?? t('settings.pickFolder')}
      disabled={disabled || picking}
      className={className}
      onClick={() => void handlePick()}
    >
      {picking ? (
        <Loading layout="inline" size="sm" className="text-fg-subtle" />
      ) : (
        <Folder size={size === 'sm' ? 14 : 16} className="text-fg-subtle" />
      )}
    </Button>
  );
}
