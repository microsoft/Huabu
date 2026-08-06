// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Chat session descriptor.
 *
 * Identifies *which* conversation a Chat renderer is showing. Everything a
 * renderer needs to address its own thread lives here, so nothing has to ask
 * the store "what is the current thread" — a question with no answer once the
 * Preview Workspace can mount two Chat renderers side by side.
 *
 * Hooks take the session explicitly. Components deep in the message tree read
 * it from context, because threading a prop through every renderer between the
 * panel root and a tool-call source card would be noise.
 */

import { createContext, useContext } from 'react';

import type { AgentConversationView } from '@huabu/shared';

export interface ChatSession {
  /** The thread this renderer reads from and writes to. */
  threadId: string;
  /** The Canvas the renderer is mounted in. */
  canvasId: string;
  /**
   * The Canvas that owns the conversation. Differs from `canvasId` when a
   * World reference presents a conversation owned by its source Canvas.
   */
  ownerCanvasId: string;
  /**
   * The Question-node conversation being shown, or `null` for the Canvas's
   * own unbound chat.
   */
  conversationView: AgentConversationView | null;
}

const ChatSessionContext = createContext<ChatSession | null>(null);

export const ChatSessionProvider = ChatSessionContext.Provider;

/**
 * Read the session of the enclosing Chat renderer. Throws outside a provider
 * rather than falling back to a global, so a renderer that forgets to supply
 * one fails loudly instead of silently rendering another thread.
 */
export function useChatSession(): ChatSession {
  const session = useContext(ChatSessionContext);
  if (!session) {
    throw new Error('useChatSession must be used inside a ChatSessionProvider');
  }
  return session;
}
