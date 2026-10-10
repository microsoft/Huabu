// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Server-Sent Events (SSE) parser used by the agent streaming client.
 *
 * The protocol used by Huabu endpoints is:
 *
 *   event: <type>\n
 *   data: <json>\n
 *   \n
 *
 * Multiple `data:` lines belong to the same event and are joined with
 * `\n` before parsing. Empty events (no `event:` header or empty body)
 * are skipped.
 */

export interface SSEEvent<T = unknown> {
  type: string;
  data: T;
}

export type SSEEventHandler<T = unknown> = (event: SSEEvent<T>) => void;

export interface SSEReadOptions {
  inactivityTimeoutMs?: number;
}

async function readWithInactivityTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  inactivityTimeoutMs: number | undefined,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (inactivityTimeoutMs === undefined) {
    return reader.read();
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(
            new Error(
              `SSE stream received no data for ${inactivityTimeoutMs} ms`,
            ),
          );
        }, inactivityTimeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

/**
 * Read an SSE response body to completion, invoking `onEvent` for every
 * fully-formed event. Returns when the stream ends or `signal` aborts.
 */
export async function readSSEStream<T = Record<string, unknown>>(
  response: Response,
  onEvent: SSEEventHandler<T>,
  signal?: AbortSignal,
  options: SSEReadOptions = {},
): Promise<void> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      if (signal?.aborted) return;
      const { done, value } = await readWithInactivityTimeout(
        reader,
        options.inactivityTimeoutMs,
      );
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      // Each event is delimited by a blank line (\n\n).
      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';

      for (const part of parts) {
        const event = parseSSEChunk<T>(part);
        if (event) {
          onEvent(event);
        } else if (part.includes('event:') || part.includes('data:')) {
          throw new Error('Malformed SSE event');
        }
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The fetch signal may already have closed the stream.
    }
    reader.releaseLock?.();
  }
}

/** Parse a single `event: ...\ndata: ...` block, or return null if invalid. */
export function parseSSEChunk<T = unknown>(part: string): SSEEvent<T> | null {
  if (!part.trim()) return null;

  const lines = part.split('\n');
  let eventType = '';
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith('event: ')) {
      eventType = line.slice(7).trim();
    } else if (line.startsWith('data: ')) {
      dataLines.push(line.slice(6));
    }
  }

  const dataText = dataLines.join('\n').trim();
  if (!eventType || !dataText) return null;

  try {
    return { type: eventType, data: JSON.parse(dataText) as T };
  } catch {
    return null;
  }
}

/**
 * Typed variant of {@link readSSEStream} for SSE protocols that are modelled
 * as a discriminated union (e.g. `AgentStreamEvent`, `IntentStreamEvent`).
 *
 * Each parsed frame is forwarded as `E` so consumers can `switch` on
 * `event.type` and have `event.data` narrowed automatically. The runtime
 * cannot validate the union shape — callers should treat unknown event
 * types as a no-op (or throw) in the default branch.
 */
export async function readTypedSSEStream<
  E extends { type: string; data: unknown },
>(
  response: Response,
  onEvent: (event: E) => void,
  signal?: AbortSignal,
  options?: SSEReadOptions,
): Promise<void> {
  await readSSEStream<unknown>(
    response,
    (event) => onEvent(event as unknown as E),
    signal,
    options,
  );
}
