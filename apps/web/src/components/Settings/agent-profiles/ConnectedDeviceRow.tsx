// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  ChevronDown,
  ChevronRight,
  MoreHorizontal,
  Pencil,
  Plus,
} from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/Common/Button';
import {
  DropdownMenu,
  DropdownMenuItem,
} from '@/components/Common/DropdownMenu';
import { dismissPopoversWithin } from '@/components/Common/Popover';
import { TextInput } from '@/components/Common/TextInput';
import { SettingRow } from '@/components/Settings/Common/SettingRow';
import { useAcpProfilesStore } from '@/store/acpProfilesStore';

import { DeviceInformation } from './DeviceInformation';

import type { AgentletDevice } from '@huabu/shared';
import type { ReactNode, Ref } from 'react';

export function ConnectedDeviceRow({
  device,
  isLocalDevice,
  connectionControls,
  connectionError,
  menuItems,
  online = true,
  children,
  onAdd,
  addRef,
  profileCount = 0,
}: {
  device: AgentletDevice;
  isLocalDevice: boolean;
  connectionControls?: ReactNode;
  connectionError?: string | null;
  menuItems?: ReactNode;
  online?: boolean;
  children?: ReactNode;
  onAdd?: () => void;
  addRef?: Ref<HTMLButtonElement>;
  profileCount?: number;
}) {
  const { t } = useTranslation();
  const renameDevice = useAcpProfilesStore((state) => state.renameDevice);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(device.displayName);
  const [saving, setSaving] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const savingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const renameRef = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  const [expanded, setExpanded] = useState(true);
  const profilesId = useId();
  const profilesRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    } else if (wasEditing.current) {
      renameRef.current?.focus();
    }
    wasEditing.current = editing;
  }, [editing]);

  const saveName = async () => {
    if (savingRef.current) return;
    const name = draft.trim();
    if (!name || name.length > 120) {
      setRenameError(t('settings.deviceNameInvalid'));
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setRenameError(null);
    try {
      if (name !== device.displayName)
        await renameDevice(device.agentletId, name);
      setEditing(false);
    } catch (reason) {
      setRenameError(
        reason instanceof Error
          ? reason.message
          : t('settings.deviceRenameFailed'),
      );
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <div
      className="border-edge-default mb-3 rounded-lg border"
      data-device-id={device.agentletId}
    >
      <SettingRow
        title={
          editing ? (
            <TextInput
              ref={inputRef}
              aria-label={t('settings.deviceName')}
              aria-invalid={!!renameError}
              className="w-full"
              value={draft}
              maxLength={120}
              disabled={saving}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.nativeEvent.isComposing || saving) return;
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void saveName();
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  setEditing(false);
                  setRenameError(null);
                }
              }}
            />
          ) : (
            <Button
              variant="ghost"
              size="field"
              className="text-fg-default focus-visible:outline-info min-h-8 w-full min-w-0 justify-start gap-2 px-1 text-left focus-visible:outline-2 enabled:hover:bg-transparent"
              aria-expanded={expanded}
              aria-controls={profilesId}
              onClick={() => {
                if (expanded && profilesRef.current)
                  dismissPopoversWithin(profilesRef.current);
                setExpanded((value) => !value);
              }}
            >
              {expanded ? (
                <ChevronDown className="shrink-0" />
              ) : (
                <ChevronRight className="shrink-0" />
              )}
              <span className="flex min-w-0 items-baseline gap-1.5">
                <span className="truncate" title={device.displayName}>
                  {device.displayName}
                </span>
                {isLocalDevice ? (
                  <span className="text-fg-muted shrink-0 text-xs font-normal">
                    {t('settings.localAgentThisDevice')}
                  </span>
                ) : null}
              </span>
              {!expanded && (
                <span className="text-fg-muted shrink-0 text-xs font-normal">
                  {t('settings.deviceProfileCount', { count: profileCount })}
                </span>
              )}
            </Button>
          )
        }
        className="gap-2 px-2.5 py-1.5"
      >
        <div className="flex flex-wrap items-center justify-end gap-1">
          {!editing && connectionControls}
          {!online && !isLocalDevice && (
            <span role="status" className="text-fg-muted px-2 text-xs">
              {t('settings.localAgentDisabled')}
            </span>
          )}
          {online && onAdd && !editing && (
            <Button
              variant="ghost"
              size="field"
              ref={addRef}
              data-editor-trigger={`create:${device.agentletId}`}
              onClick={onAdd}
            >
              <Plus />
              {t('settings.addAgent')}
            </Button>
          )}
          {editing ? (
            <>
              <Button
                size="sm"
                disabled={saving}
                onClick={() => void saveName()}
              >
                {t('actions.save')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={saving}
                onClick={() => {
                  setEditing(false);
                  setRenameError(null);
                }}
              >
                {t('actions.cancel')}
              </Button>
            </>
          ) : (
            <DropdownMenu
              align="bottom-right"
              trigger={
                <Button
                  ref={renameRef}
                  variant="ghost"
                  size="field"
                  iconOnly
                  aria-label={t('settings.deviceActions', {
                    device: device.displayName,
                  })}
                >
                  <MoreHorizontal />
                </Button>
              }
            >
              {online && (
                <DropdownMenuItem
                  icon={<Pencil />}
                  onClick={() => {
                    setDraft(device.displayName);
                    setRenameError(null);
                    setEditing(true);
                  }}
                >
                  {t('settings.renameDevice')}
                </DropdownMenuItem>
              )}
              {menuItems}
              <DeviceInformation device={device} />
            </DropdownMenu>
          )}
        </div>
        {renameError ? (
          <p
            role="alert"
            className="text-danger mt-2 max-w-sm text-xs [overflow-wrap:anywhere]"
          >
            {renameError}
          </p>
        ) : null}
      </SettingRow>
      {connectionError && (
        <p
          role="alert"
          className="text-danger px-3.5 pb-2 text-xs [overflow-wrap:anywhere]"
        >
          {connectionError}
        </p>
      )}
      <div
        id={profilesId}
        ref={profilesRef}
        hidden={!expanded}
        className="border-edge-default border-t py-1.5"
      >
        {profileCount ? (
          children
        ) : (
          <p className="text-fg-muted px-8 py-2 text-xs">
            {t('settings.noAgentConfigurations')}
          </p>
        )}
      </div>
    </div>
  );
}
