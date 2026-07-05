/**
 * `BuiltinAgentHandle` — the {@link AgentHandle} implementation for the
 * in-process, pi-agent-core backend (the built-in "Job" driver).
 *
 * This is the canonical home for the built-in agent's *execution* logic:
 * the single-subscribe event pump, the pi-agent-core `AgentEvent` ->
 * `AgentStreamEvent` translation, the soft turn cap, and the output-delta
 * slice. `runAgent` (agent.service.ts) is now a thin composition shell
 * that builds the backing `Agent`, wraps it in this handle, and drains
 * `events()`.
 *
 * The pi-SDK is fully encapsulated here — `prompt` vs `continue` is an
 * internal decision (see {@link BuiltinAgentHandle.submit}), never exposed
 * on the {@link AgentHandle} interface. The backing `Agent` is INJECTED
 * (constructed by the composition layer, which owns the host singletons
 * `getLLMModel` / `ensureApiKey` / `buildToolsForScope`) rather than built
 * here, so this class stays free of those host imports. Moving the
 * `new Agent(...)` construction behind a `create(spec)` factory is deferred
 * to M4/M5.
 *
 * See docs/proposals/layered-architecture.md §3.6 / §7 (M2).
 */

import { convertToLlm } from '@earendil-works/pi-agent-core';

import type { AgentHandle, AgentRequest, RenderFn } from './handle.js';
import type {
  AgentCapabilities,
  ControlAck,
  ControlMsg,
} from '@agenetes/protocol';
import type {
  Agent,
  AgentEvent,
  AgentToolResult,
} from '@earendil-works/pi-agent-core';
import type {
  AssistantMessage,
  Message,
  TextContent,
} from '@earendil-works/pi-ai';
import type { AgentStreamEvent } from '@sediment/shared';

/**
 * The events the built-in path actually emits: every `AgentStreamEvent`
 * variant EXCEPT `meta` / `end`, which are synthesized by the route that
 * owns the HTTP connection. Assignable to the interface's wider
 * `AsyncGenerator<AgentStreamEvent, ...>` (generators are covariant in
 * their yield type), so this narrower stream still satisfies
 * {@link AgentHandle}.
 */
type InStreamEvent = Exclude<AgentStreamEvent, { type: 'meta' | 'end' }>;

/** The built-in path's render output: this turn's pi-ai messages. */
export type BuiltinRendered = Message[];

/** Minimal structured logger the handle emits request-scoped diagnostics to. */
interface HandleLogger {
  info: (message: string) => void;
}

/** Construction-time options for a {@link BuiltinAgentHandle}. */
export interface BuiltinAgentHandleOptions {
  /**
   * Soft cap on agent turns (LLM call + tool batch). When reached, the
   * agent loop is aborted internally and a cap-out error is emitted.
   */
  maxIterations?: number;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
  /** Structured logger for request-scoped diagnostics. */
  logger?: HandleLogger;
  /**
   * Optional developer aid invoked with this turn's rendered messages the
   * moment after `render` runs (before the agent is kicked off). Lets the
   * composition layer dump the fully-assembled prompt without this handle
   * importing the host's prompt-debug util. No-op when omitted.
   */
  onRendered?: (renderedMessages: Message[]) => void;
}

/** Concatenate every TextContent block into a single string. */
function joinText(content: ReadonlyArray<{ type: string }>): string {
  return content
    .filter((b): b is TextContent => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

/**
 * The pi-agent-core–backed {@link AgentHandle}. Wraps a route-supplied
 * {@link Agent} (constructed over the prior transcript) and drives one
 * turn against it.
 */
export class BuiltinAgentHandle implements AgentHandle<BuiltinRendered> {
  /**
   * A built-in Job advertises only `cancel`; it accepts turn input
   * blocking (the ACP baseline). It has no session-load or slash-command
   * surface.
   */
  readonly capabilities: AgentCapabilities = {
    control: ['cancel'],
    turnInput: 'blocking',
  };

  /**
   * The transcript length at construction. This turn's output delta is
   * everything the agent appends beyond this prefix (+ this turn's
   * rendered rows, which are re-derived from the request on reload).
   */
  private readonly priorLen: number;

  /** The pending turn recorded by {@link submit}, consumed by {@link events}. */
  private pending?: {
    request: AgentRequest | null;
    render: RenderFn<BuiltinRendered>;
  };

  constructor(
    private readonly agent: Agent,
    private readonly options: BuiltinAgentHandleOptions = {},
  ) {
    this.priorLen = agent.state.messages.length;
  }

  /**
   * Record this turn. Non-blocking: the render + kickoff happen when
   * {@link events} is iterated, so the subscribe is always wired before the
   * run starts.
   *
   * `prompt` vs `continue` is decided internally from the rendered output:
   * a non-null request renders to this turn's messages and starts a new
   * prompt; a null request (no new input) resumes the pre-loaded transcript
   * via `continue()`.
   */
  submit(
    request: AgentRequest | null,
    render: RenderFn<BuiltinRendered>,
  ): void {
    this.pending = { request, render };
  }

  async *events(): AsyncGenerator<InStreamEvent, Message[]> {
    const pending = this.pending;
    if (!pending) {
      throw new Error('BuiltinAgentHandle.events() called before submit()');
    }
    const { agent, priorLen } = this;
    const { maxIterations = 20, signal, logger, onRendered } = this.options;

    // Render THIS turn at the last moment. A null request means "no new
    // input" — resume the pre-loaded transcript with `continue()`.
    const turnMessages =
      pending.request === null ? [] : await pending.render(pending.request);
    onRendered?.(turnMessages);

    // This run's output delta — the single value we return (see the tail).
    let outputDelta: Message[] = [];

    // Soft turn cap: pi-agent-core's `Agent` doesn't expose
    // `shouldStopAfterTurn`, so we count `turn_end` events and call
    // `agent.abort()` after the cap. This trips the *agent's* internal
    // AbortController, not the route's — so the route's
    // `cleanUpAbortedMessages` does not fire, and we trim the trailing
    // aborted-empty assistant message the loop appends (see `agent_end`).
    let turnCount = 0;
    let cappedOut = false;

    // ------- Single subscribe: queue events, flag agent_end, count turns ----
    type Resolver = (value: AgentEvent | null) => void;
    const eventQueue: AgentEvent[] = [];
    const waiters: Resolver[] = [];
    let agentEnded = false;

    const unsubscribe = agent.subscribe((event) => {
      if (event.type === 'turn_end') {
        turnCount++;
        if (turnCount >= maxIterations && !cappedOut) {
          cappedOut = true;
          logger?.info(
            `[agent] Reached maxIterations (${maxIterations}), aborting after current turn`,
          );
          agent.abort();
        }
      }
      if (event.type === 'agent_end') agentEnded = true;
      const w = waiters.shift();
      if (w) w(event);
      else eventQueue.push(event);
    });

    function nextEvent(): Promise<AgentEvent | null> {
      const queued = eventQueue.shift();
      if (queued !== undefined) {
        return Promise.resolve(queued);
      }
      if (agentEnded) {
        return Promise.resolve(null);
      }
      return new Promise<AgentEvent | null>((resolve) => waiters.push(resolve));
    }

    // ------- Abort wiring -------
    const onAbort = () => {
      logger?.info('[agent] Signal aborted, propagating to pi-agent-core');
      agent.abort();
      // Wake any pending waiter so the generator can drain and exit.
      const w = waiters.shift();
      if (w) w(null);
    };
    if (signal?.aborted) {
      // Already aborted before we started.
      onAbort();
    } else {
      signal?.addEventListener('abort', onAbort, { once: true });
    }

    // ------- Kick off the run -------
    // Non-empty this-turn messages → `prompt` (append + run). Empty (null
    // request / envelope-less resume) → `continue` (run from the current
    // transcript tail, which the caller guarantees ends in a user or
    // tool-result message).
    const runPromise = (
      turnMessages.length > 0 ? agent.prompt(turnMessages) : agent.continue()
    ).catch((err: unknown) => {
      // pi-agent-core's contract is that streamFn never throws and errors
      // are encoded into the stream. But just in case, surface the error
      // through the queue so the generator emits an `error` event.
      logger?.info(
        `[agent] kickoff rejected: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      agentEnded = true;
      const w = waiters.shift();
      if (w) w(null);
    });

    try {
      while (true) {
        const event = await nextEvent();
        if (event === null) break;

        switch (event.type) {
          case 'message_update': {
            const inner = event.assistantMessageEvent;
            if (inner.type === 'text_delta') {
              yield { type: 'text_delta', data: { content: inner.delta } };
            } else if (inner.type === 'thinking_delta') {
              yield { type: 'thinking_delta', data: { content: inner.delta } };
            }
            break;
          }

          case 'tool_execution_start': {
            yield {
              type: 'tool_call',
              data: {
                toolCallId: event.toolCallId,
                // `title` is display-only; the machine tool name travels
                // on `internalToolName` so the web can resolve the render
                // variant + gate local side-effects (canvas_commands).
                title: event.toolName,
                internalToolName: event.toolName,
                status: 'pending',
                rawInput: (event.args ?? {}) as Record<string, unknown>,
              },
            };
            break;
          }

          case 'tool_execution_end': {
            const result = event.result as AgentToolResult<unknown> | undefined;
            const toolText = result?.content ? joinText(result.content) : '';
            // pi-agent-core wraps thrown handler errors as tool results
            // with `isError: true` and the `Error.message` as text content.
            // Lift that into the standard `ToolResponse<status: 'error'>`
            // envelope so the web client renders it as an error tool row
            // (see apps/web/src/components/Messages/ToolMessage.tsx).
            // Successful results stay verbatim — the web's
            // `parseToolResponse` either reads their existing envelope or
            // auto-wraps plain JSON as `{ status: 'success', data: ... }`.
            let payload = toolText;
            if (event.isError) {
              logger?.info(
                `[agent] Tool ${event.toolName} returned isError=true: ${toolText.slice(0, 200)}`,
              );
              payload = JSON.stringify({
                tool: event.toolName,
                status: 'error',
                error: toolText || 'Tool execution failed',
              });
            }
            yield {
              type: 'tool_call_update',
              data: {
                toolCallId: event.toolCallId,
                status: event.isError ? 'failed' : 'completed',
                // The web recovers the tool name from the part the
                // originating `tool_call` created; the result payload
                // (JSON-stringified `ToolResponse`) rides on `rawOutput`.
                rawOutput: payload,
              },
            };
            break;
          }

          case 'agent_end': {
            // Look at the final assistant message to decide done vs. error.
            const messages = agent.state.messages;

            // When `cappedOut` is true, `agent.abort()` was called from the
            // turn_end listener. If the just-finished turn had pending tool
            // calls, the loop entered one more iteration where the LLM
            // stream got cancelled — appending an empty assistant message
            // with `stopReason: 'aborted'`. Trim it so the user sees the
            // last *useful* assistant text on cap-out (and so we don't leak
            // an empty "AI response" row into history).
            if (cappedOut) {
              const tail = messages[messages.length - 1];
              if (
                tail?.role === 'assistant' &&
                tail.stopReason === 'aborted' &&
                joinText(tail.content).length === 0
              ) {
                messages.pop();
              }
            }

            const lastAssistant = [...messages]
              .reverse()
              .find((m): m is AssistantMessage => m.role === 'assistant');

            const stopReason = lastAssistant?.stopReason;
            const finalText = lastAssistant
              ? joinText(lastAssistant.content)
              : '';

            if (stopReason === 'error') {
              yield {
                type: 'error',
                data: {
                  error: agent.state.errorMessage ?? 'LLM streaming error',
                },
              };
            } else if (cappedOut) {
              // Soft turn cap hit. Surface the last useful assistant text
              // (if any) followed by an error event explaining why we
              // stopped. The route's `cleanUpAbortedMessages` does NOT fire
              // here because the *route's* AbortController was never
              // tripped — only the agent's internal one was.
              if (finalText) {
                yield {
                  type: 'done',
                  data: {
                    message: finalText,
                    meta: {
                      stopReason,
                      usage: lastAssistant?.usage,
                      iterations: turnCount,
                    },
                  },
                };
              }
              yield {
                type: 'error',
                data: {
                  error: `Agent loop exceeded maximum iterations (${maxIterations})`,
                },
              };
            } else if (stopReason === 'aborted') {
              // Real user-initiated abort: route handles UX
              // (cleanUpAbortedMessages + status row). Nothing to emit.
            } else {
              yield {
                type: 'done',
                data: {
                  message: finalText,
                  meta: {
                    stopReason,
                    usage: lastAssistant?.usage,
                    iterations: turnCount,
                  },
                },
              };
            }
            break;
          }

          // Other events (agent_start, turn_start/end, message_start/end,
          // tool_execution_update) are intentionally not surfaced — the
          // route + UI never relied on them.
          default:
            break;
        }
      }
    } finally {
      unsubscribe();
      signal?.removeEventListener('abort', onAbort);

      // Make sure the run has fully settled (and `agent_end` listeners
      // drained) before we sync state back. `runPromise` already resolves
      // at that point; `waitForIdle` is a belt-and-suspenders.
      await runPromise;
      await agent.waitForIdle();

      // This run's output delta = everything the agent appended after the
      // input prefix. RETURN it as the single output channel — we never
      // write back into the injected transcript.
      //
      // `convertToLlm` downcasts `agent.state.messages` (a superset with
      // harness-only roles like `custom` / `bashExecution` / `branchSummary`
      // / `compactionSummary`) into wire `Message`s. The input prefix
      // (`priorLen` history + `turnMessages.length` rendered rows) has no
      // harness roles, so it survives 1:1 and the slice index stays valid.
      const converted = convertToLlm(agent.state.messages);
      outputDelta = converted.slice(priorLen + turnMessages.length);
    }

    return outputDelta;
  }

  async control(msg: ControlMsg): Promise<ControlAck> {
    if (!this.capabilities.control.includes(msg.type)) {
      return {
        ok: false,
        error: `unsupported control operation: ${msg.type}`,
        code: 'unsupported',
      };
    }
    if (msg.type === 'cancel') {
      this.agent.abort();
      return { ok: true };
    }
    // Unreachable given the capability gate above, but keeps the switch
    // exhaustive against future capability additions.
    return {
      ok: false,
      error: `unsupported control operation: ${msg.type}`,
      code: 'unsupported',
    };
  }
}
