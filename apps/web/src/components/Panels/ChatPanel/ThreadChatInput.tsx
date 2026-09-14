// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useCallback } from 'react';

import { useChatSession } from '@/hooks/useChatSession';
import { selectThreadDraft, useChatStore } from '@/store/chatStore';

import { ChatInput, type ChatInputProps } from './ChatInput';

import type { AgentMode } from '@huabu/shared';

interface ThreadChatInputProps extends Omit<
  ChatInputProps,
  'value' | 'onChange' | 'onSubmit'
> {
  onSubmit: (event: React.FormEvent, mode: AgentMode, draft: string) => void;
}

export function ThreadChatInput({ onSubmit, ...props }: ThreadChatInputProps) {
  const { threadId } = useChatSession();
  const draft = useChatStore((state) => selectThreadDraft(state, threadId));
  const setDraft = useChatStore((state) => state.setDraft);
  const handleChange = useCallback(
    (text: string) => setDraft(threadId, text),
    [setDraft, threadId],
  );
  const handleSubmit = useCallback(
    (event: React.FormEvent, mode: AgentMode) => {
      onSubmit(event, mode, draft);
    },
    [draft, onSubmit],
  );

  return (
    <ChatInput
      {...props}
      value={draft}
      onChange={handleChange}
      onSubmit={handleSubmit}
    />
  );
}
