// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type { QuotedComment } from '../types/api/agent.js';

/** Human-readable text for titles and search, without model-only context. */
export function chatInputText(input: {
  text: string;
  quotedComments?: readonly QuotedComment[];
}): string {
  return [
    ...(input.quotedComments ?? []).map(
      (item) =>
        `${item.quote
          .split(/\r?\n/)
          .map((line) => `> ${line}`)
          .join('\n')}\n\n${item.comment}`,
    ),
    input.text,
  ]
    .filter((text) => text.trim())
    .join('\n\n');
}
