// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import {
  isAgentWorkingDirectory,
  MAX_AGENT_WORKING_DIR_PATH_LENGTH,
} from '@huabu/shared/agent-working-directory';

import { desktopSpaceStorage } from '@/utils/desktopStorage';

import { rememberConversationAgentBinding } from './acpProfilesStore';
import useCanvasStore from './canvasStore';
import {
  selectThreadBinding,
  selectThreadIsLoading,
  selectThreadMessages,
  useChatStore,
} from './chatStore';
import {
  awaitConversationDraft,
  resolveConversationAgentBinding,
  resolveConversationOwnerSource,
  saveConversationWorkingDirectoryOverride,
  saveConversationDraft,
} from './conversationOwner';

import type { ChatSession } from '@/hooks/useChatSession';
import type {
  AcpThreadCachedMetaResponse,
  AgentBinding,
  AgentIcon,
  AgentMode,
  ExternalAgentInteractionTarget,
} from '@huabu/shared';

type Execution = NonNullable<AcpThreadCachedMetaResponse['execution']>;

interface PreparationState {
  /** Browser intent until the canonical workload captures it. */
  directories: Record<string, string>;
  executions: Record<string, Execution | undefined>;
  pending: Record<string, boolean>;
  queuedControls: Record<string, number>;
  revisions: Record<string, number>;
  /** An ambiguous request stays locked until a successful cache read. */
  locked: Record<string, boolean | undefined>;
}

export const preparationKey = (session: ChatSession) =>
  JSON.stringify([session.ownerCanvasId, session.threadId]);

export const useConversationPreparationStore = create<PreparationState>()(
  persist(
    () => ({
      directories: {},
      executions: {},
      pending: {},
      queuedControls: {},
      locked: {},
      revisions: {},
    }),
    {
      name: 'huabu-conversation-preparation',
      storage: createJSONStorage(desktopSpaceStorage),
      partialize: ({ directories }) => ({ directories }),
      merge: (persisted, current) => {
        const raw = (persisted as Partial<PreparationState> | undefined)
          ?.directories;
        const directories: Record<string, string> = {};
        for (const [key, value] of Object.entries(raw ?? {})) {
          if (isAgentWorkingDirectory(value)) directories[key] = value;
          else console.warn('Invalid saved conversation directory:', key);
        }
        return { ...current, directories };
      },
    },
  ),
);

export function resolveConversationPreparation(
  session: ChatSession,
  state = useConversationPreparationStore.getState(),
) {
  const canvas = useCanvasStore.getState();
  const source = resolveConversationOwnerSource(
    canvas.canvasId,
    canvas.nodes,
    session.conversationView,
  );
  const chat = useChatStore.getState();
  const key = preparationKey(session);
  const execution = state.executions[key];
  const directoryIntent = session.conversationView
    ? source?.agentLaunchOverrides?.workingDirPath
    : state.directories[key];
  const pending = !!state.pending[key] || (state.queuedControls[key] ?? 0) > 0;
  const binding: AgentBinding =
    execution?.binding ??
    resolveConversationAgentBinding(
      source,
      selectThreadBinding(chat, session.threadId),
    );
  const editable =
    !execution &&
    (binding.kind === 'internal' || state.locked[key] === false) &&
    !pending &&
    !selectThreadIsLoading(chat, session.threadId) &&
    (session.conversationView
      ? !!source &&
        source.agentBindingPolicy !== 'fixed' &&
        source.bindingState !== 'bound'
      : !selectThreadMessages(chat, session.threadId).some(
          (message) => message.role === 'user',
        ));
  return {
    binding,
    realized: !!execution,
    editable,
    ready:
      binding.kind === 'internal' || !!execution || state.locked[key] === false,
    pending,
    workingDirPath: execution ? execution.workingDirPath : directoryIntent,
    workingDirectoryOverride: execution
      ? (execution.workingDirectoryOverride ?? undefined)
      : directoryIntent,
    workingDirectorySource: execution
      ? execution.workingDirectoryOverride === undefined
        ? ('unknown' as const)
        : execution.workingDirectoryOverride === null
          ? ('profile' as const)
          : ('override' as const)
      : directoryIntent
        ? ('override' as const)
        : ('profile' as const),
  };
}

export function observeConversationExecution(
  canvasId: string,
  threadId: string,
  execution: AcpThreadCachedMetaResponse['execution'],
  revision?: number,
) {
  const key = JSON.stringify([canvasId, threadId]);
  useConversationPreparationStore.setState((state) => {
    if (revision !== undefined && revision !== (state.revisions[key] ?? 0))
      return state;
    const executions = { ...state.executions };
    if (execution) executions[key] = execution;
    else delete executions[key];
    return {
      executions,
      locked: {
        ...state.locked,
        [key]: execution
          ? true
          : state.pending[key]
            ? state.locked[key]
            : false,
      },
    };
  });
}

export function createConversation(options: {
  canvasId: string;
  binding: AgentBinding;
  mode?: AgentMode;
}): string {
  const threadId = useChatStore.getState().createThread({
    binding: options.binding,
    lastAction: options.mode,
  });
  observeConversationExecution(options.canvasId, threadId, undefined);
  return threadId;
}

export async function saveConversationWorkingDirectory(
  session: ChatSession,
  value: string | null,
): Promise<void> {
  const preparation = resolveConversationPreparation(session);
  if (!preparation.editable || preparation.binding.kind !== 'external') {
    throw new Error('Conversation execution settings are locked');
  }

  const path = value === null ? null : value.trim();
  if (path !== null && !isAgentWorkingDirectory(path)) {
    throw new Error(
      `Working directory must be an absolute path no longer than ${MAX_AGENT_WORKING_DIR_PATH_LENGTH} characters`,
    );
  }
  if (session.conversationView) {
    const key = preparationKey(session);
    useConversationPreparationStore.setState((state) => ({
      pending: { ...state.pending, [key]: true },
    }));
    try {
      await saveConversationWorkingDirectoryOverride(
        session.conversationView,
        path,
      );
    } finally {
      useConversationPreparationStore.setState((state) => ({
        pending: { ...state.pending, [key]: false },
      }));
    }
    return;
  }
  const key = preparationKey(session);
  useConversationPreparationStore.setState((state) => {
    const directories = { ...state.directories };
    if (path) directories[key] = path;
    else delete directories[key];
    return { directories };
  });
}

export async function saveConversationAgent(
  session: ChatSession,
  choice: { binding: AgentBinding; mode: AgentMode; icon?: AgentIcon },
): Promise<void> {
  if (!resolveConversationPreparation(session).editable) {
    throw new Error('Conversation execution settings are locked');
  }
  const key = preparationKey(session);
  useConversationPreparationStore.setState((state) => ({
    pending: { ...state.pending, [key]: true },
  }));
  try {
    const chat = useChatStore.getState();
    if (session.conversationView) {
      await saveConversationDraft(session.conversationView, {
        agentBinding: choice.binding,
        agentMode: choice.mode,
        agentIcon: choice.icon,
      });
      chat.makeThreadMetadataEphemeral(session.threadId, {
        preserveSettings: true,
      });
    } else {
      rememberConversationAgentBinding(choice.binding);
    }
    chat.setAgentBinding(
      session.threadId,
      choice.binding,
      session.canvasId || undefined,
    );
    chat.setThreadLastAction(session.threadId, choice.mode);
  } finally {
    useConversationPreparationStore.setState((state) => ({
      pending: { ...state.pending, [key]: false },
    }));
  }
}

/** Node preparation remains server-owned; ordinary Chat carries draft intent. */
export function conversationControlTarget(
  session: ChatSession,
): ExternalAgentInteractionTarget {
  const preparation = resolveConversationPreparation(session);
  if (preparation.binding.kind !== 'external') {
    throw new Error('Conversation has no external Agent binding');
  }
  return {
    binding: preparation.binding,
    canvasId: session.ownerCanvasId,
    ...(!session.conversationView && preparation.workingDirPath
      ? { cwd: preparation.workingDirPath }
      : {}),
  };
}

const controlQueues = new Map<string, Promise<void>>();

export async function runConversationControl(
  session: ChatSession,
  control: (target: ExternalAgentInteractionTarget) => Promise<unknown>,
  refresh: () => Promise<void>,
): Promise<void> {
  const key = preparationKey(session);
  const predecessor = controlQueues.get(key);
  // Reserve the first operation synchronously so a send or draft save cannot race it.
  const firstRelease = predecessor
    ? undefined
    : beginConversationRealization(session, true);
  useConversationPreparationStore.setState((state) => ({
    queuedControls: {
      ...state.queuedControls,
      [key]: (state.queuedControls[key] ?? 0) + 1,
    },
  }));
  const operation = (predecessor ?? Promise.resolve()).then(async () => {
    const release = firstRelease ?? beginConversationRealization(session, true);
    let attempted = false;
    try {
      if (session.conversationView) {
        await awaitConversationDraft(session.conversationView);
      }
      const target = conversationControlTarget(session);
      attempted = true;
      await control(target);
    } finally {
      release(attempted);
      if (attempted) await refresh();
    }
  });
  // Failures still reject the caller; only the sequencing barrier is fulfilled.
  const settled = operation.then(
    () => {},
    () => {},
  );
  controlQueues.set(key, settled);
  try {
    await operation;
  } finally {
    if (controlQueues.get(key) === settled) controlQueues.delete(key);
    useConversationPreparationStore.setState((state) => {
      const queuedControls = { ...state.queuedControls };
      const remaining = (queuedControls[key] ?? 1) - 1;
      if (remaining > 0) queuedControls[key] = remaining;
      else delete queuedControls[key];
      return { queuedControls };
    });
  }
}

export function beginConversationRealization(
  session: ChatSession,
  allowStreaming = false,
): (attempted?: boolean) => void {
  const key = preparationKey(session);
  const store = useConversationPreparationStore;
  const wasLocked = store.getState().locked[key];
  if (
    store.getState().pending[key] ||
    (!allowStreaming && (store.getState().queuedControls[key] ?? 0) > 0) ||
    (!allowStreaming &&
      selectThreadIsLoading(useChatStore.getState(), session.threadId))
  ) {
    throw new Error('Conversation is preparing or running');
  }
  store.setState((state) => ({
    pending: { ...state.pending, [key]: true },
    locked: { ...state.locked, [key]: true },
    revisions: {
      ...state.revisions,
      [key]: (state.revisions[key] ?? 0) + 1,
    },
  }));
  return (attempted = true) => {
    store.setState((state) => ({
      pending: { ...state.pending, [key]: false },
      locked: {
        ...state.locked,
        [key]: attempted ? true : wasLocked,
      },
    }));
  };
}
