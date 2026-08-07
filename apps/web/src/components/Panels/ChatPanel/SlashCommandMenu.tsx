// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * `SlashCommandMenu` — typeahead popover anchored above the chat textarea
 * for agent-defined slash commands.
 *
 * Activates only when the textarea content starts with `/` AND the caret
 * sits within the first whitespace-delimited token. The menu lists the
 * commands the bound external agent advertised via
 * `available_commands_update`, filtered by the typed prefix.
 *
 * Keyboard contract (owned by `ChatInput`, dispatched here):
 *   - ArrowUp / ArrowDown — move highlight (wraps).
 *   - Tab / Enter         — accept highlighted command.
 *   - Esc                 — close the menu (caller retains the leading `/`).
 *
 * The popover is positioned above the input (anchor.top - menuHeight)
 * because the chat input sits at the bottom of the panel; dropping the
 * menu downward would push it off-screen.
 */

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';

import type { AvailableCommand } from '@huabu/shared';

export interface SlashCommandMenuRef {
  /** Returns the currently-highlighted command, or null when list is empty. */
  getActive: () => AvailableCommand | null;
  /** Move highlight by ±1, wrapping at both ends. */
  moveHighlight: (delta: 1 | -1) => void;
}

export interface SlashCommandMenuProps {
  /** Full command list from `useAcpSlashCommands`. */
  commands: AvailableCommand[];
  /** Text typed after the leading `/`. Empty string means show everything. */
  filter: string;
  /** Fired when the user clicks a command (caller inserts it into the input). */
  onSelect: (command: AvailableCommand) => void;
  /**
   * True when the command list is empty because a fetch is still in
   * flight (cold agent spawn). Renders a loading row instead of
   * collapsing the popover, so the user knows commands are on the way.
   */
  loading?: boolean;
}

/**
 * Filter `commands` by `filter`. Match rule: case-insensitive
 * `startsWith` on `name`, then `includes` as a fallback so users who
 * remember a substring still get hits. Stable sort: matches that
 * start-with come first.
 */
function filterCommands(
  commands: AvailableCommand[],
  filter: string,
): AvailableCommand[] {
  if (!filter) return commands;
  const needle = filter.toLowerCase();
  const startsWith: AvailableCommand[] = [];
  const includes: AvailableCommand[] = [];
  for (const cmd of commands) {
    const name = cmd.name.toLowerCase();
    if (name.startsWith(needle)) startsWith.push(cmd);
    else if (name.includes(needle)) includes.push(cmd);
  }
  return [...startsWith, ...includes];
}

export const SlashCommandMenu = forwardRef<
  SlashCommandMenuRef,
  SlashCommandMenuProps
>(({ commands, filter, onSelect, loading = false }, ref) => {
  const { t } = useTranslation();
  const filtered = useMemo(
    () => filterCommands(commands, filter),
    [commands, filter],
  );
  const [highlight, setHighlight] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  // Tracks whether the latest highlight change came from the keyboard.
  // We only call scrollIntoView for keyboard moves; mouse hover should
  // never scroll the list out from under the user's pointer.
  const shouldScrollRef = useRef(false);

  // Clamp highlight when the filter changes (filtered list shrinks).
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
          // Add filtered.length before modulo so negative deltas wrap.
          return (base + delta + filtered.length) % filtered.length;
        });
      },
    }),
    [filtered, clampedHighlight],
  );

  // Keep the highlighted row in view on keyboard navigation. `block:
  // 'nearest'` is a no-op when the row is already visible, so this is
  // cheap. We gate on `shouldScrollRef` so mouse-driven highlight
  // changes (which happen because the user moved their cursor to a
  // visible row) never trigger a scroll.
  useEffect(() => {
    if (!shouldScrollRef.current) return;
    shouldScrollRef.current = false;
    const list = listRef.current;
    if (!list) return;
    const item = list.children[clampedHighlight] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest' });
  }, [clampedHighlight]);

  if (filtered.length === 0) {
    // Cold-spawn affordance: the agent session is still booting and
    // the command list hasn't landed. Show a loading row so the user
    // knows the feature exists and commands are on the way, instead
    // of collapsing the popover into silence.
    if (loading) {
      return (
        <div
          role="listbox"
          aria-label={t('chat.slashCommands')}
          aria-busy="true"
          className="border-edge-default bg-surface absolute right-0 bottom-full left-0 z-50 mb-2 rounded-lg border shadow-lg"
        >
          <div className="text-fg-muted flex items-center gap-2 px-3 py-2.5 text-xs">
            <span
              aria-hidden
              className="border-edge-default border-t-fg-muted size-3.5 animate-spin rounded-full border-2"
            />
            {t('chat.loadingCommands')}
          </div>
        </div>
      );
    }
    return null;
  }

  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label={t('chat.slashCommands')}
      className="border-edge-default bg-surface absolute right-0 bottom-full left-0 z-50 mb-2 max-h-64 overflow-y-auto rounded-lg border shadow-lg"
    >
      {filtered.map((cmd, idx) => {
        const isActive = idx === clampedHighlight;
        return (
          <button
            key={cmd.name}
            type="button"
            role="option"
            aria-selected={isActive}
            onMouseDown={(e) => {
              // Prevent the textarea from losing focus before onClick fires.
              e.preventDefault();
            }}
            onClick={() => onSelect(cmd)}
            onMouseEnter={() => {
              shouldScrollRef.current = false;
              setHighlight(idx);
            }}
            className={`flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left transition-colors ${
              isActive
                ? 'bg-hover text-fg-default'
                : 'text-fg-default hover:bg-hover'
            }`}
          >
            <div className="flex w-full items-baseline gap-2">
              <span className="font-mono text-xs font-medium">/{cmd.name}</span>
              {cmd.input?.hint && (
                <span className="text-fg-subtle truncate text-xs">
                  {cmd.input.hint}
                </span>
              )}
            </div>
            {cmd.description && (
              <span className="text-fg-muted line-clamp-2 text-xs">
                {cmd.description}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
});

SlashCommandMenu.displayName = 'SlashCommandMenu';
