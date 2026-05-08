/**
 * Server-Sent Events (SSE) parser shared by the agent and intent
 * streaming clients.
 *
 * The protocol used by Sediment endpoints is:
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

/**
 * Read an SSE response body to completion, invoking `onEvent` for every
 * fully-formed event. Returns when the stream ends or `signal` aborts.
 */
export async function readSSEStream<T = Record<string, unknown>>(
  response: Response,
  onEvent: SSEEventHandler<T>,
  signal?: AbortSignal,
): Promise<void> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      // Each event is delimited by a blank line (\n\n).
      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';

      for (const part of parts) {
        const event = parseSSEChunk<T>(part);
        if (event) onEvent(event);
      }
    }
  } finally {
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
