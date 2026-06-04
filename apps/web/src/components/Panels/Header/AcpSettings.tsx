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
 *     cwd, env, autoRestart}` that the daemon launches on demand.
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
  ChevronRight,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';

import {
  createAcpProfile,
  deleteAcpProfile,
  listAcpAgentClis,
  restartAcpDaemon,
  updateAcpProfile,
} from '@/api/acp';
import { Button } from '@/components/Common/Button';
import { Input } from '@/components/Common/Input';
import { Modal } from '@/components/Common/Modal';
import { Select } from '@/components/Common/Select';
import { SettingRow } from '@/components/Common/SettingRow';
import { SettingSection } from '@/components/Common/SettingSection';
import { toast } from '@/components/Common/Toast';
import { useAcpProfilesStore } from '@/store/acpProfilesStore';

import type {
  AcpAgentCliInfo,
  AcpAgentProfileWithRuntime,
  AcpDaemonStatus,
  AcpProfileCreateRequest,
  AcpProfileUpdateRequest,
} from '@sediment/shared';

// ── Daemon health banner ──────────────────────────────────────────────

interface DaemonHealthBannerProps {
  daemon: AcpDaemonStatus | null;
  onRestart: () => Promise<void>;
  restarting: boolean;
}

/**
 * Inline amber banner shown only when the daemon supervisor is in a
 * known-failed state. The happy path (`online: true`, no error) renders
 * nothing so the section stays compact.
 *
 * Why amber, not red? The supervisor auto-restarts in the background;
 * a momentary offline period during a daemon respawn is expected
 * behaviour. Red would imply "you need to fix this NOW", which
 * overstates the urgency unless the user just tried Restart and it
 * still failed.
 */
const DaemonHealthBanner: React.FC<DaemonHealthBannerProps> = ({
  daemon,
  onRestart,
  restarting,
}) => {
  // Hide on the happy path AND while we're loading the first snapshot —
  // a blank initial state shouldn't flash an error banner.
  if (!daemon) return null;
  if (daemon.online && !daemon.lastError) return null;

  const nextRestartInSec = daemon.nextRestartAt
    ? Math.max(0, Math.ceil((daemon.nextRestartAt - Date.now()) / 1000))
    : null;

  return (
    <div className="border-warning-light/60 bg-warning-light/15 mb-3 flex items-start gap-2 rounded-md border px-3 py-2">
      <AlertTriangle className="text-warning mt-0.5 h-3.5 w-3.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-fg-default text-xs font-medium">
          External-agent worker is offline
        </p>
        {daemon.lastError && (
          <p className="text-fg-muted mt-0.5 text-[11px] leading-snug wrap-break-word">
            {daemon.lastError}
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
  editing: AcpAgentProfileWithRuntime | null;
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
   * the literal `'custom'`. Drives whether structured controls
   * (auto-approve toggle, extra-args input, command preview) or the
   * raw `customCommand` field is rendered.
   */
  cliId: string;
  /**
   * Structured mode: append the CLI's `allowAllFlag` (e.g. `--allow-all`)
   * to the assembled command. Ignored when the selected CLI has no
   * such flag or when `cliId === 'custom'`.
   */
  allowAll: boolean;
  /**
   * Structured mode: free-form extra args appended verbatim after the
   * binary + acpArgs (+ optional allowAllFlag). Persisted as part of
   * the resolved `command` — we re-parse on edit to recover the value.
   */
  extraArgs: string;
  /**
   * Custom mode (`cliId === 'custom'` or the picked CLI is no longer
   * detected on host): the full command line the worker should spawn.
   */
  customCommand: string;
  cwd: string;
  envText: string;
  autoRestart: boolean;
}

const EMPTY_FORM: ProfileFormState = {
  displayName: '',
  cliId: 'custom',
  allowAll: false,
  extraArgs: '',
  customCommand: '',
  cwd: '',
  envText: '',
  autoRestart: true,
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
 * referenced CLI isn't currently detected.
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
  const extras = state.extraArgs.trim();
  if (extras) parts.push(extras);
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
 * the editor opens with the same checkboxes / extra-args the user
 * originally chose. When the command no longer matches the detected
 * CLI's shape (e.g. user manually edited it, or the CLI was
 * uninstalled), returns the original command as `customCommand` and
 * forces `cliId: 'custom'` so the user sees the raw text rather than
 * confusing partial structured controls.
 */
function parseCommandIntoForm(
  command: string,
  cliId: string,
  detectedClis: AcpAgentCliInfo[],
): {
  cliId: string;
  allowAll: boolean;
  extraArgs: string;
  customCommand: string;
} {
  const fallback = {
    cliId: 'custom',
    allowAll: false,
    extraArgs: '',
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
  let allowAll = false;
  let remaining = rest;
  if (cli.allowAllFlag) {
    const idx = rest.indexOf(cli.allowAllFlag);
    if (idx !== -1) {
      allowAll = true;
      remaining = [...rest.slice(0, idx), ...rest.slice(idx + 1)];
    }
  }
  return {
    cliId: cli.id,
    allowAll,
    extraArgs: remaining.join(' '),
    customCommand: '',
  };
}

/**
 * Serialise an env record to `KEY=VALUE` lines for the textarea. The
 * inverse parse runs at submit time. Empty record → empty string so
 * a fresh profile starts with an empty textarea (vs. `{}`).
 */
function envRecordToText(env: Record<string, string> | undefined): string {
  if (!env) return '';
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

/**
 * Parse the textarea contents into an env record. Lines are
 * `KEY=VALUE`, blank lines + lines starting with `#` are ignored.
 * Returns `null` when a non-blank line cannot be parsed so the caller
 * can surface a validation error instead of silently dropping it.
 */
function parseEnvText(text: string): Record<string, string> | null {
  const trimmed = text.trim();
  if (!trimmed) return {};
  const out: Record<string, string> = {};
  for (const raw of trimmed.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx <= 0) return null;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1);
    if (!key) return null;
    out[key] = value;
  }
  return out;
}

const ProfileEditorModal: React.FC<ProfileEditorModalProps> = ({
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
      // Try to recover the structured fields (allow-all toggle +
      // extra args) by re-parsing the persisted `command` against the
      // detected CLI. If the command no longer fits the structured
      // shape (custom binary path, hand-edited, CLI uninstalled),
      // `parseCommandIntoForm` falls back to custom mode with the raw
      // command preserved verbatim — no silent reformat.
      const parsed = parseCommandIntoForm(
        editing.command,
        editing.cliId,
        detectedClis,
      );
      setForm({
        displayName: editing.displayName,
        cliId: parsed.cliId,
        allowAll: parsed.allowAll,
        extraArgs: parsed.extraArgs,
        customCommand: parsed.customCommand,
        cwd: editing.cwd,
        envText: envRecordToText(editing.env),
        autoRestart: editing.autoRestart,
      });
    } else {
      // For new profiles, default to the first detected CLI so the
      // structured controls appear immediately. Falls back to
      // `'custom'` when nothing is on PATH.
      const firstDetected = detectedClis[0];
      setForm({
        ...EMPTY_FORM,
        cliId: firstDetected ? firstDetected.id : 'custom',
        displayName: firstDetected ? firstDetected.displayName : '',
      });
    }
  }, [isOpen, editing, detectedClis]);

  /**
   * Switching CLIs in structured mode: pre-fill `displayName` when
   * the user hasn't customised it (so picking "Claude Code" labels
   * the profile accordingly). All other structured fields are reset
   * because flag-vocabulary doesn't carry across CLIs.
   */
  const handleCliChange = useCallback(
    (cliId: string) => {
      setForm((prev) => {
        const next: ProfileFormState = {
          ...prev,
          cliId,
          allowAll: false,
          extraArgs: '',
        };
        if (cliId !== 'custom') {
          const cli = detectedClis.find((c) => c.id === cliId);
          if (cli && !prev.displayName.trim()) {
            next.displayName = cli.displayName;
          }
        }
        return next;
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
    () => buildDefaultDisplayName(selectedCli?.displayName ?? null, form.cwd),
    [selectedCli, form.cwd],
  );

  /**
   * Advanced section (extra args, env vars, auto-restart) is collapsed
   * by default — most users only need the agent + working directory.
   * Resets to collapsed every time the dialog re-opens so an
   * accidentally-expanded session doesn't leak into the next edit.
   */
  const [advancedOpen, setAdvancedOpen] = useState(false);
  useEffect(() => {
    if (!isOpen) setAdvancedOpen(false);
  }, [isOpen]);

  const handleSubmit = useCallback(async () => {
    const command = buildCommand(form, detectedClis);
    const cwd = form.cwd.trim();
    if (!command) {
      toast('Command is required', { variant: 'error' });
      return;
    }
    if (!cwd) {
      toast('Working directory is required', { variant: 'error' });
      return;
    }
    const env = parseEnvText(form.envText);
    if (env === null) {
      toast('Env vars must be one `KEY=VALUE` per line', { variant: 'error' });
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
          // Always send env (possibly empty) so removing a var works.
          env: Object.keys(env).length > 0 ? env : null,
          autoRestart: form.autoRestart,
        };
        await updateAcpProfile(editing.id, patch);
        toast('Profile updated', { variant: 'success' });
      } else {
        const payload: AcpProfileCreateRequest = {
          displayName,
          cliId: form.cliId,
          command,
          cwd,
          ...(Object.keys(env).length > 0 ? { env } : {}),
          autoRestart: form.autoRestart,
        };
        await createAcpProfile(payload);
        toast('Profile created', { variant: 'success' });
      }
      await onSaved();
      onClose();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to save profile', {
        variant: 'error',
      });
    } finally {
      setSaving(false);
    }
  }, [form, defaultDisplayName, detectedClis, editing, onSaved, onClose]);

  const cliOptions = useMemo(() => {
    const opts = detectedClis.map((c) => ({
      value: c.id,
      label: c.version ? `${c.displayName} · ${c.version}` : c.displayName,
    }));
    return [...opts, { value: 'custom', label: 'Custom command' }];
  }, [detectedClis]);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={editing ? 'Edit external agent' : 'New external agent'}
      description="The worker launches this agent on demand and reuses it across chats."
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
          <div className="text-fg-subtle text-[10px] font-semibold tracking-wider uppercase">
            Agent
          </div>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-fg-muted">Auto detected agent</span>
            {/*
             * Hide the picker on edit because `cliId` is immutable in the
             * update schema (changing it would silently break the persisted
             * binding). Show the chosen CLI as a static label so the user
             * still sees what's wired up.
             */}
            {editing ? (
              <div className="border-edge-default bg-surface text-fg-default rounded border px-2 py-1 text-sm">
                {cliOptions.find((o) => o.value === form.cliId)?.label ??
                  form.cliId}
              </div>
            ) : (
              <Select
                value={form.cliId}
                onChange={handleCliChange}
                options={cliOptions}
              />
            )}
            {!editing && (
              <span className="text-fg-subtle text-[11px] leading-snug">
                Sediment auto-detected these ACP-capable CLIs on your PATH. Pick
                one to use its defaults, or choose{' '}
                <strong>Custom command</strong> to type the launch command
                yourself.
              </span>
            )}
          </label>

          {isStructured ? (
            selectedCli?.allowAllFlag && (
              <label className="text-fg-default flex cursor-pointer items-start gap-2 text-xs select-none">
                <input
                  type="checkbox"
                  className="accent-info mt-0.5 h-3.5 w-3.5"
                  checked={form.allowAll}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, allowAll: e.target.checked }))
                  }
                />
                <span className="flex flex-col gap-0.5">
                  <span>
                    Auto-approve all tool calls (
                    <code className="font-mono">
                      {selectedCli.allowAllFlag}
                    </code>
                    )
                  </span>
                  <span className="text-fg-muted text-[11px] leading-snug">
                    Skip the per-tool confirmation prompt. Convenient for
                    sandboxed runs, risky for anything that can touch your
                    filesystem or network.
                  </span>
                </span>
              </label>
            )
          ) : (
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-fg-muted">Launch command</span>
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
              <span className="text-fg-subtle text-[11px] leading-snug">
                Full command line the worker should spawn (binary + all flags).
                Use this for binaries that aren't on PATH or for flags not
                exposed by an auto-detected agent.
              </span>
            </label>
          )}
        </div>

        {/* ─── Workspace ─────────────────────────────────────────── */}
        <div className="border-edge-default flex flex-col gap-3 border-t pt-4">
          <div className="text-fg-subtle text-[10px] font-semibold tracking-wider uppercase">
            Workspace
          </div>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-fg-muted">Working directory</span>
            <Input
              value={form.cwd}
              onChange={(e) => setForm((p) => ({ ...p, cwd: e.target.value }))}
              placeholder="/Users/me/project-x"
              className="border-edge-default bg-surface rounded border px-2 py-1 font-mono text-xs"
            />
            <span className="text-fg-subtle text-[11px] leading-snug">
              The agent is spawned with this as its working directory and treats
              it as the project root for file edits and tool calls.
            </span>
          </label>
        </div>

        {/* ─── Advanced (collapsible) ────────────────────────────── */}
        <div className="border-edge-default border-t pt-3">
          <button
            type="button"
            onClick={() => setAdvancedOpen((o) => !o)}
            aria-expanded={advancedOpen}
            className="text-fg-muted hover:text-fg-default flex items-center gap-1.5 select-none"
          >
            <ChevronRight
              size={12}
              className={`transition-transform ${advancedOpen ? 'rotate-90' : ''}`}
            />
            <span className="text-[10px] font-semibold tracking-wider uppercase">
              Advanced
            </span>
          </button>
          {advancedOpen && (
            <div className="mt-3 flex flex-col gap-3">
              {isStructured && (
                <label className="flex flex-col gap-1 text-xs">
                  <span className="text-fg-muted">
                    Extra args{' '}
                    <span className="text-fg-subtle">(optional)</span>
                  </span>
                  <Input
                    value={form.extraArgs}
                    onChange={(e) =>
                      setForm((p) => ({ ...p, extraArgs: e.target.value }))
                    }
                    placeholder="--model claude-sonnet-4 --max-tokens 4000"
                    className="border-edge-default bg-surface rounded border px-2 py-1 font-mono text-xs"
                  />
                  <span className="text-fg-subtle text-[11px] leading-snug">
                    Extra CLI flags appended after the auto-built command.
                  </span>
                </label>
              )}
              <label className="flex flex-col gap-1 text-xs">
                <span className="text-fg-muted">
                  Environment variables{' '}
                  <span className="text-fg-subtle">(optional)</span>
                </span>
                <textarea
                  value={form.envText}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, envText: e.target.value }))
                  }
                  rows={3}
                  placeholder={
                    'ANTHROPIC_API_KEY=sk-...\nHTTPS_PROXY=http://proxy:8080'
                  }
                  className="border-edge-default bg-surface rounded border px-2 py-1 font-mono text-xs"
                />
                <span className="text-fg-subtle text-[11px] leading-snug">
                  Extra <code className="font-mono">KEY=VALUE</code> pairs
                  merged into the agent process's environment when it spawns —
                  useful for API keys, proxy settings, or CLI-specific config
                  that isn't already in your shell. One per line; lines starting
                  with <code className="font-mono">#</code> are ignored.
                </span>
              </label>
              <label className="text-fg-default inline-flex cursor-pointer items-center gap-2 text-xs select-none">
                <input
                  type="checkbox"
                  className="accent-info h-3.5 w-3.5"
                  checked={form.autoRestart}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, autoRestart: e.target.checked }))
                  }
                />
                <span>Auto-restart the agent if it crashes</span>
              </label>
            </div>
          )}
        </div>

        {/* ─── Display name (placed last per UX request) ─────────── */}
        <label className="border-edge-default flex flex-col gap-1 border-t pt-4 text-xs">
          <span className="text-fg-muted">
            Display name <span className="text-fg-subtle">(optional)</span>
          </span>
          <Input
            value={form.displayName}
            onChange={(e) =>
              setForm((p) => ({ ...p, displayName: e.target.value }))
            }
            placeholder={defaultDisplayName}
            className="border-edge-default bg-surface rounded border px-2 py-1 text-sm"
          />
          <span className="text-fg-subtle text-[11px] leading-snug">
            Shown in the chat picker and external-agent list. Defaults to{' '}
            <strong>{defaultDisplayName}</strong> when left blank.
          </span>
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
export const AcpSettings: React.FC = () => {
  const profiles = useAcpProfilesStore((s) => s.profiles);
  const daemon = useAcpProfilesStore((s) => s.daemon);
  const loaded = useAcpProfilesStore((s) => s.loaded);
  const error = useAcpProfilesStore((s) => s.error);
  const refresh = useAcpProfilesStore((s) => s.refresh);

  // Host-CLI detection runs once when the section first mounts. We
  // don't expose a manual refresh because the Profile Editor is the
  // only consumer, and re-detecting on every open would slow the
  // dialog without meaningful benefit (the user would have just
  // installed a CLI; closing & re-opening Settings is enough).
  const [detectedClis, setDetectedClis] = useState<AcpAgentCliInfo[]>([]);
  useEffect(() => {
    let cancelled = false;
    listAcpAgentClis()
      .then((res) => {
        if (!cancelled) setDetectedClis(res.agents);
      })
      .catch(() => {
        // Detection failure is non-fatal — the Custom option still
        // works. Don't pop a toast; the dropdown just shows "Custom"
        // as the only entry.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<AcpAgentProfileWithRuntime | null>(
    null,
  );
  const [restarting, setRestarting] = useState(false);

  // Surface fetch errors as transient toasts so the user notices even
  // if the section isn't scrolled into view.
  useEffect(() => {
    if (error) {
      toast(error.message, { variant: 'error' });
    }
  }, [error]);

  const handleNew = useCallback(() => {
    setEditing(null);
    setEditorOpen(true);
  }, []);

  const handleEdit = useCallback((profile: AcpAgentProfileWithRuntime) => {
    setEditing(profile);
    setEditorOpen(true);
  }, []);

  const handleDelete = useCallback(
    async (profile: AcpAgentProfileWithRuntime) => {
      // Confirm before delete — profiles often have non-trivial cwd /
      // env config and re-typing them is annoying. `window.confirm`
      // matches the rest of the codebase's destructive-action UX
      // (no custom dialog primitive yet).
      if (
        !window.confirm(
          `Delete profile "${profile.displayName}"? Threads bound to it will fall back to the built-in agent.`,
        )
      ) {
        return;
      }
      try {
        await deleteAcpProfile(profile.id);
        toast('Profile deleted', { variant: 'success' });
        await refresh();
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Failed to delete profile', {
          variant: 'error',
        });
      }
    },
    [refresh],
  );

  const handleRestart = useCallback(async () => {
    setRestarting(true);
    try {
      const next = await restartAcpDaemon();
      // Pull a fresh snapshot so the banner reflects the new state
      // (and the profile-list runtime flags update).
      await refresh();
      if (next.online) {
        toast('Worker restarted', { variant: 'success' });
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to restart worker', {
        variant: 'error',
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
      <DaemonHealthBanner
        daemon={daemon}
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
              <SettingRow
                key={profile.id}
                title={profile.displayName}
                description={
                  profile.runtime.spawned
                    ? `running · pid ${profile.runtime.pid ?? '?'}`
                    : `idle · ${profile.command}`
                }
              >
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
                    onClick={() => void handleDelete(profile)}
                  >
                    <Trash2 size={12} />
                  </Button>
                </div>
              </SettingRow>
            ))}
            <SettingRow
              title="Add another agent"
              description="Configure a new external CLI to bind chats to."
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
    </>
  );
};
