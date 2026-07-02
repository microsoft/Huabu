/**
 * External-agent settings section in the Settings popover.
 *
 * The section presents two stacked surfaces:
 *
 *  1. **Daemon health** — an inline status pill that's invisible on
 *     the happy path (`online: true`, no lastError). When the
 *     supervisor flips to `online: false` with a non-empty
 *     `lastError`, an amber banner appears with the error text + a
 *     **Restart worker** button. The supervisor auto-restarts with
 *     exponential backoff on its own; the manual button is the
 *     escape hatch when backoff has stretched too long or the user
 *     just fixed the underlying problem (e.g. installed agentlet on
 *     PATH).
 *
 *  2. **Profile editor** — list + CRUD for user-configured external
 *     agents. Each profile is a stable spawn recipe `{cli, command,
 *     cwd, autoRestart}` that the daemon launches on demand.
 *     Profiles persist across restarts; sessions follow the
 *     profileId, not the (volatile) agentlet agentId.
 *
 * **No more pairing terminal paste**: in daemon mode the server owns
 * the daemon lifecycle and the token never crosses the HTTP
 * boundary. The user only sees profiles + the optional troubleshoot
 * banner.
 */

import {
  AlertTriangle,
  Info,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  createAcpProfile,
  deleteAcpProfile,
  listAcpAgentClis,
  restartAcpAgentlet,
  updateAcpProfile,
} from '@/api/acp';
import { Button } from '@/components/Common/Button';
import { Input } from '@/components/Common/Input';
import { Modal } from '@/components/Common/Modal';
import { PathInput } from '@/components/Common/PathInput';
import { Select } from '@/components/Common/Select';
import { SettingRow } from '@/components/Common/SettingRow';
import { SettingSection } from '@/components/Common/SettingSection';
import { Spinner } from '@/components/Common/Spinner';
import { TabGroup } from '@/components/Common/TabGroup';
import { toast } from '@/components/Common/Toast';
import { Tooltip } from '@/components/Common/Tooltip';
import { useAcpProfilesStore } from '@/store/acpProfilesStore';

import type {
  AcpAgentCliInfo,
  AcpAgentProfile,
  AcpAgentletStatus,
  AcpProfileCreateRequest,
  AcpProfileUpdateRequest,
} from '@sediment/shared';

// ── Agentlet health banner ────────────────────────────────────────────

interface AgentletHealthBannerProps {
  agentlet: AcpAgentletStatus | null;
  onRestart: () => Promise<void>;
  restarting: boolean;
}

/**
 * Inline amber banner shown only when the agentlet supervisor is in a
 * known-failed state. The happy path (`online: true`, no error) renders
 * nothing so the section stays compact.
 */
const AgentletHealthBanner: React.FC<AgentletHealthBannerProps> = ({
  agentlet,
  onRestart,
  restarting,
}) => {
  if (!agentlet) return null;
  if (agentlet.online && !agentlet.lastError) return null;

  const nextRestartInSec = agentlet.nextRestartAt
    ? Math.max(0, Math.ceil((agentlet.nextRestartAt - Date.now()) / 1000))
    : null;

  return (
    <div className="border-warning-light/60 bg-warning-light/15 mb-3 flex items-start gap-2 rounded-md border px-3 py-2">
      <AlertTriangle className="text-warning mt-0.5 h-3.5 w-3.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-fg-default text-xs font-medium">
          External-agent worker is offline
        </p>
        {agentlet.lastError && (
          <p className="text-fg-muted mt-0.5 text-[11px] leading-snug wrap-break-word">
            {agentlet.lastError}
          </p>
        )}
        {nextRestartInSec !== null && nextRestartInSec > 0 && (
          <p className="text-fg-subtle mt-0.5 text-[11px] leading-snug">
            Next auto-retry in {nextRestartInSec}s.
          </p>
        )}
      </div>
      <Button
        variant="outline"
        tone="info"
        size="sm"
        onClick={() => void onRestart()}
        disabled={restarting}
        title="Force the worker to restart now"
        className="shrink-0"
      >
        <RefreshCw
          size={12}
          className={restarting ? 'animate-spin' : undefined}
        />
        <span>{restarting ? 'Restarting…' : 'Restart worker'}</span>
      </Button>
    </div>
  );
};

// ── Profile editor modal ──────────────────────────────────────────────

interface ProfileEditorModalProps {
  isOpen: boolean;
  /** When non-null we're editing; when null we're creating. */
  editing: AcpAgentProfile | null;
  /** Host-detected CLIs used to pre-fill `command` for new profiles. */
  detectedClis: AcpAgentCliInfo[];
  onClose: () => void;
  /** Parent re-fetches profiles after the mutation succeeds. */
  onSaved: () => Promise<void>;
}

interface ProfileFormState {
  displayName: string;
  /**
   * Either the id of a detected CLI (`copilot` / `claude` / …) or
   * the literal `'custom'` or `'agent-team'`. Drives whether structured
   * controls (auto-approve toggle, command preview), the raw
   * `customCommand` field, or the Agent Team fields are rendered.
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
): string {
  const folder = basenameFromPath(cwd.trim());
  const agent = cliDisplayName?.trim() || 'Custom agent';
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
}> = ({ children, hint }) => (
  <span className="text-fg-muted flex items-center gap-1">
    <span>{children}</span>
    {hint ? (
      <Tooltip
        content={hint}
        contentClassName="max-w-80 leading-snug whitespace-normal"
      >
        <span
          role="img"
          aria-label="More info"
          tabIndex={0}
          className="text-fg-subtle hover:text-fg-default focus-visible:text-fg-default inline-flex cursor-help outline-none"
        >
          <Info size={12} />
        </span>
      </Tooltip>
    ) : null}
  </span>
);

export const ProfileEditorModal: React.FC<ProfileEditorModalProps> = ({
  isOpen,
  editing,
  detectedClis,
  onClose,
  onSaved,
}) => {
  const [form, setForm] = useState<ProfileFormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  // Reset the form whenever the dialog opens for a different profile
  // (or transitions create ↔ edit). Done as an effect so the form
  // state is reset before the first render of the open dialog.
  useEffect(() => {
    if (!isOpen) return;
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
      // For new profiles, default to the first detected CLI so the
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
  }, [isOpen, editing, detectedClis]);

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
    () => buildDefaultDisplayName(selectedCli?.displayName ?? null, form.cwd),
    [selectedCli, form.cwd],
  );

  const handleSubmit = useCallback(async () => {
    const isAgentTeam = form.cliId === 'agent-team';

    if (isAgentTeam) {
      const agentDir = form.agentDir.trim();
      if (!agentDir) {
        toast('Agent directory is required', { tone: 'danger' });
        return;
      }
      const displayName =
        form.displayName.trim() || agentDir.split('/').pop() || 'Agent Team';
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
          toast('Profile updated', { tone: 'success' });
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
          toast('Profile created', { tone: 'success' });
        }
        await onSaved();
        onClose();
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Failed to save profile', {
          tone: 'danger',
        });
      } finally {
        setSaving(false);
      }
      return;
    }

    const command = buildCommand(form, detectedClis);
    const cwd = form.cwd.trim();
    if (!command) {
      toast('Command is required', { tone: 'danger' });
      return;
    }
    if (!cwd) {
      toast('Working directory is required', { tone: 'danger' });
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
        toast('Profile updated', { tone: 'success' });
      } else {
        const payload: AcpProfileCreateRequest = {
          displayName,
          cliId: form.cliId,
          command,
          cwd,
          autoRestart: form.autoRestart,
        };
        await createAcpProfile(payload);
        toast('Profile created', { tone: 'success' });
      }
      await onSaved();
      onClose();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to save profile', {
        tone: 'danger',
      });
    } finally {
      setSaving(false);
    }
  }, [form, defaultDisplayName, detectedClis, editing, onSaved, onClose]);

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
  const agentMode: 'detected' | 'custom' | 'agent-team' =
    form.cliId === 'agent-team'
      ? 'agent-team'
      : form.cliId === 'custom'
        ? 'custom'
        : 'detected';

  const handleAgentModeChange = useCallback(
    (mode: 'detected' | 'custom' | 'agent-team') => {
      if (mode === 'agent-team') {
        setForm((prev) => ({
          ...prev,
          cliId: 'agent-team',
          allowAll: false,
        }));
      } else if (mode === 'custom') {
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
  const setAgentDir = useCallback(
    (agentDir: string) => setForm((p) => ({ ...p, agentDir })),
    [],
  );

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={editing ? 'Edit external agent' : 'New external agent'}
      className="w-104"
      footer={
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            tone="neutral"
            size="sm"
            onClick={onClose}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            variant="solid"
            tone="info"
            size="sm"
            onClick={() => void handleSubmit()}
            disabled={saving}
          >
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Create profile'}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-5 px-1 py-1">
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
                  <FieldLabel>Agent</FieldLabel>
                  <div className="border-edge-default bg-surface text-fg-default rounded border px-2 py-1 text-xs">
                    Agent Team
                  </div>
                </label>
                <label className="flex flex-col gap-1 text-xs">
                  <FieldLabel hint="Absolute path to the agent-team directory containing agentlet.yaml.">
                    Agent directory
                  </FieldLabel>
                  <PathInput
                    value={form.agentDir}
                    onChange={setAgentDir}
                    placeholder="/path/to/agent-teams/my-agent"
                    size="sm"
                    mono
                    pickTitle="Pick a folder"
                    inputClassName="rounded"
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs">
                  <FieldLabel hint="Optional harness override. Leave blank to use the manifest default.">
                    Harness <span className="text-fg-subtle">(optional)</span>
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
              <label className="flex flex-col gap-1 text-xs">
                <FieldLabel>Agent</FieldLabel>
                <div className="border-edge-default bg-surface text-fg-default rounded border px-2 py-1 text-xs">
                  {detectedClis.find((c) => c.id === form.cliId)?.displayName ??
                    (form.cliId === 'custom' ? 'Custom command' : form.cliId)}
                </div>
              </label>
            )
          ) : (
            <div className="flex flex-col gap-2">
              <TabGroup
                value={agentMode}
                onChange={handleAgentModeChange}
                options={[
                  { value: 'detected', label: 'Built-in' },
                  { value: 'custom', label: 'Custom' },
                  { value: 'agent-team', label: 'Agent Team' },
                ]}
                size="sm"
                className="self-start"
              />
              {agentMode === 'agent-team' ? (
                <div className="flex flex-col gap-3">
                  <label className="flex flex-col gap-1 text-xs">
                    <FieldLabel hint="Absolute path to the agent-team directory containing agentlet.yaml. The daemon resolves the manifest to determine the launch command and working directory.">
                      Agent directory
                    </FieldLabel>
                    <PathInput
                      value={form.agentDir}
                      onChange={setAgentDir}
                      placeholder="/path/to/agent-teams/my-agent"
                      size="sm"
                      mono
                      pickTitle="Pick a folder"
                      inputClassName="rounded"
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-xs">
                    <FieldLabel hint="Optional harness override (e.g. 'claude', 'copilot'). Leave blank to use the first harness declared in the manifest.">
                      Harness <span className="text-fg-subtle">(optional)</span>
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
              ) : agentMode === 'detected' ? (
                <label className="flex flex-col gap-1 text-xs">
                  <FieldLabel>Agent</FieldLabel>
                  {cliOptions.length > 0 ? (
                    <Select
                      value={form.cliId}
                      onChange={handleCliChange}
                      options={cliOptions}
                    />
                  ) : (
                    <div className="border-edge-default bg-surface text-fg-muted rounded border px-2 py-1 text-xs leading-snug">
                      No ACP-capable CLIs found on your PATH. Switch to{' '}
                      <strong>Custom</strong> to type a launch command yourself.
                    </div>
                  )}
                </label>
              ) : (
                <label className="flex flex-col gap-1 text-xs">
                  <FieldLabel hint="Full command line the worker should spawn (binary + all flags). Use this for binaries that aren't on PATH or for flags not exposed by an auto-detected agent.">
                    Launch command
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

          {isStructured && selectedCli?.allowAllFlag && (
            <label className="text-fg-default flex cursor-pointer items-start gap-2 text-xs select-none">
              <input
                type="checkbox"
                className="accent-info mt-0.5 h-3.5 w-3.5"
                checked={form.allowAll}
                onChange={(e) =>
                  setForm((p) => ({ ...p, allowAll: e.target.checked }))
                }
              />
              <FieldLabel hint="Skip the per-tool confirmation prompt. Convenient for sandboxed runs, risky for anything that can touch your filesystem or network.">
                Auto-approve all tool calls (
                <code className="font-mono">{selectedCli.allowAllFlag}</code>)
              </FieldLabel>
            </label>
          )}
        </div>

        {/* ─── Workspace (hidden for Agent Team — daemon resolves cwd) */}
        {agentMode !== 'agent-team' && (
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-xs">
              <FieldLabel hint="The agent is spawned with this as its working directory and treats it as the project root for file edits and tool calls.">
                Working directory
              </FieldLabel>
              <PathInput
                value={form.cwd}
                onChange={setCwd}
                placeholder="/Users/me/project-x"
                size="sm"
                mono
                pickTitle="Pick a folder"
                inputClassName="rounded"
              />
            </label>
          </div>
        )}

        {/* ─── Display name (placed last per UX request) ─────────── */}
        <label className="flex flex-col gap-1 text-xs">
          <FieldLabel>
            Display name <span className="text-fg-subtle">(optional)</span>
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
      </div>
    </Modal>
  );
};

// ── Top-level section ────────────────────────────────────────────────

/**
 * `AcpSettings` — section rendered inside the Settings popover that
 * exposes the user's external-agent profiles + the daemon health
 * banner. The store loads its initial snapshot lazily; SettingsPopover
 * fires `init()` when the popover opens.
 */
/**
 * Fetch the host-detected CLIs on mount. Shared between the Settings
 * section and the inline "Add agent" entry in `NewChatMenu` so both
 * surfaces can present the same Profile editor without duplicating the
 * one-shot detection effect.
 *
 * Detection failures degrade silently — callers receive `[]` and the
 * editor's Auto-detected dropdown just falls back to "Custom command".
 */
export function useDetectedClis(): AcpAgentCliInfo[] {
  const [detectedClis, setDetectedClis] = useState<AcpAgentCliInfo[]>([]);
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
  return detectedClis;
}

export const AcpSettings: React.FC = () => {
  const profiles = useAcpProfilesStore((s) => s.profiles);
  const agentlet = useAcpProfilesStore((s) => s.agentlet);
  const loaded = useAcpProfilesStore((s) => s.loaded);
  const error = useAcpProfilesStore((s) => s.error);
  const refresh = useAcpProfilesStore((s) => s.refresh);

  // Host-CLI detection — see the shared `useDetectedClis` hook above
  // for rationale (single fetch, silent on failure). Re-using the hook
  // keeps Settings and `NewChatMenu`'s inline editor in lockstep.
  const detectedClis = useDetectedClis();

  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<AcpAgentProfile | null>(null);
  const [restarting, setRestarting] = useState(false);
  // Destructive confirmation uses a `Modal` rather than `window.confirm` so
  // the dialog matches the rest of the app's UX (see `CanvasListPage` for
  // the same pattern). `pendingDelete` holds the profile awaiting
  // confirmation; `isDeleting` blocks the modal during the network call so
  // accidental backdrop / Escape dismissals don't strand the request.
  const [pendingDelete, setPendingDelete] = useState<AcpAgentProfile | null>(
    null,
  );
  const [isDeleting, setIsDeleting] = useState(false);
  const confirmDeleteButtonRef = useRef<HTMLButtonElement>(null);

  // Surface fetch errors as transient toasts so the user notices even
  // if the section isn't scrolled into view. We deliberately ignore
  // any error that was already cached before this component mounted —
  // most commonly the workspace-not-configured 503 the store hit when
  // Settings was opened on the WorkspaceSetupPage. The store wipes
  // such errors on the next `workspace-changed` event, but the user
  // might re-open Settings before that fires; replaying a stale
  // message would be more confusing than helpful.
  const lastToastedRef = useRef<Error | null>(error);
  useEffect(() => {
    if (error && error !== lastToastedRef.current) {
      toast(error.message, { tone: 'danger' });
      lastToastedRef.current = error;
    }
  }, [error]);

  const handleNew = useCallback(() => {
    setEditing(null);
    setEditorOpen(true);
  }, []);

  const handleEdit = useCallback((profile: AcpAgentProfile) => {
    setEditing(profile);
    setEditorOpen(true);
  }, []);

  const handleDelete = useCallback((profile: AcpAgentProfile) => {
    // Open the confirmation modal — the actual delete runs from
    // `confirmDelete` once the user clicks through. Profiles often have
    // non-trivial cwd config and re-typing them is annoying, so we want a
    // deliberate confirmation step.
    //
    // Profiles are templates: deleting one removes it from the menu and
    // prevents new threads from binding, but threads that already
    // snapshotted the recipe (v3+ records) keep running unchanged. The
    // modal copy below makes that explicit so users aren't surprised when
    // an open chat keeps responding after they delete the profile.
    setPendingDelete(profile);
  }, []);

  const closeDeleteModal = useCallback(() => {
    if (isDeleting) return;
    setPendingDelete(null);
  }, [isDeleting]);

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete) return;
    setIsDeleting(true);
    try {
      await deleteAcpProfile(pendingDelete.id);
      toast('Profile deleted', { tone: 'success' });
      await refresh();
      setPendingDelete(null);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to delete profile', {
        tone: 'danger',
      });
    } finally {
      setIsDeleting(false);
    }
  }, [pendingDelete, refresh]);

  const handleRestart = useCallback(async () => {
    setRestarting(true);
    try {
      const next = await restartAcpAgentlet();
      // Pull a fresh snapshot so the banner reflects the new state
      // (and the profile-list runtime flags update).
      await refresh();
      if (next.online) {
        toast('Worker restarted', { tone: 'success' });
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to restart worker', {
        tone: 'danger',
      });
    } finally {
      setRestarting(false);
    }
  }, [refresh]);

  const handleSaved = useCallback(async () => {
    await refresh();
  }, [refresh]);

  return (
    <>
      {/*
       * Daemon banner sits OUTSIDE the rounded section card on purpose:
       * (a) when the banner returns null we render nothing at all
       *     (no wrapper, no empty padding), and
       * (b) when it does show, the amber alert reads as a section-level
       *     warning rather than a torn-looking first row inside the card.
       */}
      <AgentletHealthBanner
        agentlet={agentlet}
        onRestart={handleRestart}
        restarting={restarting}
      />

      <SettingSection title="External Agents">
        {profiles.length === 0 ? (
          <SettingRow
            title="No agents configured"
            description="Add a Copilot / Claude / custom profile to bind chats to an external agent."
          >
            <Button
              variant="outline"
              tone="info"
              size="sm"
              onClick={handleNew}
              disabled={!loaded}
            >
              <Plus size={12} />
              <span>Add agent</span>
            </Button>
          </SettingRow>
        ) : (
          <>
            {profiles.map((profile) => (
              <SettingRow key={profile.id} title={profile.displayName}>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="ghost"
                    tone="neutral"
                    size="sm"
                    iconOnly
                    title="Edit profile"
                    onClick={() => handleEdit(profile)}
                  >
                    <Pencil size={12} />
                  </Button>
                  <Button
                    variant="ghost"
                    tone="danger"
                    size="sm"
                    iconOnly
                    title="Delete profile"
                    onClick={() => handleDelete(profile)}
                  >
                    <Trash2 size={12} />
                  </Button>
                </div>
              </SettingRow>
            ))}
            <SettingRow
              title="Add another agent"
              description="Configure a new external agent to bind chats to."
            >
              <Button
                variant="outline"
                tone="info"
                size="sm"
                onClick={handleNew}
                disabled={!loaded}
              >
                <Plus size={12} />
                <span>Add agent</span>
              </Button>
            </SettingRow>
          </>
        )}
      </SettingSection>

      {/*
       * Modal is portalled to document.body — it doesn't matter where
       * we mount it in the tree, but keeping it as a sibling of the
       * section (rather than inside the rounded card) keeps the DOM
       * sensible when devtools is open.
       */}
      <ProfileEditorModal
        isOpen={editorOpen}
        editing={editing}
        detectedClis={detectedClis}
        onClose={() => setEditorOpen(false)}
        onSaved={handleSaved}
      />

      {/*
       * Confirmation modal for destructive profile deletion. Mirrors the
       * `CanvasListPage` delete dialog so the app speaks with one voice
       * for destructive actions — no `window.confirm` anywhere.
       */}
      <Modal
        isOpen={pendingDelete !== null}
        title="Delete external agent?"
        description={
          pendingDelete ? (
            <>
              Are you sure you want to delete{' '}
              <span className="text-fg-default font-medium">
                “{pendingDelete.displayName}”
              </span>
              ? You won't be able to start new chats with it. Chats already
              using it keep running with the current settings.
            </>
          ) : null
        }
        onClose={closeDeleteModal}
        initialFocusRef={confirmDeleteButtonRef}
        closeOnBackdropClick={!isDeleting}
        closeOnEscape={!isDeleting}
        footer={
          <>
            <Button
              variant="outline"
              tone="neutral"
              size="sm"
              onClick={closeDeleteModal}
              disabled={isDeleting}
            >
              Cancel
            </Button>
            <Button
              ref={confirmDeleteButtonRef}
              variant="solid"
              tone="danger"
              size="sm"
              onClick={() => void confirmDelete()}
              disabled={isDeleting}
            >
              {isDeleting ? (
                <Spinner size="sm" className="text-fg-inverse" />
              ) : (
                'Delete'
              )}
            </Button>
          </>
        }
      />
    </>
  );
};
