/**
 * External-agent profile editor — the add/edit form plus its supporting
 * command-assembly helpers and the `useDetectedClis` host-CLI detection
 * hook. Rendered inline inside {@link AcpSettings} and as a standalone
 * {@link ProfileEditorModal} by the chat panel's "Add agent" menu.
 */

import { Info } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

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
  AcpCommandProfileView,
  CreateAcpCommandProfileBody,
} from '@sediment/shared';

// ── Profile editor ────────────────────────────────────────────────────

interface ProfileEditorFormProps {
  /** When non-null we're editing; when null we're creating. */
  editing: AcpCommandProfileView | null;
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
  /**
   * Either the id of a detected CLI (`copilot` / `claude` / …) or
   * the literal `'custom'`. Drives whether structured controls
   * (auto-approve toggle, command preview) or the raw `customCommand`
   * field is rendered.
   */
  cliId: string;
  /**
   * Structured mode: append the CLI's `allowAllFlag` (e.g. `--allow-all`)
   * to the assembled command. Ignored when the selected CLI has no
   * such flag or when `cliId === 'custom'`.
   */
  allowAll: boolean;
  /**
   * Custom mode (`cliId === 'custom'` or the picked CLI is no longer
   * detected on host): the full command line the worker should spawn.
   */
  customCommand: string;
  cwd: string;
}

const EMPTY_FORM: ProfileFormState = {
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
 * referenced CLI isn't currently detected. Use Custom mode for
 * anything more advanced than `binary + acpArgs (+ allow-all flag)`.
 */
function buildCommand(
  state: ProfileFormState,
  detectedClis: AcpAgentCliInfo[],
): string {
  if (state.cliId === 'custom') return state.customCommand.trim();
  const cli = detectedClis.find((c) => c.id === state.cliId);
  if (!cli) return state.customCommand.trim();
  const parts: string[] = [cli.binary, ...cli.acpArgs];
  if (state.allowAll && cli.allowAllFlag) parts.push(cli.allowAllFlag);
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
 * uninstalled — falls back to Custom mode so the raw command is
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
  let i = 1;
  for (const arg of cli.acpArgs) {
    if (tokens[i] !== arg) return fallback;
    i++;
  }
  const rest = tokens.slice(i);
  // The only structured "extra" we recognise is the allow-all flag.
  // Anything else means the command was customised — drop into
  // Custom mode so nothing is hidden from the user.
  if (rest.length === 0) {
    return { cliId: cli.id, allowAll: false, customCommand: '' };
  }
  if (cli.allowAllFlag && rest.length === 1 && rest[0] === cli.allowAllFlag) {
    return { cliId: cli.id, allowAll: true, customCommand: '' };
  }
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
  // Start a *new* profile on the Built-in tab (empty `cliId` → the
  // `agentMode` derivation below reads it as 'detected'). This keeps the
  // Built-in tab active while detection is still in flight so the tab
  // never flashes Custom → Built-in. The effect below commits the real
  // default (first CLI, or Custom when none) once detection settles.
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
    } else {
      // For new profiles, wait for host-CLI detection to settle before
      // committing a default. Until then keep `cliId` empty so the
      // Built-in tab stays active with a "detecting…" placeholder
      // (see the render below) rather than momentarily showing Custom.
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
  const handleCliChange = useCallback((cliId: string) => {
    setForm((prev) => ({
      ...prev,
      cliId,
      allowAll: false,
    }));
  }, []);

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
    if (editing) {
      const displayName = form.displayName.trim() || editing.alias;
      setSaving(true);
      try {
        await updateAcpProfile(editing.id, { alias: displayName });
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
      const payload: CreateAcpCommandProfileBody = {
        alias: displayName,
        workingDirPath: cwd,
        launch: { kind: 'acp-command', command },
        metadata: { cliId: form.cliId },
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
  }, [form, defaultDisplayName, detectedClis, editing, onSaved, onClose, t]);

  const cliOptions = useMemo(
    () =>
      detectedClis.map((c) => ({
        value: c.id,
        label: c.displayName,
      })),
    [detectedClis],
  );

  /**
   * The agent picker is a two-tab switch:
   *   - "detected" → choose from the auto-detected CLIs on PATH.
   *   - "custom"   → type a full launch command yourself.
   * `form.cliId === 'custom'` is the single source of truth; the tab
   * state is derived from it so loading an existing profile lands on
   * the correct tab automatically.
   */
  const agentMode: 'detected' | 'custom' =
    form.cliId === 'custom' ? 'custom' : 'detected';

  const handleAgentModeChange = useCallback(
    (mode: 'detected' | 'custom') => {
      if (mode === 'custom') {
        // Seed the Custom textarea with whatever Detected would have
        // launched so the user can tweak instead of typing from
        // scratch. Skip when the user already has a custom command
        // (e.g. they toggled away and back) so we don't blow away
        // their edits.
        setForm((prev) => {
          if (prev.cliId === 'custom') return prev;
          const seeded =
            prev.customCommand.trim() || buildCommand(prev, detectedClis);
          return {
            ...prev,
            cliId: 'custom',
            allowAll: false,
            customCommand: seeded,
          };
        });
      } else {
        handleCliChange(detectedClis[0]?.id ?? 'custom');
      }
    },
    [detectedClis, handleCliChange],
  );

  const setCwd = useCallback(
    (cwd: string) => setForm((p) => ({ ...p, cwd })),
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
            <label className="flex flex-col gap-1 text-xs">
              <FieldLabel>{t('settings.launchCommand')}</FieldLabel>
              <div className="border-edge-default bg-bg-default text-fg-muted rounded border px-2 py-1 font-mono text-xs">
                {editing.launch.command}
              </div>
            </label>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <TabGroup
              value={agentMode}
              onChange={handleAgentModeChange}
              options={[
                { value: 'detected', label: t('settings.builtIn') },
                { value: 'custom', label: t('settings.custom') },
              ]}
              size="sm"
              className="self-start"
            />
            {agentMode === 'detected' ? (
              <label className="flex flex-col gap-1 text-xs">
                <FieldLabel>{t('settings.agent')}</FieldLabel>
                {!detectionLoaded ? (
                  // Detection still in flight — a neutral placeholder
                  // avoids flashing the "no CLI found" copy before the
                  // CLIs have actually been probed.
                  <div className="border-edge-default bg-surface text-fg-subtle rounded border px-2 py-1 text-xs leading-snug">
                    {t('settings.detectingClis')}
                  </div>
                ) : cliOptions.length > 0 ? (
                  <Select
                    value={form.cliId}
                    onChange={handleCliChange}
                    options={cliOptions}
                  />
                ) : (
                  <div className="border-edge-default bg-surface text-fg-muted rounded border px-2 py-1 text-xs leading-snug">
                    <Trans
                      i18nKey="settings.noCliFound"
                      components={{ strong: <strong /> }}
                    />
                  </div>
                )}
              </label>
            ) : (
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
            )}
          </div>
        )}

        {!editing && isStructured && selectedCli?.allowAllFlag && (
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
              <code className="font-mono">{selectedCli.allowAllFlag}</code>)
            </FieldLabel>
          </label>
        )}
      </div>

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
            disabled={editing !== null}
          />
        </label>
      </div>

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
 * editor's Auto-detected dropdown just falls back to "Custom command".
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
          // Detection failure is non-fatal — the Custom option still
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
