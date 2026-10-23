// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { chatEnvelopeFromSubmission } from './handle.js';
import { createInkResponse } from '../ink-response.js';

import type { AgentSubmission, AgentStreamEvent } from '@agenetes/protocol';
import type { AgentHandle, MountedAgentDriver } from '@agenetes/runtime';

/** Apply Huabu's delivery contract before Agenetes logs and folds events. */
export function withInkResponse(
  driver: MountedAgentDriver,
): MountedAgentDriver {
  return {
    ...driver,
    create(workload, context) {
      const handle = driver.create(workload, context);
      return new Proxy(handle, {
        get(target, property) {
          if (property !== 'run') {
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          }
          return async function* (
            submission: AgentSubmission | null,
            ctx: unknown,
          ): ReturnType<AgentHandle['run']> {
            const envelope = chatEnvelopeFromSubmission(submission);
            if (envelope?.user.inputKind !== 'ink-intent')
              return yield* target.run(submission, ctx);

            const canvasId = workload.namespace.name;
            const threadId = workload.threadId;
            if (!canvasId || !threadId) {
              yield {
                type: 'error',
                data: { error: 'Ink queries require a Canvas and a thread.' },
              };
              return;
            }
            const signal =
              ctx &&
              typeof ctx === 'object' &&
              'signal' in ctx &&
              ctx.signal instanceof AbortSignal
                ? ctx.signal
                : undefined;
            const response = createInkResponse(canvasId, threadId);
            const terminalEvents: AgentStreamEvent[] = [];
            let eventError: string | undefined;
            let source: ReturnType<AgentHandle['run']> | undefined;
            let drained = false;
            try {
              source = target.run(submission, ctx);
              while (true) {
                const step = await source.next();
                if (step.done) {
                  drained = true;
                  await response.deliver({
                    error: eventError,
                    interrupted: signal?.aborted ?? false,
                  });
                  if (!eventError) yield* terminalEvents;
                  return step.value;
                }
                const event = step.value;
                // Drivers may emit done before cleanup or a later failure.
                if (event.type === 'done' || event.type === 'end') {
                  terminalEvents.push(event);
                } else {
                  if (event.type === 'error')
                    eventError = event.data.error || 'Internal Error';
                  yield event;
                }
              }
            } catch (error) {
              yield {
                type: 'error',
                data: {
                  error: error instanceof Error ? error.message : String(error),
                },
              };
            } finally {
              response.stop();
              if (!drained) await source?.return(undefined);
            }
          };
        },
      });
    },
  };
}
