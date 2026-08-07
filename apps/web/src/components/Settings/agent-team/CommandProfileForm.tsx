// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Command-backed (`acp-command`) Profile form — the add/edit form plus its
 * supporting command-assembly helpers. Rendered inside {@link AgentProfileEditor}
 * for both creating a new custom agent and editing an existing one.
 */

import React, { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  createAcpProfile,
  listAcpAgentClis,
  updateAcpProfile,
} from '@/api/acp';
import { Button } from '@/components/Common/Button';
import { PathInput } from '@/components/Common/PathInput';
import { Select } from '@/components/Common/Select';
import { TextInput } from '@/components/Common/TextInput';
import { toast } from '@/components/Common/Toast';
import { SettingControl } from '@/components/Settings/Common/SettingControl';
import { SettingLabel } from '@/components/Settings/Common/SettingLabel';
import { SettingRow } from '@/components/Settings/Common/SettingRow';
import { SettingSubGroup } from '@/components/Settings/Common/SettingSubGroup';
import {
  readAgentIcon,
  randomAgentIcon,
  withAgentIcon,
} from '@/utils/agentIcon';

import { AgentIconField } from './AgentIconField';
import { ProfileEditActions } from './ProfileEditActions';
import { ProfileEditFields } from './ProfileEditFields';
import { ProfileFormFooter } from './ProfileFormFooter';
import { ReadOnlyField } from './ReadOnlyField';

import type { AgentIconValue } from '@/components/Common/AgentIcon';
import type {
  AcpAgentCliInfo,
  AcpCommandProfileView,
  CreateAcpCommandProfileBody,
} from '@huabu/shared';

// ── Command Profile form ──────────────────────────────────────────────

interface CommandProfileFormProps {
  /** When non-null we're editing; when null we're creating. */
  editing: AcpCommandProfileView | null;
  /** Host-detected CLIs used to pre-fill `command` for new profiles. */
  detectedClis: AcpAgentCliInfo[];
  /**
   * Whether host-CLI detection has settled at least once. Until it has,
   * a new profile keeps the picker in a "detecting…" placeholder instead
   * of prematurely selecting "Custom command" — which would flash the raw
   * command field open on mount and then snap to a detected CLI once the
   * CLIs arrive.
   */
  detectionLoaded: boolean;
  /** Dismiss the editor (cancel or after a successful save). */
  onClose: () => void;
  /** Parent re-fetches profiles after the mutation succeeds. */
  onSaved: () => Promise<void>;
}

interface CommandProfileFormState {
  displayName: string;
  /**
   * Either the id of a detected CLI (`copilot` / `claude` / …) or
   * the literal `'custom'`. Drives whether structured controls
   * (auto-approve toggle, command preview) or the raw `customCommand`
   * field is rendered.
   */
  cliId: string;
  /** Whether to add the selected CLI's official auto-approval arguments. */
  allowAll: boolean;
  /**
   * Custom mode (`cliId === 'custom'` or the picked CLI is no longer
   * detected on host): the full command line the worker should spawn.
   */
  customCommand: string;
  cwd: string;
}

const EMPTY_FORM: CommandProfileFormState = {
  displayName: '',
  cliId: 'custom',
  allowAll: false,
  customCommand: '',
  cwd: '',
};

/**
 * Strip directory + `.exe` from a path so e.g.
 * `C:\Users\me\AppData\npm\copilot.exe` → `copilot`. Used to match
 * a stored command's first token against a detected CLI's `binary`
 * name without being defeated by Windows absolute paths.
 */
function binaryBasename(token: string): string {
  const flat = token.replace(/\\/g, '/');
  const last = flat.slice(flat.lastIndexOf('/') + 1);
  return last.replace(/\.exe$/i, '');
}

/**
 * Assemble the final command line from a structured form + the
 * selected detected CLI. Returns the trimmed string the worker will
 * spawn. Returns `customCommand` (trimmed) in custom mode or when the
 * referenced CLI isn't currently detected. Use Manual setup for
 * anything outside the preset command recipes.
 */
function buildCommand(
  state: CommandProfileFormState,
  detectedClis: AcpAgentCliInfo[],
): string {
  if (state.cliId === 'custom') return state.customCommand.trim();
  const cli = detectedClis.find((c) => c.id === state.cliId);
  if (!cli) return state.customCommand.trim();
  const approval = state.allowAll ? cli.autoApprove : null;
  const parts: string[] = [cli.binary];
  if (approval?.position === 'before-acp') parts.push(...approval.args);
  parts.push(...cli.acpArgs);
  if (approval?.position === 'after-acp') parts.push(...approval.args);
  return parts.join(' ');
}

/**
 * Take the last path segment of a file-system path, normalised across
 * `/` and `\\` separators. Used to derive a friendly default display
 * name (`Copilot (project-x)` from `/Users/me/project-x`). Returns an
 * empty string for empty / whitespace input — callers fall back to
 * just the agent name in that case.
 */
function basenameFromPath(p: string): string {
  if (!p) return '';
  const flat = p.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!flat) return '';
  const idx = flat.lastIndexOf('/');
  return idx >= 0 ? flat.slice(idx + 1) : flat;
}

/**
 * Compose the editor's default display name from the selected CLI's
 * label + the working-directory basename. Example:
 * `Copilot CLI (project-x)`. Used both as the placeholder in the
 * Display name input AND as the fallback sent to the server when the
 * user leaves the field blank — so the persisted profile always has a
 * reasonable label without forcing the user to type one.
 */
function buildDefaultDisplayName(
  cliDisplayName: string | null,
  cwd: string,
  customAgentLabel: string,
): string {
  const folder = basenameFromPath(cwd.trim());
  const agent = cliDisplayName?.trim() || customAgentLabel;
  return folder ? `${agent} (${folder})` : agent;
}

/**
 * Best-effort reverse of {@link buildCommand}: given a stored
 * `command` plus its `cliId`, recover the structured form fields so
 * the editor opens with the same checkboxes the user originally
 * chose. When the command no longer matches the detected CLI's
 * exact shape (binary + acpArgs (+ allow-all flag)) — e.g. extra
 * flags were appended, the user hand-edited it, or the CLI was
 * uninstalled — falls back to Manual setup so the raw command is
 * fully visible and editable rather than partially hidden behind
 * structured controls.
 */
function parseCommandIntoForm(
  command: string,
  cliId: string,
  detectedClis: AcpAgentCliInfo[],
): {
  cliId: string;
  allowAll: boolean;
  customCommand: string;
} {
  const fallback = {
    cliId: 'custom',
    allowAll: false,
    customCommand: command,
  };
  if (cliId === 'custom') return fallback;
  const cli = detectedClis.find((c) => c.id === cliId);
  if (!cli) return fallback;
  const tokens = command.trim().split(/\s+/);
  if (tokens.length === 0 || binaryBasename(tokens[0]) !== cli.binary) {
    return fallback;
  }
  const actualArgs = tokens.slice(1);
  const sameArgs = (expected: string[]) =>
    actualArgs.length === expected.length &&
    actualArgs.every((arg, index) => arg === expected[index]);
  if (sameArgs(cli.acpArgs)) {
    return { cliId: cli.id, allowAll: false, customCommand: '' };
  }
  if (cli.autoApprove) {
    const approvedArgs =
      cli.autoApprove.position === 'before-acp'
        ? [...cli.autoApprove.args, ...cli.acpArgs]
        : [...cli.acpArgs, ...cli.autoApprove.args];
    if (sameArgs(approvedArgs)) {
      return { cliId: cli.id, allowAll: true, customCommand: '' };
    }
  }
  // Anything outside the known recipes means the command was customised —
  // drop into Manual setup so no arguments are hidden from the user.
  return fallback;
}

export const CommandProfileForm: React.FC<CommandProfileFormProps> = ({
  editing,
  detectedClis,
  detectionLoaded,
  onClose,
  onSaved,
}) => {
  const { t } = useTranslation();
  const autoApproveId = useId();
  const commandId = useId();
  const cwdId = useId();
  const displayNameId = useId();
  // Start a *new* profile on the ACP Agent tab. An empty `cliId` keeps
  // the picker in its detecting state until host detection settles; the
  // effect below then commits the first CLI, or Manual setup when none
  // were found.
  const [form, setForm] = useState<CommandProfileFormState>(() =>
    editing ? EMPTY_FORM : { ...EMPTY_FORM, cliId: '' },
  );
  const [icon, setIcon] = useState<AgentIconValue>(() =>
    editing ? readAgentIcon(editing) : randomAgentIcon(),
  );
  const [saving, setSaving] = useState(false);

  // Reset the form whenever the editor is (re)opened for a different
  // profile (or transitions create ↔ edit). The form only mounts while
  // the editor is visible — as a Modal child (unmounted when closed) or
  // as the inline detail pane — so a mount is equivalent to an "open".
  useEffect(() => {
    if (editing) {
      const cliId = editing.metadata?.cliId ?? 'custom';
      const parsed = parseCommandIntoForm(
        editing.launch.command,
        cliId,
        detectedClis,
      );
      setForm({
        displayName: editing.alias,
        cliId: parsed.cliId,
        allowAll: parsed.allowAll,
        customCommand: parsed.customCommand,
        cwd: editing.workingDirPath,
      });
      setIcon(readAgentIcon(editing));
    } else {
      // For new profiles, wait for host-CLI detection to settle before
      // committing a default. Until then keep `cliId` empty so the ACP
      // picker shows a stable "detecting…" placeholder rather than
      // momentarily selecting Manual setup.
      if (!detectionLoaded) return;
      // Detection done: default to the first detected CLI so the
      // structured controls appear immediately. Falls back to
      // `'custom'` when nothing is on PATH. `displayName` stays empty
      // so the input's placeholder shows the derived default — the
      // submit handler falls back to `defaultDisplayName` when the
      // field is left blank.
      const firstDetected = detectedClis.find((agent) => agent.installed);
      setForm({
        ...EMPTY_FORM,
        cliId: firstDetected ? firstDetected.id : 'custom',
      });
    }
  }, [editing, detectedClis, detectionLoaded]);

  /**
   * Switching CLIs resets the per-CLI allow-all flag since the
   * vocabulary doesn't carry across CLIs. `displayName` is left
   * untouched — the input's placeholder already reflects the new
   * default via `buildDefaultDisplayName`, and the submit path
   * substitutes the derived default when the field is empty.
   */
  const handleCliChange = useCallback(
    (cliId: string) => {
      setForm((prev) => {
        const customCommand =
          cliId === 'custom' && prev.cliId !== 'custom'
            ? prev.customCommand.trim() || buildCommand(prev, detectedClis)
            : prev.customCommand;
        return {
          ...prev,
          cliId,
          allowAll: false,
          customCommand,
        };
      });
    },
    [detectedClis],
  );

  const selectedCli = useMemo(
    () =>
      form.cliId === 'custom'
        ? null
        : (detectedClis.find((c) => c.id === form.cliId && c.installed) ??
          null),
    [form.cliId, detectedClis],
  );
  const isStructured = selectedCli !== null;

  /**
   * Friendly fallback used both as the Display name placeholder AND
   * as the value persisted when the user leaves the field blank. Recomputed
   * whenever the CLI selection or working directory changes so it always
   * reflects what the saved profile will be called.
   */
  const defaultDisplayName = useMemo(
    () =>
      buildDefaultDisplayName(
        selectedCli?.displayName ?? null,
        form.cwd,
        t('settings.customAgent'),
      ),
    [selectedCli, form.cwd, t],
  );

  const handleSubmit = useCallback(async () => {
    if (editing) {
      const displayName = form.displayName.trim() || editing.alias;
      setSaving(true);
      try {
        await updateAcpProfile(editing.id, {
          alias: displayName,
          ...(icon
            ? { customData: withAgentIcon(editing.customData, icon) }
            : {}),
        });
        toast(t('settings.profileUpdated'), { tone: 'success' });
        await onSaved();
        onClose();
      } catch (err) {
        toast(
          err instanceof Error ? err.message : t('settings.profileSaveFailed'),
          {
            tone: 'danger',
          },
        );
      } finally {
        setSaving(false);
      }
      return;
    }

    const command = buildCommand(form, detectedClis);
    const cwd = form.cwd.trim();
    if (!command) {
      toast(t('settings.commandRequired'), { tone: 'danger' });
      return;
    }
    if (!cwd) {
      toast(t('settings.workingDirectoryRequired'), { tone: 'danger' });
      return;
    }
    // Empty input → fall back to the computed default so the user
    // doesn't have to type a name to save. The default is also what
    // the placeholder shows, so the saved label matches expectations.
    const displayName = form.displayName.trim() || defaultDisplayName;
    setSaving(true);
    try {
      if (form.cliId !== 'custom') {
        const latest = await listAcpAgentClis();
        if (
          !latest.agents.some(
            (agent) => agent.id === form.cliId && agent.installed,
          )
        ) {
          toast(t('settings.selectedAgentUnavailable'), { tone: 'danger' });
          return;
        }
      }
      const payload: CreateAcpCommandProfileBody = {
        alias: displayName,
        workingDirPath: cwd,
        launch: { kind: 'acp-command', command },
        metadata: { cliId: form.cliId },
        customData: withAgentIcon(undefined, icon),
      };
      await createAcpProfile(payload);
      toast(t('settings.profileCreated'), { tone: 'success' });
      await onSaved();
      onClose();
    } catch (err) {
      toast(
        err instanceof Error ? err.message : t('settings.profileSaveFailed'),
        {
          tone: 'danger',
        },
      );
    } finally {
      setSaving(false);
    }
  }, [
    form,
    defaultDisplayName,
    detectedClis,
    editing,
    icon,
    onSaved,
    onClose,
    t,
  ]);

  /**
   * One unified picker: installed Agents first, missing Agents disabled
   * after them, and a trailing "Custom command" option. Selecting
   * "custom" is the single source of truth for showing the raw
   * launch-command field, so loading an existing profile lands on the
   * right control automatically.
   */
  const cliOptions = useMemo(() => {
    const installed = detectedClis
      .filter((cli) => cli.installed)
      .map((cli) => ({
        value: cli.id,
        label: cli.displayName,
      }));
    const missing = detectedClis
      .filter((cli) => !cli.installed)
      .map((cli, index) => ({
        value: cli.id,
        label: cli.displayName,
        disabled: true,
        sectionLabel:
          index === 0 ? t('settings.notInstalledAgents') : undefined,
      }));
    const options = [
      ...installed,
      ...missing,
      {
        value: 'custom',
        label: t('settings.customCommand'),
      },
    ];
    return options;
  }, [detectedClis, t]);

  const setCwd = useCallback(
    (cwd: string) => setForm((p) => ({ ...p, cwd })),
    [],
  );
  const createDisabled =
    !editing &&
    (!detectionLoaded || !buildCommand(form, detectedClis) || !form.cwd.trim());

  if (editing) {
    const agentName =
      detectedClis.find((cli) => cli.id === form.cliId)?.displayName ??
      (form.cliId === 'custom' ? t('settings.customCommand') : form.cliId);
    const agentDetails = (
      <>
        {detectionLoaded && !isStructured ? (
          <SettingRow title={t('settings.launchCommand')}>
            <SettingControl>
              <ReadOnlyField value={editing.launch.command} mono />
            </SettingControl>
          </SettingRow>
        ) : null}
        {isStructured && selectedCli?.autoApprove ? (
          <SettingSubGroup density="compact">
            <SettingRow
              description={t('settings.autoApproveAllToolCallsHint')}
              title={
                <span>
                  {t('settings.autoApproveAllToolCalls')} (
                  <code className="font-mono">
                    {selectedCli.autoApprove.args.join(' ')}
                  </code>
                  )
                </span>
              }
              density="compact"
            >
              <input
                id={autoApproveId}
                type="checkbox"
                aria-label={t('settings.autoApproveAllToolCalls')}
                className="accent-info h-3.5 w-3.5"
                checked={form.allowAll}
                disabled
                readOnly
              />
            </SettingRow>
          </SettingSubGroup>
        ) : null}
      </>
    );

    return (
      <div className="divide-edge-default flex flex-col divide-y">
        <ProfileEditFields
          agentName={agentName}
          agentDetails={agentDetails}
          workingDirPath={form.cwd}
          displayNameId={displayNameId}
          displayNameControl={
            <TextInput
              id={displayNameId}
              value={form.displayName}
              onChange={(event) =>
                setForm((previous) => ({
                  ...previous,
                  displayName: event.target.value,
                }))
              }
              className="w-full"
            />
          }
        />
        <AgentIconField
          value={icon}
          onChange={setIcon}
          alias={form.displayName || editing.alias}
          disabled={saving}
        />
        <ProfileEditActions
          saving={saving}
          onCancel={onClose}
          onSave={() => void handleSubmit()}
        />
      </div>
    );
  }

  return (
    <div className="divide-edge-default flex flex-col divide-y">
      {/* ─── Agent ─────────────────────────────────────────────── */}
      <div className="flex flex-col">
        <div className="flex flex-col">
          <SettingRow title={t('settings.agent')}>
            <SettingControl>
              {!detectionLoaded ? (
                // Detection still in flight — a neutral placeholder avoids
                // flashing a premature selection before the CLIs have
                // actually been probed.
                <div className="border-edge-default bg-surface text-fg-subtle rounded border px-2 py-1 text-xs leading-snug">
                  {t('settings.detectingClis')}
                </div>
              ) : (
                // Detected CLIs first, then "Custom command" as the last
                // option. Selecting it reveals the raw launch-command
                // field below.
                <Select
                  value={form.cliId}
                  onChange={handleCliChange}
                  options={cliOptions}
                  ariaLabel={t('settings.agent')}
                  className="w-full"
                />
              )}
            </SettingControl>
          </SettingRow>
          {form.cliId === 'custom' ? (
            <SettingRow
              labelFor={commandId}
              title={t('settings.launchCommand')}
              description={t('settings.launchCommandHint')}
            >
              <SettingControl>
                <TextInput
                  id={commandId}
                  value={form.customCommand}
                  onChange={(e) =>
                    setForm((p) => ({
                      ...p,
                      customCommand: e.target.value,
                    }))
                  }
                  placeholder="/usr/local/bin/copilot --acp --allow-all"
                  mono
                  className="w-full"
                />
              </SettingControl>
            </SettingRow>
          ) : null}
        </div>

        {isStructured && selectedCli?.autoApprove && (
          <SettingSubGroup density="compact">
            <SettingRow
              description={t('settings.autoApproveAllToolCallsHint')}
              title={
                <label
                  htmlFor={autoApproveId}
                  className={editing ? undefined : 'cursor-pointer'}
                >
                  <span>
                    {t('settings.autoApproveAllToolCalls')} (
                    <code className="font-mono">
                      {selectedCli.autoApprove.args.join(' ')}
                    </code>
                    )
                  </span>
                </label>
              }
              density="compact"
            >
              {/*
               * Read-only in edit: the command (and therefore this flag) is
               * immutable after creation, so the checkbox reflects the saved
               * choice but can't be toggled.
               */}
              <input
                id={autoApproveId}
                type="checkbox"
                aria-label={t('settings.autoApproveAllToolCalls')}
                className="accent-info h-3.5 w-3.5 cursor-pointer"
                checked={form.allowAll}
                onChange={(e) =>
                  setForm((p) => ({ ...p, allowAll: e.target.checked }))
                }
              />
            </SettingRow>
          </SettingSubGroup>
        )}
      </div>

      <SettingRow
        labelFor={cwdId}
        title={t('settings.workingDirectory')}
        description={t('settings.workingDirectoryHint')}
      >
        <SettingControl>
          <PathInput
            id={cwdId}
            value={form.cwd}
            onChange={setCwd}
            placeholder="/Users/me/project-x"
            size="sm"
            mono
            pickTitle={t('settings.pickFolder')}
            inputClassName="rounded"
          />
        </SettingControl>
      </SettingRow>

      {/* ─── Display name (placed last per UX request) ─────────── */}
      <SettingRow
        labelFor={displayNameId}
        title={
          <SettingLabel optional>{t('settings.displayName')}</SettingLabel>
        }
      >
        <SettingControl>
          <TextInput
            id={displayNameId}
            value={form.displayName}
            onChange={(e) =>
              setForm((p) => ({ ...p, displayName: e.target.value }))
            }
            placeholder={defaultDisplayName}
            className="w-full"
          />
        </SettingControl>
      </SettingRow>

      {/* ─── Icon ──────────────────────────────────────────────── */}
      <AgentIconField
        value={icon}
        onChange={setIcon}
        alias={form.displayName || defaultDisplayName}
        disabled={saving}
      />

      {/* ─── Actions ───────────────────────────────────────────── */}
      <ProfileFormFooter>
        <Button
          variant="outline"
          tone="neutral"
          size="sm"
          onClick={onClose}
          disabled={saving}
        >
          {t('actions.cancel')}
        </Button>
        <Button
          variant="solid"
          tone="info"
          size="sm"
          onClick={() => void handleSubmit()}
          disabled={saving || createDisabled}
        >
          {saving ? t('settings.saving') : t('settings.createProfile')}
        </Button>
      </ProfileFormFooter>
    </div>
  );
};
