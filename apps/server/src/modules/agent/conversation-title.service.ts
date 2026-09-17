// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  conversationTitleSchema,
  setConversationTitleBodySchema,
} from '@huabu/shared';
import {
  normalizeAcpConversationTitle,
  normalizeConversationTitle,
} from '@huabu/shared/conversation-title';

import { agenetes } from './agenetes/drivers.js';
import { chatEnvelopeFromSubmission } from './agenetes/handle.js';
import {
  conversationTitleNodeStore,
  type QuestionTitleSnapshot,
} from './conversation-title-node-store.js';
import { getLogger } from '../../utils/logger.js';
import { withCanvasMutex } from '../canvas/write-coordinator.js';
import { coalesceInFlight } from '../preprocessing/coalesce.js';
import { ProviderManager } from '../preprocessing/provider-manager.js';
import { extractTitleFromText } from '../preprocessing/utils.js';
import { canvasAcpNamespace } from '../workspace/paths.js';

import type { ThreadRecord } from '@agenetes/agenetes';
import type { AgentMetadata } from '@agenetes/protocol';
import type {
  ConversationTitle,
  QueryConversationTitlesResponse,
} from '@huabu/shared';

export const CONVERSATION_TITLE_METADATA_KEY = 'huabuConversationTitle';

function storedTitle(record: ThreadRecord): ConversationTitle {
  const parsed = conversationTitleSchema.safeParse(
    record.hostMetadata?.[CONVERSATION_TITLE_METADATA_KEY],
  );
  return parsed.success ? parsed.data : { title: null, source: null };
}

function acpTitle(record: ThreadRecord): string | null {
  const saved = storedTitle(record);
  return (
    normalizeAcpConversationTitle(record.state?.metadata?.sessionInfo?.title) ??
    (saved.source === 'acp' ? normalizeAcpConversationTitle(saved.title) : null)
  );
}

export function effectiveConversationTitle(
  record?: ThreadRecord,
): ConversationTitle {
  if (!record) return { title: null, source: null };
  const saved = storedTitle(record);
  const title =
    saved.source === 'acp'
      ? normalizeAcpConversationTitle(saved.title)
      : normalizeConversationTitle(saved.title);
  if (title && (saved.source === 'user' || saved.source === 'generated'))
    return { title, source: saved.source };
  const acp = acpTitle(record);
  if (acp) return { title: acp, source: 'acp' };
  if (title && saved.source === 'fallback')
    return { title, source: 'fallback' };
  return { title: null, source: null };
}

function acceptsTitle(
  current: ConversationTitle,
  source: NonNullable<ConversationTitle['source']>,
): boolean {
  return (
    source === 'user' ||
    (current.source !== 'user' &&
      current.source !== 'generated' &&
      (source !== 'fallback' ||
        !current.title ||
        current.source === 'fallback'))
  );
}

export interface ConversationTitleDependencies {
  questions?: typeof conversationTitleNodeStore;
  readRecord: (canvasId: string, threadId: string) => ThreadRecord | undefined;
  updateHostMetadata: (
    canvasId: string,
    threadId: string,
    patch: Record<string, unknown>,
  ) => void;
  firstPrompt: (canvasId: string, threadId: string) => string | undefined;
  generate: (prompt: string) => Promise<string | undefined>;
  notifications: (
    canvasId: string,
    threadId: string,
  ) => AsyncIterable<AgentMetadata>;
  onError: (error: unknown) => void;
}

const provider = new ProviderManager();
const defaults: ConversationTitleDependencies = {
  questions: conversationTitleNodeStore,
  readRecord: (canvasId, threadId) =>
    agenetes.record(canvasAcpNamespace(canvasId), threadId),
  updateHostMetadata: (canvasId, threadId, patch) => {
    agenetes.updateHostMetadata(canvasAcpNamespace(canvasId), threadId, patch);
  },
  firstPrompt: (canvasId, threadId) => {
    for (const turn of agenetes.history(
      canvasAcpNamespace(canvasId),
      threadId,
      { withTail: true },
    ).turns) {
      const text = chatEnvelopeFromSubmission(turn.request)?.user.text;
      if (text?.trim()) return text;
    }
    return undefined;
  },
  generate: async (prompt) =>
    (
      await provider.generateContentMeta(prompt, {
        needLabel: true,
        needSummary: false,
        needKeywords: false,
      })
    )?.label,
  notifications: (canvasId, threadId) =>
    agenetes.notifications(threadId, canvasAcpNamespace(canvasId)),
  onError: (error) =>
    getLogger('conversation-title').warn(
      { err: error },
      'Conversation title update failed',
    ),
};

/** One naming policy with thread and Question storage adapters; never realizes a driver. */
export class ConversationTitleService {
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly subscriptions = new Map<string, symbol>();

  constructor(
    private readonly deps: ConversationTitleDependencies = defaults,
  ) {}

  async get(canvasId: string, threadId: string): Promise<ConversationTitle> {
    const question = await this.deps.questions?.read(canvasId, threadId);
    if (question) return question.title;
    const record = this.deps.readRecord(canvasId, threadId);
    const effective = effectiveConversationTitle(record);
    if (!record || effective.title) return effective;
    const title = normalizeConversationTitle(
      extractTitleFromText(this.deps.firstPrompt(canvasId, threadId) ?? ''),
    );
    return { title, source: title ? 'fallback' : null };
  }

  async query(
    canvasId: string,
    threadIds: string[],
  ): Promise<QueryConversationTitlesResponse> {
    return {
      titles: Object.fromEntries(
        await Promise.all(
          threadIds.map(async (id) => [id, await this.get(canvasId, id)]),
        ),
      ),
    };
  }

  async setUserTitle(
    canvasId: string,
    threadId: string,
    title: string,
  ): Promise<ConversationTitle | null> {
    const parsed = setConversationTitleBodySchema.safeParse({ title });
    if (!parsed.success) throw new Error('Invalid conversation title');
    const user = normalizeConversationTitle(parsed.data.title);
    if (!user) throw new Error('Invalid conversation title');
    if (!(await this.writeTitle(canvasId, threadId, user, 'user'))) return null;
    return this.get(canvasId, threadId);
  }

  /** One shared attempt per in-flight request; later turns may retry failures. */
  initialize(
    canvasId: string,
    threadId: string,
    prompt: string,
  ): Promise<void> {
    return this.initializeTarget(canvasId, threadId, prompt);
  }

  /** Preprocess remains an entry, but never returns a second automatic label patch. */
  async initializeQuestion(
    canvasId: string,
    nodeId: string,
    prompt: string,
    allowLLM = true,
  ): Promise<void> {
    const question = await this.deps.questions?.read(
      canvasId,
      undefined,
      nodeId,
    );
    if (!question || question.content !== prompt) return;
    await this.initializeTarget(
      canvasId,
      question.threadId,
      prompt,
      question,
      allowLLM,
    );
  }

  /** Await durable fallback, not the utility model, before dispatching a turn. */
  async ensureFallback(
    canvasId: string,
    threadId: string,
    prompt: string,
  ): Promise<void> {
    try {
      await this.prepare(canvasId, threadId, prompt);
    } catch (error) {
      this.deps.onError(error);
    }
  }

  async start(
    canvasId: string,
    threadId: string,
    prompt: string,
  ): Promise<void> {
    try {
      await this.prepare(canvasId, threadId, prompt);
      void this.initialize(canvasId, threadId, prompt);
    } catch (error) {
      this.deps.onError(error);
    }
  }

  private initializeTarget(
    canvasId: string,
    threadId: string | undefined,
    prompt: string,
    question?: QuestionTitleSnapshot,
    allowLLM = true,
  ): Promise<void> {
    const key = JSON.stringify([canvasId, threadId ?? question?.nodeId]);
    return coalesceInFlight(this.inFlight, key, () =>
      this.initializeOnce(canvasId, threadId, prompt, question, allowLLM).catch(
        (error) => this.deps.onError(error),
      ),
    );
  }

  private async prepare(
    canvasId: string,
    threadId: string | undefined,
    prompt: string,
    expected?: QuestionTitleSnapshot,
  ) {
    const question = await this.deps.questions?.read(
      canvasId,
      threadId,
      expected?.nodeId,
    );
    if (
      expected &&
      (!question ||
        question.content !== expected.content ||
        question.threadId !== expected.threadId)
    )
      return;
    const record = threadId
      ? this.deps.readRecord(canvasId, threadId)
      : undefined;
    if (!record && !question) return;
    const saved = question?.title ?? effectiveConversationTitle(record);
    if (
      question?.protected ||
      saved.source === 'user' ||
      saved.source === 'generated'
    )
      return;
    const firstPrompt =
      (threadId && record
        ? this.deps.firstPrompt(canvasId, threadId)
        : undefined) ??
      (question?.content.trim() || prompt);
    if (!saved.title || (question && saved.source === 'fallback')) {
      const fallback = normalizeConversationTitle(
        extractTitleFromText(firstPrompt),
      );
      if (fallback)
        await this.writeTitle(
          canvasId,
          threadId,
          fallback,
          'fallback',
          question ?? undefined,
        );
    }
    return { firstPrompt, question: question ?? undefined };
  }

  private async initializeOnce(
    canvasId: string,
    threadId: string | undefined,
    prompt: string,
    expected?: QuestionTitleSnapshot,
    allowLLM = true,
  ): Promise<void> {
    const prepared = await this.prepare(canvasId, threadId, prompt, expected);
    if (!prepared || !allowLLM || !prepared.firstPrompt.trim()) return;
    const { firstPrompt, question } = prepared;
    const generated = await this.deps.generate(firstPrompt);
    // Check the latest source after the await; a manual rename wins even if
    // generation began earlier. Rejected titles are not retained as candidates.
    const title = normalizeConversationTitle(generated);
    if (title)
      await this.writeTitle(canvasId, threadId, title, 'generated', question);
  }

  private async acceptAcpTitle(
    canvasId: string,
    threadId: string,
    value: unknown,
  ): Promise<void> {
    const title = normalizeAcpConversationTitle(value);
    if (!title) return;
    await this.writeTitle(canvasId, threadId, title, 'acp');
  }

  /** Install at realization, before session bootstrap; notifications are persist-then-notify. */
  subscribe(canvasId: string, threadId: string): void {
    if (!canvasId || !threadId) return;
    const key = JSON.stringify([canvasId, threadId]);
    if (this.subscriptions.has(key)) return;
    const token = Symbol();
    this.subscriptions.set(key, token);
    void (async () => {
      try {
        const stream = this.deps.notifications(canvasId, threadId);
        const record = this.deps.readRecord(canvasId, threadId);
        // Register before replaying persisted state so bootstrap updates are
        // buffered, including a blank update following a useful cached title.
        try {
          await this.acceptAcpTitle(
            canvasId,
            threadId,
            record ? acpTitle(record) : undefined,
          );
        } catch (error) {
          this.deps.onError(error);
        }
        for await (const meta of stream) {
          try {
            await this.acceptAcpTitle(
              canvasId,
              threadId,
              meta.sessionInfo?.title,
            );
          } catch (error) {
            this.deps.onError(error);
          }
        }
      } catch (error) {
        this.deps.onError(error);
      } finally {
        if (this.subscriptions.get(key) === token)
          this.subscriptions.delete(key);
      }
    })();
  }

  /** Replace the current title only when its source permits the incoming update. */
  private async writeTitle(
    canvasId: string,
    threadId: string | undefined,
    title: string,
    source: NonNullable<ConversationTitle['source']>,
    expected?: QuestionTitleSnapshot,
  ): Promise<boolean> {
    return withCanvasMutex(canvasId, () =>
      this.writeTitleAlreadyLocked(canvasId, threadId, title, source, expected),
    );
  }

  private async writeTitleAlreadyLocked(
    canvasId: string,
    threadId: string | undefined,
    title: string,
    source: NonNullable<ConversationTitle['source']>,
    expected?: QuestionTitleSnapshot,
  ): Promise<boolean> {
    const question = await this.deps.questions?.read(
      canvasId,
      threadId,
      expected?.nodeId,
    );
    if (expected && !question) return false;
    if (question && this.deps.questions) {
      return this.deps.questions.write(
        canvasId,
        threadId,
        expected ?? question,
        (current) => {
          if (
            !acceptsTitle(current.title, source) ||
            (source !== 'user' &&
              (current.protected ||
                (expected && current.content !== expected.content)))
          )
            return null;
          return { title, source };
        },
        true,
      );
    }
    if (!threadId) return false;
    const record = this.deps.readRecord(canvasId, threadId);
    if (!record) return false;
    const current = effectiveConversationTitle(record);
    if (!acceptsTitle(current, source)) return false;
    const saved = storedTitle(record);
    if (saved.title !== title || saved.source !== source) {
      this.deps.updateHostMetadata(canvasId, threadId, {
        [CONVERSATION_TITLE_METADATA_KEY]: { title, source },
      });
    }
    return true;
  }
}

export const conversationTitleService = new ConversationTitleService();
