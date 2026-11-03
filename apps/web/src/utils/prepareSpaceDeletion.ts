// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { ConversationTitleSaveError } from '@/store/conversationTitleStore';

import { pageLifecycle } from './pageLifecycle';
import { withSaveErrorsHandledByCaller } from './saveErrorFeedback';

let titleFailure: ConversationTitleSaveError | undefined;

/** Retry and drain every save owner within the same abortable preparation. */
export async function prepareSpaceDeletion(signal: AbortSignal): Promise<void> {
  const retained = titleFailure;
  try {
    await withSaveErrorsHandledByCaller(() =>
      pageLifecycle.prepare(
        signal,
        undefined,
        retained ? () => retained.retry() : undefined,
      ),
    );
    signal.throwIfAborted();
    if (titleFailure === retained) titleFailure = undefined;
  } catch (error) {
    if (!signal.aborted && error instanceof ConversationTitleSaveError)
      titleFailure = error;
    throw error;
  }
}
