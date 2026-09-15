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
import { getLogger } from '../../utils/logger.js';
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

export interface ConversationTitleDependencies {
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

/** Independent host-owned Chat names; never realizes a driver or reads/writes nodes. */
export class ConversationTitleService {
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly subscriptions = new Map<string, symbol>();

  constructor(
    private readonly deps: ConversationTitleDependencies = defaults,
  ) {}

  get(canvasId: string, threadId: string): ConversationTitle {
    const record = this.deps.readRecord(canvasId, threadId);
    const effective = effectiveConversationTitle(record);
    if (!record || effective.title) return effective;
    const title = normalizeConversationTitle(
      extractTitleFromText(this.deps.firstPrompt(canvasId, threadId) ?? ''),
    );
    return { title, source: title ? 'fallback' : null };
  }

  query(
    canvasId: string,
    threadIds: string[],
  ): QueryConversationTitlesResponse {
    return {
      titles: Object.fromEntries(
        threadIds.map((id) => [id, this.get(canvasId, id)]),
      ),
    };
  }

  setUserTitle(
    canvasId: string,
    threadId: string,
    title: string,
  ): ConversationTitle | null {
    const parsed = setConversationTitleBodySchema.safeParse({ title });
    if (!parsed.success) throw new Error('Invalid conversation title');
    const user = normalizeConversationTitle(parsed.data.title);
    if (!user) throw new Error('Invalid conversation title');
    if (!this.writeTitle(canvasId, threadId, user, 'user')) return null;
    return this.get(canvasId, threadId);
  }

  /** One shared attempt per in-flight request; later turns may retry failures. */
  initialize(
    canvasId: string,
    threadId: string,
    prompt: string,
  ): Promise<void> {
    const key = JSON.stringify([canvasId, threadId]);
    return coalesceInFlight(this.inFlight, key, () =>
      this.initializeOnce(canvasId, threadId, prompt).catch((error) =>
        this.deps.onError(error),
      ),
    );
  }

  private async initializeOnce(
    canvasId: string,
    threadId: string,
    prompt: string,
  ): Promise<void> {
    const record = this.deps.readRecord(canvasId, threadId);
    if (!record) return;
    const saved = effectiveConversationTitle(record);
    if (saved.source === 'user' || saved.source === 'generated') return;
    const firstPrompt = this.deps.firstPrompt(canvasId, threadId) ?? prompt;
    if (!saved.title) {
      const fallback = normalizeConversationTitle(
        extractTitleFromText(firstPrompt),
      );
      if (fallback) this.writeTitle(canvasId, threadId, fallback, 'fallback');
    }
    if (!firstPrompt.trim()) return;
    const generated = await this.deps.generate(firstPrompt);
    // Check the latest source after the await; a manual rename wins even if
    // generation began earlier. Rejected titles are not retained as candidates.
    this.saveGenerated(canvasId, threadId, generated);
  }

  private saveGenerated(
    canvasId: string,
    threadId: string,
    value: unknown,
  ): void {
    const generated = normalizeConversationTitle(value);
    if (!generated) return;
    this.writeTitle(canvasId, threadId, generated, 'generated');
  }

  private acceptAcpTitle(
    canvasId: string,
    threadId: string,
    value: unknown,
  ): void {
    const title = normalizeAcpConversationTitle(value);
    if (!title) return;
    this.writeTitle(canvasId, threadId, title, 'acp');
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
          this.acceptAcpTitle(
            canvasId,
            threadId,
            record ? acpTitle(record) : undefined,
          );
        } catch (error) {
          this.deps.onError(error);
        }
        for await (const meta of stream) {
          try {
            this.acceptAcpTitle(canvasId, threadId, meta.sessionInfo?.title);
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
  private writeTitle(
    canvasId: string,
    threadId: string,
    title: string,
    source: NonNullable<ConversationTitle['source']>,
  ): boolean {
    const record = this.deps.readRecord(canvasId, threadId);
    if (!record) return false;
    const current = effectiveConversationTitle(record);
    if (
      source !== 'user' &&
      (current.source === 'user' ||
        current.source === 'generated' ||
        (source === 'fallback' && current.title !== null))
    )
      return false;
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
