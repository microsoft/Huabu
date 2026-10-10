// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useChatSession } from '@/hooks/useChatSession';
import useCanvasStore from '@/store/canvasStore';
import {
  selectThreadPendingAttachments,
  useChatStore,
} from '@/store/chatStore';

import type { KeyboardEvent, RefObject } from 'react';

export function parseNodeMention(value: string, start: number, end = start) {
  if (start !== end || start < 0 || start > value.length) return null;
  const match =
    /(?:^|[\s([{"'，。！？：；、（【])@([^\s@,，。！？：；、()[\]{}]*)$/u.exec(
      value.slice(0, start),
    );
  if (!match) return null;
  const query = match[1];
  const tokenStart = start - query.length - 1;
  const suffix =
    /^[^\s@,，。！？：；、()[\]{}]*/u.exec(value.slice(start))?.[0] ?? '';
  return { start: tokenStart, end: start + suffix.length, query };
}

export function useNodeMentionTypeahead({
  value,
  onChange,
  onCommit,
  textareaRef,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  onCommit?: () => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const { canvasId, threadId } = useChatSession();
  const activeCanvasId = useCanvasStore((state) => state.canvasId);
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const [focused, setFocused] = useState(false);
  const [composing, setComposing] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [highlight, setHighlight] = useState({ queryKey: '', index: 0 });
  const menuId = useId();
  const token = parseNodeMention(value, selection.start, selection.end);
  const queryKey = JSON.stringify([
    threadId,
    value,
    selection.start,
    selection.end,
  ]);
  const open =
    !disabled &&
    focused &&
    !composing &&
    !!canvasId &&
    activeCanvasId === canvasId &&
    !!token &&
    dismissed !== queryKey;
  const query = token?.query ?? '';
  const nodes = useCanvasStore((state) => (open ? state.nodes : null));
  const matches = useMemo(() => {
    if (!nodes) return [];
    const needle = query.toLocaleLowerCase();
    const prefixes: { node: (typeof nodes)[number]; label: string }[] = [];
    const substrings: typeof prefixes = [];
    for (const node of nodes) {
      const label =
        typeof node.data.label === 'string' && node.data.label.trim()
          ? node.data.label
          : t('node.untitled');
      const normalized = label.toLocaleLowerCase();
      if (normalized.startsWith(needle)) prefixes.push({ node, label });
      else if (normalized.includes(needle)) substrings.push({ node, label });
    }
    return prefixes.concat(substrings);
  }, [nodes, query, t]);
  const activeIndex = Math.min(
    highlight.queryKey === queryKey ? highlight.index : 0,
    Math.max(0, matches.length - 1),
  );

  function syncCaret() {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    setSelection((previous) =>
      previous.start === start && previous.end === end
        ? previous
        : { start, end },
    );
  }

  function accept(index: number) {
    const item = matches[index];
    if (!item || !token) return;
    const { node, label } = item;
    const state = useChatStore.getState();
    if (
      !selectThreadPendingAttachments(state, threadId).some(
        (attachment) =>
          attachment.originNodeId === node.id &&
          !attachment.content &&
          !attachment.url,
      )
    ) {
      state.addPendingAttachment(threadId, {
        type: 'text',
        source: 'selection',
        originNodeId: node.id,
        label,
      });
    }
    const replacement = `@${label} `;
    const next =
      value.slice(0, token.start) +
      replacement +
      value.slice(token.end).replace(/^ /, '');
    const caret = token.start + replacement.length;
    onChange(next);
    onCommit?.();
    setDismissed(queryKey);
    setSelection({ start: caret, end: caret });
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus({ preventScroll: true });
      textarea.setSelectionRange(caret, caret);
    });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      !open ||
      event.nativeEvent.isComposing ||
      event.nativeEvent.keyCode === 229
    )
      return false;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setDismissed(queryKey);
      return true;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (matches.length) {
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        setHighlight({
          queryKey,
          index: (activeIndex + delta + matches.length) % matches.length,
        });
      }
      return true;
    }
    if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
      if (event.key === 'Tab' && (event.shiftKey || !matches.length)) {
        setDismissed(queryKey);
        return false;
      }
      event.preventDefault();
      if (matches.length) accept(activeIndex);
      return true;
    }
    return false;
  }

  return {
    open,
    query,
    matches,
    activeIndex,
    menuId,
    activeOptionId:
      open && matches.length ? `${menuId}-${activeIndex}` : undefined,
    accept,
    handleKeyDown,
    syncCaret,
    onFocus: () => {
      setFocused(true);
      syncCaret();
    },
    onBlur: () => setFocused(false),
    onCompositionStart: () => setComposing(true),
    onCompositionEnd: () => {
      setComposing(false);
      syncCaret();
    },
    highlight: (index: number) => setHighlight({ queryKey, index }),
  };
}
