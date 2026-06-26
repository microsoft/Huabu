/**
 * Shared building blocks for the agent picker dropdown, used by both
 * `NewChatMenu` (header split-button) and `AgentSelector` (inline chip).
 *
 * The two surfaces have different triggers and different select
 * semantics (mint a new thread vs. rebind the current empty thread) but
 * render an identical option list: the built-in Chat / Agent modes, one
 * row per configured external ACP profile, and an inline "Add agent"
 * entry. This module owns that list plus the `bindingsEqual` / `INTERNAL`
 * helpers and the "Add agent" editor-modal wiring so neither caller
 * duplicates them.
 */

import { MessageSquare, Plus, Route, Sprout } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { Button } from '../../Common/Button';
import { cn } from '../../Common/cn';
import { ProfileEditorModal, useDetectedClis } from '../Header/AcpSettings';

import type {
  AcpAgentProfile,
  AgentBinding,
  AgentMode,
} from '@sediment/shared';

/** A picked (mode, binding) pair emitted by either agent menu. */
export interface AgentChoice {
  mode: AgentMode;
  binding: AgentBinding;
}

/** The built-in (Huabu) agent binding. */
export const INTERNAL_BINDING: AgentBinding = { kind: 'internal' };

export function bindingsEqual(a: AgentBinding, b: AgentBinding): boolean {
  if (a.kind === 'internal' && b.kind === 'internal') return true;
  if (a.kind === 'external' && b.kind === 'external') {
    return a.profileId === b.profileId;
  }
  return false;
}

interface AgentMenuRowProps {
  icon: ReactNode;
  label: string;
  hint?: string;
  current?: boolean;
  disabled?: boolean;
  /** Tooltip on the row — typically only set for the current row. */
  title?: string;
  onClick: () => void;
}

/** One option row in the agent dropdown. */
export function AgentMenuRow({
  icon,
  label,
  hint,
  current,
  disabled,
  title,
  onClick,
}: AgentMenuRowProps) {
  return (
    <Button
      variant="ghost"
      tone="neutral"
      size="sm"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      title={title}
      className={cn(
        'w-full justify-start gap-2 rounded-none px-3 py-1.5 text-left',
        current ? 'text-info' : 'text-fg-default',
      )}
    >
      <span className="shrink-0">{icon}</span>
      <span className="shrink-0">{label}</span>
      {hint && (
        <span className="text-fg-muted ml-auto block min-w-0 truncate pl-2 text-xs">
          {hint}
        </span>
      )}
    </Button>
  );
}

interface AgentMenuOptionsProps {
  /** Small uppercase heading shown above the rows. */
  heading: string;
  currentBinding: AgentBinding;
  currentMode: AgentMode;
  profiles: AcpAgentProfile[];
  /** Grey out every row (e.g. mid-stream) without closing the menu. */
  busy?: boolean;
  /** Tooltip applied to whichever row matches the current binding. */
  currentRowTitle?: string;
  onSelect: (choice: AgentChoice) => void;
  /** When provided, renders the inline "Add agent" row that calls this. */
  onAddAgent?: () => void;
}

/**
 * The dropdown body shared by both menus: heading, the two built-in
 * modes, the configured external profiles, and an optional "Add agent"
 * row. Pure presentation — the caller owns the surrounding `Popover`.
 */
export function AgentMenuOptions({
  heading,
  currentBinding,
  currentMode,
  profiles,
  busy,
  currentRowTitle,
  onSelect,
  onAddAgent,
}: AgentMenuOptionsProps) {
  const modeItems: { mode: AgentMode; label: string; icon: ReactNode }[] = [
    { mode: 'ask', label: 'Chat', icon: <MessageSquare size={14} /> },
    { mode: 'operate', label: 'Agent', icon: <Sprout size={14} /> },
  ];

  return (
    <>
      <div
        role="presentation"
        className="text-fg-muted px-3 pt-1.5 pb-1 text-[10px] tracking-wider uppercase select-none"
      >
        {heading}
      </div>
      {modeItems.map((m) => {
        const isCurrent =
          currentBinding.kind === 'internal' && currentMode === m.mode;
        return (
          <AgentMenuRow
            key={`mode:${m.mode}`}
            icon={m.icon}
            label={m.label}
            hint="Huabu"
            current={isCurrent}
            disabled={busy}
            title={isCurrent ? currentRowTitle : undefined}
            onClick={() =>
              onSelect({ mode: m.mode, binding: INTERNAL_BINDING })
            }
          />
        );
      })}
      {profiles.length > 0 && (
        <div
          role="presentation"
          className="text-fg-muted mt-1 flex items-center gap-2 px-3 pt-1 pb-0.5 text-[10px] tracking-wider uppercase select-none"
        >
          <span className="bg-edge-default h-px flex-1" />
          <span>External Agents</span>
          <span className="bg-edge-default h-px flex-1" />
        </div>
      )}
      {profiles.map((profile) => {
        const binding: AgentBinding = {
          kind: 'external',
          alias: profile.displayName,
          profileId: profile.id,
        };
        const isCurrent = bindingsEqual(currentBinding, binding);
        return (
          <AgentMenuRow
            key={`profile:${profile.id}`}
            icon={<Route size={14} />}
            label={profile.displayName}
            current={isCurrent}
            disabled={busy}
            title={isCurrent ? currentRowTitle : undefined}
            onClick={() => onSelect({ mode: currentMode, binding })}
          />
        );
      })}
      {onAddAgent && (
        <>
          <div
            role="presentation"
            className="bg-edge-default mt-1 h-px w-full"
          />
          <div className="px-1 py-1">
            <Button
              variant="ghost"
              tone="neutral"
              size="sm"
              onClick={onAddAgent}
              className="w-full justify-start gap-1.5 rounded px-2 py-1.5 text-left"
            >
              <Plus size={14} />
              <span className="text-xs">Add agent</span>
            </Button>
          </div>
        </>
      )}
    </>
  );
}

/**
 * Encapsulates the inline "Add agent" editor modal so both menus avoid
 * duplicating the `editorOpen` state + `ProfileEditorModal` + CLI
 * detection wiring. Returns `openEditor` (call it from the "Add agent"
 * row) and `editor` (render it at the menu's root, outside the popover
 * so it survives the popover closing). `editor` is `null` when the
 * caller did not supply `onRefreshProfiles`.
 */
export function useAddAgentEditor(
  onRefreshProfiles?: () => void | Promise<void>,
): { openEditor: () => void; editor: ReactNode } {
  const [editorOpen, setEditorOpen] = useState(false);
  // CLI detection is cheap (single cached fetch). Done eagerly so the
  // editor modal opens instantly even on a cold mount.
  const detectedClis = useDetectedClis();

  const editor = onRefreshProfiles ? (
    <ProfileEditorModal
      isOpen={editorOpen}
      editing={null}
      detectedClis={detectedClis}
      onClose={() => setEditorOpen(false)}
      onSaved={async () => {
        // Refresh the profile list so the newly-created agent appears
        // without forcing the user to open Settings or reload.
        await onRefreshProfiles();
      }}
    />
  ) : null;

  return { openEditor: () => setEditorOpen(true), editor };
}
