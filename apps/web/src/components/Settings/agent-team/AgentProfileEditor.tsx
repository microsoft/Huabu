// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * `AgentProfileEditor` — the single entry point for creating or editing an
 * external-agent Profile.
 *
 * It owns nothing beyond dispatch: given a mode it renders the right
 * per-kind form and, in create mode, the optional Template picker that
 * decides which kind is created.
 *
 *  - **create** — a Template is optional. Without one the
 *    {@link CommandProfileForm} creates an `acp-command` Profile; with one
 *    the {@link ManifestProfileForm} creates an `agent-team-manifest`
 *    Profile (Setup is left explicit and is not started here).
 *  - **edit-command** — edit an existing `acp-command` Profile.
 *  - **edit-manifest** — edit an existing `agent-team-manifest` Profile.
 *
 * Per-kind forms keep their own state, validation, and API calls; this
 * component only chooses between them so the two `launch.kind` domains
 * never bleed into one giant conditional form.
 */

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Select } from '@/components/Common/Select';
import { SettingControl } from '@/components/Settings/Common/SettingControl';
import { SettingRow } from '@/components/Settings/Common/SettingRow';

import { CommandProfileForm } from './CommandProfileForm';
import { ManifestProfileForm } from './ManifestProfileForm';

import type {
  ManifestMemberGroup,
  ManifestProfileRow,
} from './useUnifiedAgents';
import type {
  AcpAgentCliInfo,
  AcpCommandProfileView,
  AgentTeamMemberDetailView,
} from '@huabu/shared';

type AgentProfileEditorProps =
  | {
      mode: 'create';
      members: ManifestMemberGroup[];
      manifestError: string | null;
      detectedClis: AcpAgentCliInfo[];
      detectionLoaded: boolean;
      onClose: () => void;
      onCommandCreated: () => Promise<void>;
      onManifestCreated: (ref: {
        machine: string;
        manifestPath: string;
      }) => Promise<void>;
      applyMemberDetail: (detail: AgentTeamMemberDetailView) => void;
    }
  | {
      mode: 'edit-command';
      profile: AcpCommandProfileView;
      detectedClis: AcpAgentCliInfo[];
      detectionLoaded: boolean;
      onClose: () => void;
      onSaved: () => Promise<void>;
    }
  | {
      mode: 'edit-manifest';
      row: ManifestProfileRow;
      detectedClis: AcpAgentCliInfo[];
      onClose: () => void;
      applyMemberDetail: (detail: AgentTeamMemberDetailView) => void;
      onAliasSaved: () => Promise<void>;
    };

function memberValue(group: ManifestMemberGroup): string {
  return `${group.member.machine}\u0000${group.member.manifestPath}`;
}

export function AgentProfileEditor(props: AgentProfileEditorProps) {
  if (props.mode === 'edit-command') {
    return (
      <CommandProfileForm
        editing={props.profile}
        detectedClis={props.detectedClis}
        detectionLoaded={props.detectionLoaded}
        onClose={props.onClose}
        onSaved={props.onSaved}
      />
    );
  }

  if (props.mode === 'edit-manifest') {
    return (
      <ManifestProfileForm
        mode="edit"
        row={props.row}
        detectedClis={props.detectedClis}
        onClose={props.onClose}
        applyMemberDetail={props.applyMemberDetail}
        onAliasSaved={props.onAliasSaved}
      />
    );
  }

  return <CreateAgentProfileFlow {...props} />;
}

function CreateAgentProfileFlow({
  members,
  manifestError,
  detectedClis,
  detectionLoaded,
  onClose,
  onCommandCreated,
  onManifestCreated,
  applyMemberDetail,
}: Extract<AgentProfileEditorProps, { mode: 'create' }>) {
  const { t } = useTranslation();
  const templateLabel = t('settings.template');
  const templateOptions = useMemo(
    () => [
      {
        value: '',
        label: t('settings.noTemplate'),
        description: t('settings.noTemplateDescription'),
      },
      ...members.map((group) => ({
        value: memberValue(group),
        label: group.member.name,
        description: group.member.description || undefined,
      })),
    ],
    [members, t],
  );
  const [selectedKey, setSelectedKey] = useState('');
  const selected = useMemo(
    () => members.find((group) => memberValue(group) === selectedKey) ?? null,
    [members, selectedKey],
  );

  return (
    <div className="flex flex-col">
      <SettingRow title={t('settings.template')}>
        <SettingControl>
          <Select
            value={selectedKey}
            options={templateOptions}
            onChange={setSelectedKey}
            ariaLabel={templateLabel}
            className="w-full"
          />
        </SettingControl>
      </SettingRow>
      <p className="text-fg-subtle px-3 pb-2.5 text-[11px] leading-snug">
        {selected?.member.description || t('settings.templateOptionalHint')}
      </p>
      {manifestError ? (
        <p className="text-warning px-3 py-2.5 text-xs" role="status">
          {t('settings.templatesUnavailable', { error: manifestError })}
        </p>
      ) : null}
      {/*
       * Divider rule: the only time the Preset row connects to what follows
       * with no line is when a preset with credentials is selected — then the
       * nested credentials sub-group sits directly under Preset and the
       * divider falls after it, before Agent. In every other case (no preset,
       * or a preset with no credentials) the first row is Agent, so add a top
       * divider directly between Preset and Agent.
       */}
      <div
        className={
          selected && selected.config.fields.length > 0
            ? undefined
            : 'border-edge-default border-t'
        }
      >
        {selected ? (
          <ManifestProfileForm
            key={selectedKey}
            mode="create"
            group={selected}
            detectedClis={detectedClis}
            detectionLoaded={detectionLoaded}
            onClose={onClose}
            onCreated={onManifestCreated}
            applyMemberDetail={applyMemberDetail}
          />
        ) : (
          <CommandProfileForm
            editing={null}
            detectedClis={detectedClis}
            detectionLoaded={detectionLoaded}
            onClose={onClose}
            onSaved={onCommandCreated}
          />
        )}
      </div>
    </div>
  );
}
