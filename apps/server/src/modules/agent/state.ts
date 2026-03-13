import { Annotation } from '@langchain/langgraph';

import type { BaseMessage } from '@langchain/core/messages';

export const AgentState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (x, y) => x.concat(y),
  }),
  question: Annotation<string>({
    reducer: (x, y) => y ?? x,
  }),
  // Per-turn selection context (ephemeral; not appended to message history).
  selectionContext: Annotation<string | null>({
    reducer: (x, y) => (typeof y === 'undefined' ? x : y),
  }),
});
