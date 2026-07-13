/**
 * External-agent profile editor — the add/edit form plus its supporting
 * command-assembly helpers and the `useDetectedClis` host-CLI detection
 * hook. Rendered inline inside {@link AcpSettings} and as a standalone
 * {@link ProfileEditorModal} by the chat panel's "Add agent" menu.
 */

import { Info } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  createAcpProfile,
  listAcpAgentClis,
  updateAcpProfile,
} from '@/api/acp';
import { Button } from '@/components/Common/Button';
import { Input } from '@/components/Common/Input';
import { Modal } from '@/components/Common/Modal';
import { PathInput } from '@/components/Common/PathInput';
import { Select } from '@/components/Common/Select';
import { TabGroup } from '@/components/Common/TabGroup';
import { toast } from '@/components/Common/Toast';
import { Tooltip } from '@/components/Common/Tooltip';

import type {
  AcpAgentCliInfo,
  AcpAgentProfile,
  AcpProfileCreateRequest,
  AcpProfileUpdateRequest,
} from '@sediment/shared';

// ── Profile editor ────────────────────────────────────────────────────

interface ProfileEditorFormProps {
  /** When non-null we're editing; when null we're creating. */
  editing: AcpAgentProfile | null;
  /** Host-detected CLIs used to pre-fill `command` for new profiles. */
  detectedClis: AcpAgentCliInfo[];
  /**
   * Whether host-CLI detection has settled at least once. Until it has,
   * a new profile keeps the Built-in tab active with a "detecting…"
   * placeholder instead of prematurely falling back to Custom — which
   * would flash the Custom tab open on mount and then snap to Built-in
   * once the CLIs arrive.
   */
  detectionLoaded: boolean;
  /** Dismiss the editor (cancel or after a successful save). */
  onClose: () => void;
  /** Parent re-fetches profiles after the mutation succeeds. */
  onSaved: () => Promise<void>;
}

interface ProfileEditorModalProps extends ProfileEditorFormProps {
  isOpen: boolean;
}

interface ProfileFormState {
  displayName: string;
  /** Detected CLI id, `custom`, or `agent-team`; controls rendered fields. */
  cliId: string;
  /** Whether to add the selected CLI's official auto-approval arguments. */
  allowAll: boolean;
  /**
   * Custom mode (`cliId === 'custom'` or the picked CLI is no longer
   * detected on host): the full command line the worker should spawn.
   */
  customCommand: string;
  cwd: string;
  autoRestart: boolean;
  /** Agent Team mode: absolute path to the agent-team directory. */
  agentDir: string;
  /** Agent Team mode: optional harness override (daemon validates). */
  harness: string;
}

const EMPTY_FORM: ProfileFormState = {
  displayName: '',
  cliId: 'custom',
  allowAll: false,
  customCommand: '',
  cwd: '',
  autoRestart: true,
  agentDir: '',
  harness: '',
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
  state: ProfileFormState,
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

/**
 * Field label with an optional trailing info icon that surfaces the
 * long-form description in a hover tooltip. Used inside
 * `ProfileEditorModal` to keep each row visually compact while
 * preserving the explanatory copy.
 */
const FieldLabel: React.FC<{
  children: React.ReactNode;
  hint?: React.ReactNode;
}> = ({ children, hint }) => {
  const { t } = useTranslation();
  return (
    <span className="text-fg-muted flex items-center gap-1">
      <span>{children}</span>
      {hint ? (
        <Tooltip
          content={hint}
          contentClassName="max-w-80 leading-snug whitespace-normal"
        >
          <span
            role="img"
            aria-label={t('settings.moreInfo')}
            tabIndex={0}
            className="text-fg-subtle hover:text-fg-default focus-visible:text-fg-default inline-flex cursor-help outline-none"
          >
            <Info size={12} />
          </span>
        </Tooltip>
      ) : null}
    </span>
  );
};

export const ProfileEditorForm: React.FC<ProfileEditorFormProps> = ({
  editing,
  detectedClis,
  detectionLoaded,
  onClose,
  onSaved,
}) => {
  const { t } = useTranslation();
  // Start a *new* profile on the ACP Agent tab. An empty `cliId` keeps
  // the picker in its detecting state until host detection settles; the
  // effect below then commits the first CLI, or Manual setup when none
  // were found.
  const [form, setForm] = useState<ProfileFormState>(() =>
    editing ? EMPTY_FORM : { ...EMPTY_FORM, cliId: '' },
  );
  const [saving, setSaving] = useState(false);

  // Reset the form whenever the editor is (re)opened for a different
  // profile (or transitions create ↔ edit). The form only mounts while
  // the editor is visible — as a Modal child (unmounted when closed) or
  // as the inline detail pane — so a mount is equivalent to an "open".
  useEffect(() => {
    if (editing) {
      if (editing.cliId === 'agent-team' && editing.agentTeam) {
        // Agent Team profile — populate agent-team fields
        setForm({
          ...EMPTY_FORM,
          displayName: editing.displayName,
          cliId: 'agent-team',
          autoRestart: editing.autoRestart,
          agentDir: editing.agentTeam.agentDir,
          harness: editing.agentTeam.harness ?? '',
        });
      } else {
        // Try to recover the structured fields (allow-all toggle +
        // extra args) by re-parsing the persisted `command` against the
        // detected CLI. If the command no longer fits the structured
        // shape (custom binary path, hand-edited, CLI uninstalled),
        // `parseCommandIntoForm` falls back to custom mode with the raw
        // command preserved verbatim — no silent reformat.
        const parsed = parseCommandIntoForm(
          editing.command ?? '',
          editing.cliId,
          detectedClis,
        );
        setForm({
          displayName: editing.displayName,
          cliId: parsed.cliId,
          allowAll: parsed.allowAll,
          customCommand: parsed.customCommand,
          cwd: editing.cwd ?? '',
          autoRestart: editing.autoRestart,
          agentDir: '',
          harness: '',
        });
      }
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
      const firstDetected = detectedClis[0];
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
        : (detectedClis.find((c) => c.id === form.cliId) ?? null),
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
    const isAgentTeam = form.cliId === 'agent-team';

    if (isAgentTeam) {
      const agentDir = form.agentDir.trim();
      if (!agentDir) {
        toast(t('settings.agentDirectoryRequired'), { tone: 'danger' });
        return;
      }
      const displayName =
        form.displayName.trim() ||
        agentDir.split('/').pop() ||
        t('settings.agentTeam');
      setSaving(true);
      try {
        if (editing) {
          const patch: AcpProfileUpdateRequest = {
            displayName,
            autoRestart: form.autoRestart,
            agentTeam: {
              agentDir,
              ...(form.harness.trim() && { harness: form.harness.trim() }),
            },
          };
          await updateAcpProfile(editing.id, patch);
          toast(t('settings.profileUpdated'), { tone: 'success' });
        } else {
          const payload: AcpProfileCreateRequest = {
            displayName,
            cliId: 'agent-team',
            autoRestart: form.autoRestart,
            agentTeam: {
              agentDir,
              ...(form.harness.trim() && { harness: form.harness.trim() }),
            },
          };
          await createAcpProfile(payload);
          toast(t('settings.profileCreated'), { tone: 'success' });
        }
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
      if (editing) {
        const patch: AcpProfileUpdateRequest = {
          displayName,
          command,
          cwd,
          autoRestart: form.autoRestart,
        };
        await updateAcpProfile(editing.id, patch);
        toast(t('settings.profileUpdated'), { tone: 'success' });
      } else {
        const payload: AcpProfileCreateRequest = {
          displayName,
          cliId: form.cliId,
          command,
          cwd,
          autoRestart: form.autoRestart,
        };
        await createAcpProfile(payload);
        toast(t('settings.profileCreated'), { tone: 'success' });
      }
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
  }, [form, defaultDisplayName, detectedClis, editing, onSaved, onClose, t]);

  const cliOptions = useMemo(() => {
    const options = detectedClis.map((c) => ({
      value: c.id,
      label: c.displayName,
    }));
    options.push({
      value: 'custom',
      label: t('settings.customCommand'),
    });
    return options;
  }, [detectedClis, t]);

  const profileType: 'acp' | 'agent-team' =
    form.cliId === 'agent-team' ? 'agent-team' : 'acp';

  const handleProfileTypeChange = useCallback(
    (type: 'acp' | 'agent-team') => {
      if (type === 'agent-team') {
        setForm((prev) => ({
          ...prev,
          cliId: 'agent-team',
          allowAll: false,
        }));
        return;
      }

      handleCliChange(detectedClis[0]?.id ?? 'custom');
    },
    [detectedClis, handleCliChange],
  );

  const setCwd = useCallback(
    (cwd: string) => setForm((p) => ({ ...p, cwd })),
    [],
  );
  const setAgentDir = useCallback(
    (agentDir: string) => setForm((p) => ({ ...p, agentDir })),
    [],
  );

  return (
    <div className="flex flex-col gap-5">
      {/* ─── Agent ─────────────────────────────────────────────── */}
      <div className="flex flex-col gap-3">
        {/*
         * Hide the picker on edit because `cliId` is immutable in the
         * update schema (changing it would silently break the persisted
         * binding). Show the chosen agent as a static label so the user
         * still sees what's wired up.
         */}
        {editing ? (
          editing.cliId === 'agent-team' ? (
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1 text-xs">
                <FieldLabel>{t('settings.agent')}</FieldLabel>
                <div className="border-edge-default bg-surface text-fg-default rounded border px-2 py-1 text-xs">
                  {t('settings.agentTeam')}
                </div>
              </label>
              <label className="flex flex-col gap-1 text-xs">
                <FieldLabel hint={t('settings.agentDirectoryHint')}>
                  {t('settings.agentDirectory')}
                </FieldLabel>
                <PathInput
                  value={form.agentDir}
                  onChange={setAgentDir}
                  placeholder="/path/to/agent-teams/my-agent"
                  size="sm"
                  mono
                  pickTitle={t('settings.pickFolder')}
                  inputClassName="rounded"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs">
                <FieldLabel hint={t('settings.harnessHint')}>
                  {t('settings.harness')}{' '}
                  <span className="text-fg-subtle">
                    ({t('settings.optional')})
                  </span>
                </FieldLabel>
                <Input
                  value={form.harness}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, harness: e.target.value }))
                  }
                  placeholder="claude"
                  className="border-edge-default bg-surface rounded border px-2 py-1 font-mono text-xs"
                />
              </label>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1 text-xs">
                <FieldLabel>{t('settings.agent')}</FieldLabel>
                <div className="border-edge-default bg-surface text-fg-default rounded border px-2 py-1 text-xs">
                  {detectedClis.find((c) => c.id === form.cliId)?.displayName ??
                    (form.cliId === 'custom'
                      ? t('settings.customCommand')
                      : form.cliId)}
                </div>
              </label>
              {form.cliId === 'custom' ? (
                <label className="flex flex-col gap-1 text-xs">
                  <FieldLabel hint={t('settings.launchCommandHint')}>
                    {t('settings.launchCommand')}
                  </FieldLabel>
                  <Input
                    value={form.customCommand}
                    onChange={(e) =>
                      setForm((p) => ({
                        ...p,
                        customCommand: e.target.value,
                      }))
                    }
                    placeholder="/usr/local/bin/copilot --acp --allow-all"
                    className="border-edge-default bg-surface rounded border px-2 py-1 font-mono text-xs"
                  />
                </label>
              ) : null}
            </div>
          )
        ) : (
          <div className="flex flex-col gap-2">
            <TabGroup
              value={profileType}
              onChange={handleProfileTypeChange}
              options={[
                { value: 'acp', label: t('settings.acpAgent') },
                { value: 'agent-team', label: t('settings.agentTeam') },
              ]}
              size="sm"
              className="self-start"
            />
            {profileType === 'agent-team' ? (
              <div className="flex flex-col gap-3">
                <label className="flex flex-col gap-1 text-xs">
                  <FieldLabel hint={t('settings.agentDirectoryDetailedHint')}>
                    {t('settings.agentDirectory')}
                  </FieldLabel>
                  <PathInput
                    value={form.agentDir}
                    onChange={setAgentDir}
                    placeholder="/path/to/agent-teams/my-agent"
                    size="sm"
                    mono
                    pickTitle={t('settings.pickFolder')}
                    inputClassName="rounded"
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs">
                  <FieldLabel hint={t('settings.harnessDetailedHint')}>
                    {t('settings.harness')}{' '}
                    <span className="text-fg-subtle">
                      ({t('settings.optional')})
                    </span>
                  </FieldLabel>
                  <Input
                    value={form.harness}
                    onChange={(e) =>
                      setForm((p) => ({ ...p, harness: e.target.value }))
                    }
                    placeholder="claude"
                    className="border-edge-default bg-surface rounded border px-2 py-1 font-mono text-xs"
                  />
                </label>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <label className="flex flex-col gap-1 text-xs">
                  <FieldLabel>{t('settings.agent')}</FieldLabel>
                  {!detectionLoaded ? (
                    // Detection still in flight — keep the ACP picker
                    // stable until its detected options are available.
                    <div className="border-edge-default bg-surface text-fg-subtle rounded border px-2 py-1 text-xs leading-snug">
                      {t('settings.detectingClis')}
                    </div>
                  ) : (
                    <Select
                      value={form.cliId}
                      onChange={handleCliChange}
                      options={cliOptions}
                    />
                  )}
                </label>
                {form.cliId === 'custom' ? (
                  <label className="flex flex-col gap-1 text-xs">
                    <FieldLabel hint={t('settings.launchCommandHint')}>
                      {t('settings.launchCommand')}
                    </FieldLabel>
                    <Input
                      value={form.customCommand}
                      onChange={(e) =>
                        setForm((p) => ({
                          ...p,
                          customCommand: e.target.value,
                        }))
                      }
                      placeholder="/usr/local/bin/copilot --acp --allow-all"
                      className="border-edge-default bg-surface rounded border px-2 py-1 font-mono text-xs"
                    />
                  </label>
                ) : null}
              </div>
            )}
          </div>
        )}

        {isStructured && selectedCli?.autoApprove && (
          <label className="text-fg-default flex cursor-pointer items-start gap-2 text-xs select-none">
            <input
              type="checkbox"
              className="accent-info mt-0.5 h-3.5 w-3.5"
              checked={form.allowAll}
              onChange={(e) =>
                setForm((p) => ({ ...p, allowAll: e.target.checked }))
              }
            />
            <FieldLabel hint={t('settings.autoApproveAllToolCallsHint')}>
              {t('settings.autoApproveAllToolCalls')} (
              <code className="font-mono">
                {selectedCli.autoApprove.args.join(' ')}
              </code>
              )
            </FieldLabel>
          </label>
        )}
      </div>

      {/* ─── Workspace (hidden for Agent Team — daemon resolves cwd) */}
      {profileType !== 'agent-team' && (
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-xs">
            <FieldLabel hint={t('settings.workingDirectoryHint')}>
              {t('settings.workingDirectory')}
            </FieldLabel>
            <PathInput
              value={form.cwd}
              onChange={setCwd}
              placeholder="/Users/me/project-x"
              size="sm"
              mono
              pickTitle={t('settings.pickFolder')}
              inputClassName="rounded"
            />
          </label>
        </div>
      )}

      {/* ─── Display name (placed last per UX request) ─────────── */}
      <label className="flex flex-col gap-1 text-xs">
        <FieldLabel>
          {t('settings.displayName')}{' '}
          <span className="text-fg-subtle">({t('settings.optional')})</span>
        </FieldLabel>
        <Input
          value={form.displayName}
          onChange={(e) =>
            setForm((p) => ({ ...p, displayName: e.target.value }))
          }
          placeholder={defaultDisplayName}
          className="border-edge-default bg-surface rounded border px-2 py-1 text-xs"
        />
      </label>

      {/* ─── Actions ───────────────────────────────────────────── */}
      <div className="flex justify-end gap-2">
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
          disabled={saving}
        >
          {saving
            ? t('settings.saving')
            : editing
              ? t('settings.saveChanges')
              : t('settings.createProfile')}
        </Button>
      </div>
    </div>
  );
};

/**
 * Modal wrapper around {@link ProfileEditorForm}. Used by surfaces that
 * have no host container of their own (e.g. the chat panel's "Add agent"
 * menu), where a standalone dialog is the right pattern. Inside Settings
 * the form is rendered inline as a master-detail pane instead, so the
 * editor never stacks a second modal on top of the Settings modal.
 */
export const ProfileEditorModal: React.FC<ProfileEditorModalProps> = ({
  isOpen,
  editing,
  detectedClis,
  detectionLoaded,
  onClose,
  onSaved,
}) => {
  const { t } = useTranslation();
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={
        editing
          ? t('settings.editExternalAgent')
          : t('settings.newExternalAgent')
      }
      className="w-104"
    >
      <ProfileEditorForm
        editing={editing}
        detectedClis={detectedClis}
        detectionLoaded={detectionLoaded}
        onClose={onClose}
        onSaved={onSaved}
      />
    </Modal>
  );
};
/**
 * Fetch the host-detected CLIs on mount. Shared between the Settings
 * section and the inline "Add agent" entry in `NewChatMenu` so both
 * surfaces can present the same Profile editor without duplicating the
 * one-shot detection effect.
 *
 * Detection failures degrade silently — callers receive `[]` and the
 * editor's Agent dropdown just falls back to "Manual setup".
 *
 * `loaded` starts `false` and flips `true` after the first detection
 * attempt settles (success or failure). Callers use it to avoid
 * committing a "no CLI found → custom" default before detection has
 * actually run, which would otherwise flash the Custom tab open on
 * mount and then snap to Built-in once the CLIs arrive.
 */
export function useDetectedClis(): {
  detectedClis: AcpAgentCliInfo[];
  loaded: boolean;
} {
  const [detectedClis, setDetectedClis] = useState<AcpAgentCliInfo[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    /**
     * Fire-and-forget. We refetch on every workspace-ready transition
     * because `/api/acp/agent-cli` sits behind the server's workspace
     * guard — if Settings was opened on the WorkspaceSetupPage the
     * initial fetch 503s and we'd otherwise be stuck with an empty
     * Built-in list until the user reloads.
     */
    const load = () => {
      listAcpAgentClis()
        .then((res) => {
          if (!cancelled) setDetectedClis(res.agents);
        })
        .catch(() => {
          // Detection failure is non-fatal — Manual setup still
          // works. Don't pop a toast; the dropdown just shows "Custom"
          // as the only entry.
        })
        .finally(() => {
          if (!cancelled) setLoaded(true);
        });
    };
    load();
    const handler = () => load();
    window.addEventListener('workspace-changed', handler);
    return () => {
      cancelled = true;
      window.removeEventListener('workspace-changed', handler);
    };
  }, []);
  return { detectedClis, loaded };
}
