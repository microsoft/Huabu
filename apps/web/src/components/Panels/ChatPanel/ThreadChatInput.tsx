// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { X } from 'lucide-react';
import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/Common/Button';
import { UserMessage } from '@/components/Messages/UserMessage';
import {
  createAgentTurnUserMessage,
  resumeAgentTurnQueue,
} from '@/hooks/agentTurnController';
import { useChatSession } from '@/hooks/useChatSession';
import {
  selectThreadDraft,
  selectThreadQueuedTurns,
  useChatStore,
} from '@/store/chatStore';

import { ChatInput, type ChatInputProps } from './ChatInput';

import type { AgentMode } from '@huabu/shared';

interface ThreadChatInputProps extends Omit<
  ChatInputProps,
  'value' | 'onChange' | 'onSubmit'
> {
  onSubmit: (event: React.FormEvent, mode: AgentMode, draft: string) => void;
}

export function ThreadChatInput({ onSubmit, ...props }: ThreadChatInputProps) {
  const session = useChatSession();
  const { threadId } = session;
  const { t } = useTranslation();
  const preparing = useChatStore(
    (state) => state.threadsById[threadId]?.isPreparing ?? false,
  );
  const queuedTurns = useChatStore((state) =>
    selectThreadQueuedTurns(state, threadId),
  );
  const queuedMessages = useMemo(
    () =>
      queuedTurns.map((turn) => ({
        ...turn,
        message: createAgentTurnUserMessage(turn.prepared),
      })),
    [queuedTurns],
  );
  const paused = useChatStore(
    (state) => state.threadsById[threadId]?.queuePaused ?? false,
  );
  const removeQueuedTurn = useChatStore((state) => state.removeQueuedTurn);
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
    <>
      {queuedTurns.length > 0 ? (
        <section
          className="mb-2 min-w-0 px-3 text-xs"
          aria-label={t('chat.queuedMessages')}
        >
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="text-fg-muted" role="status">
              {t(paused ? 'chat.queuePaused' : 'chat.queueCount', {
                count: queuedTurns.length,
              })}
            </span>
            {paused ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={
                  props.isStreaming ||
                  preparing ||
                  props.disabled ||
                  props.submitDisabled ||
                  queuedTurns[0].status !== 'pending'
                }
                onClick={() => resumeAgentTurnQueue(session)}
              >
                {t('chat.resumeQueue')}
              </Button>
            ) : null}
          </div>
          <ol className="max-h-60 overflow-y-auto overscroll-contain px-2 pt-2">
            {queuedMessages.map((turn) => (
              <li
                key={turn.id}
                className="group/queued-message relative min-w-0"
              >
                <div className="min-w-0">
                  <UserMessage {...turn.message} isFirst />
                  {turn.status !== 'pending' ? (
                    <p className="text-fg-muted mb-2 text-right" role="status">
                      {t(
                        turn.status === 'uncertain'
                          ? 'chat.queueUncertain'
                          : 'chat.queueSending',
                      )}
                    </p>
                  ) : null}
                </div>
                <div className="pointer-events-none absolute -top-2 -right-2 z-10 opacity-0 transition-opacity group-focus-within/queued-message:pointer-events-auto group-focus-within/queued-message:opacity-100 group-hover/queued-message:pointer-events-auto group-hover/queued-message:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100">
                  <Button
                    variant="ghost"
                    size="sm"
                    iconOnly
                    shape="pill"
                    className="bg-hover focus-visible:ring-info enabled:hover:bg-edge-default focus-visible:ring-1"
                    title={t('chat.removeFromQueue')}
                    disabled={turn.status !== 'pending'}
                    onClick={() => {
                      removeQueuedTurn(threadId, turn.id);
                      props.onCommit?.();
                    }}
                  >
                    <X aria-hidden="true" />
                  </Button>
                </div>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      <ChatInput
        {...props}
        isStreaming={
          props.isStreaming ||
          preparing ||
          queuedTurns.some((turn) => turn.status !== 'pending')
        }
        queueSubmission={
          props.isStreaming || preparing || queuedTurns.length > 0
        }
        value={draft}
        onChange={handleChange}
        onSubmit={handleSubmit}
      />
    </>
  );
}
