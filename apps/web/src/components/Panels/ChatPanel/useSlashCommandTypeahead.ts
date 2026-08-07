// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * `useSlashCommandTypeahead` — encapsulates everything ChatInput needs
 * to wire the slash-command typeahead to its textarea:
 *
 *   - Caret + dismiss state (so the menu doesn't pop back open after Esc).
 *   - Activation parsing (does `/<token>` apply at the current caret?).
 *   - Rising-edge intent firing (to let the data hook lazy-refresh).
 *   - Keyboard interception (Arrows / Tab / Enter / Esc) with a
 *     "consumed?" return so the caller can decide whether to fall
 *     through to its own history-nav and submit logic.
 *   - Insertion of the chosen command back into the textarea.
 *
 * The hook owns nothing the menu component cares about beyond the
 * imperative ref it forwards; everything else stays inside the hook
 * or is returned as a tiny prop bag for the menu element.
 *
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react';

import type { SlashCommandMenuRef } from './SlashCommandMenu';
import type { AvailableCommand } from '@huabu/shared';

export interface UseSlashCommandTypeaheadOptions {
  /** Current textarea value. */
  value: string;
  /** Setter the hook calls when accepting a command rewrites the value. */
  onChange: (next: string) => void;
  /** Ref to the textarea. Used for caret reads + post-accept focus. */
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  /**
   * Slash commands the agent advertised. Empty arrays simply suppress
   * the menu — the hook still fires `onSlashMenuIntent` so a missed
   * push can recover the moment the user signals intent.
   */
  slashCommands: AvailableCommand[];
  /**
   * True while the command list is being (re)fetched. When the list
   * is still empty but a fetch is in flight, the menu stays open in a
   * loading state instead of being suppressed — so the user gets a
   * "commands are coming" affordance on a cold spawn rather than
   * silence that reads as "this feature doesn't exist".
   */
  loading?: boolean;
  /**
   * Fired on the rising edge of "user wants the slash menu". The
   * data hook can decide via its own TTL gate whether to actually
   * re-fetch; this fires liberally and is cheap to debounce.
   */
  onSlashMenuIntent?: () => void;
}

export interface UseSlashCommandTypeaheadResult {
  /**
   * When non-null, the menu should render. `filter` is the text
   * after the leading `/` (empty string means "show everything");
   * `loading` is true when we're showing the menu purely as a
   * cold-spawn loading affordance (no commands yet).
   */
  slashState: { filter: string; loading: boolean } | null;
  /** Ref to attach to `<SlashCommandMenu>`. */
  slashMenuRef: RefObject<SlashCommandMenuRef | null>;
  /** Pass to `<SlashCommandMenu onSelect>`. */
  acceptSlashCommand: (command: AvailableCommand) => void;
  /**
   * Call FIRST inside the textarea's `onKeyDown`. Returns `true`
   * when the event was consumed (caller should `return` early).
   */
  handleKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /**
   * Refresh the internal caret tracker from the textarea. Pass to
   * `onKeyUp` / `onClick` / `onSelect`; also call from `onChange`
   * after committing the value so activation can re-evaluate.
   */
  syncCaret: () => void;
}

export function useSlashCommandTypeahead({
  value,
  onChange,
  textareaRef,
  slashCommands,
  loading = false,
  onSlashMenuIntent,
}: UseSlashCommandTypeaheadOptions): UseSlashCommandTypeaheadResult {
  const slashMenuRef = useRef<SlashCommandMenuRef | null>(null);

  // Esc-dismiss is keyed by the literal `/<token>` the user dismissed
  // for, so typing a different command after Esc re-opens the menu
  // (vs. requiring an explicit interaction).
  const [slashDismissedFor, setSlashDismissedFor] = useState<string | null>(
    null,
  );
  const [caretPos, setCaretPos] = useState(0);

  /**
   * "User wants the slash menu" — computed independently of whether
   * `slashCommands` is currently populated. We need this split so
   * the lazy-refresh effect still fires when the cached list is
   * empty (otherwise a missed push could never recover via user
   * interaction). True iff:
   *   - Value starts with `/` followed by an ASCII letter (so paths
   *     like `/path/to/x` stay treated as plain text), AND
   *   - Caret sits at or before the first whitespace, AND
   *   - Esc-dismissal hasn't been applied for the same literal token.
   */
  const wantsSlashMenu = useMemo(() => {
    if (!value.startsWith('/')) return false;
    const firstSpace = value.search(/\s/);
    const tokenEnd = firstSpace === -1 ? value.length : firstSpace;
    if (caretPos > tokenEnd) return false;
    const filter = value.slice(1, tokenEnd);
    if (filter.length > 0 && !/^[a-zA-Z]/.test(filter)) return false;
    if (slashDismissedFor === filter) return false;
    return true;
  }, [value, caretPos, slashDismissedFor]);

  /**
   * Adds the "non-empty command cache OR a fetch in flight" gate on
   * top of `wantsSlashMenu`. The popover is suppressed only when
   * there's nothing to show AND nothing being fetched — so a cold
   * spawn (empty list, loading) still shows a loading affordance
   * instead of silence.
   */
  const slashState = useMemo<{
    filter: string;
    loading: boolean;
  } | null>(() => {
    if (!wantsSlashMenu) return null;
    const isLoading = slashCommands.length === 0 && loading;
    if (slashCommands.length === 0 && !loading) return null;
    const firstSpace = value.search(/\s/);
    const tokenEnd = firstSpace === -1 ? value.length : firstSpace;
    return { filter: value.slice(1, tokenEnd), loading: isLoading };
  }, [wantsSlashMenu, value, slashCommands.length, loading]);

  // Rising-edge intent: notify the data hook the moment the user
  // starts wanting the menu. We fire on the rising edge (not on
  // every render with wantsSlashMenu===true) so caret movement
  // inside the token doesn't spam the gate.
  useEffect(() => {
    if (wantsSlashMenu) onSlashMenuIntent?.();
  }, [wantsSlashMenu, onSlashMenuIntent]);

  // Clear the dismiss flag when the user starts a different slash
  // token (typed `/help` after dismissing `/comp`).
  useEffect(() => {
    if (slashDismissedFor === null) return;
    if (!value.startsWith(`/${slashDismissedFor}`)) {
      setSlashDismissedFor(null);
    }
  }, [value, slashDismissedFor]);

  const dismissSlashMenu = useCallback(() => {
    const firstSpace = value.search(/\s/);
    const tokenEnd = firstSpace === -1 ? value.length : firstSpace;
    const token = value.startsWith('/') ? value.slice(1, tokenEnd) : '';
    setSlashDismissedFor(token);
  }, [value]);

  /**
   * Replace the leading `/<token>` segment with `/<name> `. Caret
   * lands right after the trailing space so the user can start
   * typing arguments. Never mutates non-slash content.
   */
  const acceptSlashCommand = useCallback(
    (command: AvailableCommand) => {
      const firstSpace = value.search(/\s/);
      const tokenEnd = firstSpace === -1 ? value.length : firstSpace;
      const rest = value.slice(tokenEnd);
      const replacement = `/${command.name} `;
      const next = replacement + rest.replace(/^\s+/, '');
      onChange(next);
      // Restore focus + place caret right after the inserted `/name `.
      requestAnimationFrame(() => {
        const ta = textareaRef.current;
        if (!ta) return;
        ta.focus();
        const pos = replacement.length;
        ta.selectionStart = pos;
        ta.selectionEnd = pos;
        setCaretPos(pos);
      });
      setSlashDismissedFor(null);
    },
    [value, onChange, textareaRef],
  );

  const syncCaret = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    setCaretPos(ta.selectionStart ?? 0);
  }, [textareaRef]);

  /**
   * Keyboard contract while the menu is open:
   *   - ArrowUp / ArrowDown — move highlight (handled by menu ref).
   *   - Tab / Enter         — accept highlighted command.
   *   - Esc                 — dismiss for the current token.
   * All other keys fall through (return false).
   */
  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!slashState || !slashMenuRef.current) return false;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        slashMenuRef.current.moveHighlight(1);
        return true;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        slashMenuRef.current.moveHighlight(-1);
        return true;
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        const active = slashMenuRef.current.getActive();
        if (active) {
          e.preventDefault();
          acceptSlashCommand(active);
          return true;
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        dismissSlashMenu();
        return true;
      }
      return false;
    },
    [slashState, acceptSlashCommand, dismissSlashMenu],
  );

  return {
    slashState,
    slashMenuRef,
    acceptSlashCommand,
    handleKeyDown,
    syncCaret,
  };
}
