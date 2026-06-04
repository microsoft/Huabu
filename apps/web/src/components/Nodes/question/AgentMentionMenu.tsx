/**
 * `AgentMentionMenu` — typeahead popover anchored to a QuestionNode's
 * textarea. Activates when the input starts with `@` so the user can
 * pick which agent should handle the question.
 *
 * Option list (in order):
 *   1. `@Chat`  → built-in agent, mode='ask' (default).
 *   2. `@Agent` → built-in agent, mode='operate'.
 *   3. `@<displayName>` for every configured external-agent profile.
 *
 * Filter rule: case-insensitive `startsWith` on the display alias,
 * then `includes` as a fallback. Selecting an item is the parent's
 * responsibility (it must rewrite the textarea and persist the binding).
 *
 * Keyboard contract is owned by the parent (`QuestionNode`):
 *   - ArrowUp / ArrowDown — move highlight (wraps).
 *   - Tab / Enter         — accept highlighted option.
 *   - Esc                 — close (parent suppresses for current token).
 */

import { MessageSquare, Route, Sprout } from 'lucide-react';
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';

import type { AcpAgentProfileWithRuntime, AgentMode } from '@sediment/shared';

/**
 * One entry surfaced in the mention menu. Internal options expose the
 * built-in agent under two display modes (`ask`, `operate`); external
 * options wrap a single user-configured profile.
 */
export type AgentMentionOption =
  | {
      kind: 'internal';
      /** Alias the user types to filter (`Chat` / `Agent`). */
      alias: string;
      description: string;
      mode: AgentMode;
    }
  | {
      kind: 'external';
      alias: string;
      description: string;
      profileId: string;
    };

export interface AgentMentionMenuRef {
  /** Currently-highlighted option, or null when filtered list is empty. */
  getActive: () => AgentMentionOption | null;
  /** Move highlight by ±1, wrapping at both ends. */
  moveHighlight: (delta: 1 | -1) => void;
}

export interface AgentMentionMenuProps {
  /** Configured external-agent profiles from `useAcpProfiles`. */
  profiles: AcpAgentProfileWithRuntime[];
  /** Substring typed after the leading `@`. Empty = show everything. */
  filter: string;
  /** Triggered on click or keyboard accept. */
  onSelect: (option: AgentMentionOption) => void;
}

/**
 * Build the full option list. Internal modes always lead so they remain
 * one keystroke away even when many profiles are configured.
 */
function buildOptions(
  profiles: AcpAgentProfileWithRuntime[],
): AgentMentionOption[] {
  const internal: AgentMentionOption[] = [
    {
      kind: 'internal',
      alias: 'Chat',
      description: 'Huabu built-in (ask)',
      mode: 'ask',
    },
    {
      kind: 'internal',
      alias: 'Agent',
      description: 'Huabu built-in (operate)',
      mode: 'operate',
    },
  ];
  const external: AgentMentionOption[] = profiles.map((profile) => ({
    kind: 'external' as const,
    alias: profile.displayName,
    description: profile.runtime.spawned
      ? `running · pid ${profile.runtime.pid ?? '?'}`
      : 'idle — spawns on first message',
    profileId: profile.id,
  }));
  return [...internal, ...external];
}

/**
 * Case-insensitive prefix match, then substring fallback. Stable sort
 * preserves the input order within each bucket.
 */
function filterOptions(
  options: AgentMentionOption[],
  filter: string,
): AgentMentionOption[] {
  if (!filter) return options;
  const needle = filter.toLowerCase();
  const startsWith: AgentMentionOption[] = [];
  const includes: AgentMentionOption[] = [];
  for (const opt of options) {
    const alias = opt.alias.toLowerCase();
    if (alias.startsWith(needle)) startsWith.push(opt);
    else if (alias.includes(needle)) includes.push(opt);
  }
  return [...startsWith, ...includes];
}

/** Returns the lucide icon to render for the given option. */
function OptionIcon({ option }: { option: AgentMentionOption }) {
  if (option.kind === 'external') return <Route size={14} />;
  return option.mode === 'operate' ? (
    <Sprout size={14} />
  ) : (
    <MessageSquare size={14} />
  );
}

export const AgentMentionMenu = forwardRef<
  AgentMentionMenuRef,
  AgentMentionMenuProps
>(({ profiles, filter, onSelect }, ref) => {
  const options = useMemo(() => buildOptions(profiles), [profiles]);
  const filtered = useMemo(
    () => filterOptions(options, filter),
    [options, filter],
  );

  const [highlight, setHighlight] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  // True iff the most recent highlight change came from keyboard
  // navigation; mouse hover should not scroll the list out from under
  // the user's pointer.
  const shouldScrollRef = useRef(false);

  const clampedHighlight = Math.min(
    highlight,
    Math.max(filtered.length - 1, 0),
  );

  useImperativeHandle(
    ref,
    () => ({
      getActive: () => filtered[clampedHighlight] ?? null,
      moveHighlight: (delta) => {
        if (filtered.length === 0) return;
        shouldScrollRef.current = true;
        setHighlight((prev) => {
          const base = Math.min(prev, filtered.length - 1);
          return (base + delta + filtered.length) % filtered.length;
        });
      },
    }),
    [filtered, clampedHighlight],
  );

  // Reset highlight to top whenever the filter narrows the list — keeps
  // the first match selected so hitting Enter immediately picks it.
  useEffect(() => {
    setHighlight(0);
  }, [filter, profiles]);

  // Keyboard-driven highlight changes scroll the active row into view.
  useEffect(() => {
    if (!shouldScrollRef.current) return;
    shouldScrollRef.current = false;
    const list = listRef.current;
    if (!list) return;
    const item = list.children[clampedHighlight] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest' });
  }, [clampedHighlight]);

  if (filtered.length === 0) return null;

  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label="Mention agent"
      // Anchored *below* the question textarea. The selected node also
      // renders a `NodeFloatingToolbar` immediately above it (side="top",
      // offset 12) — dropping the menu downward avoids overlapping that
      // toolbar. `allowOverflow` on NodeWrapper lets it escape node bounds.
      className="border-edge-default bg-surface absolute top-full right-0 left-0 z-50 mt-2 max-h-64 overflow-y-auto rounded-lg border shadow-lg"
    >
      {filtered.map((opt, idx) => {
        const isActive = idx === clampedHighlight;
        return (
          <button
            key={`${opt.kind}:${opt.alias}`}
            type="button"
            role="option"
            aria-selected={isActive}
            onMouseDown={(e) => {
              // Stop the textarea from losing focus before onClick fires.
              e.preventDefault();
            }}
            onClick={() => onSelect(opt)}
            onMouseEnter={() => {
              shouldScrollRef.current = false;
              setHighlight(idx);
            }}
            className={`flex w-full items-center gap-2 px-3 py-2 text-left transition-colors ${
              isActive
                ? 'bg-hover text-fg-default'
                : 'text-fg-default hover:bg-hover'
            }`}
          >
            <span className="text-fg-muted shrink-0">
              <OptionIcon option={opt} />
            </span>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm font-medium">@{opt.alias}</span>
              <span className="text-fg-subtle truncate text-xs">
                {opt.description}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
});

AgentMentionMenu.displayName = 'AgentMentionMenu';
