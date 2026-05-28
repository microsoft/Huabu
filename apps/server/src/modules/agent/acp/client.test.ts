/**
 * Tests focused on `AcpAgentClient` wire-level behaviour that cannot be
 * easily covered by integration tests.
 *
 * Currently:
 *   - Orphan `session/update` buffering & replay (regression cover for
 *     the "slash commands always empty" bug — see
 *     {@link AcpAgentClient.orphanUpdates}).
 *
 * The fake `AgentConnection` is intentionally minimal: it exposes a
 * single `pushMessage` hook so the test can drive the receive side
 * in whatever order it wants (response-before-notification or vice
 * versa), and a `sent` list so we can verify outgoing requests.
 */

import { describe, expect, it } from 'vitest';

import { AcpAgentClient } from './client.js';

import type { AcpSessionUpdate } from './translator.js';
import type { AgentConnection, AcpMessage } from '@agentlet/protocol';

interface FakeConnection extends AgentConnection {
  pushMessage(msg: AcpMessage): void;
  readonly sent: AcpMessage[];
}

function createFakeConnection(): FakeConnection {
  const sent: AcpMessage[] = [];
  let handler: ((msg: AcpMessage) => void) | null = null;
  return {
    agentId: 'fake:agent',
    token: 'fake-token',
    metadata: {},
    agentInfo: { command: 'fake', pid: 0 },
    bridge: { name: 'fake', version: '0.0.0' },
    capabilities: { autoRestart: false, bufferLimit: 0 },
    status: 'connected',
    connectedAt: new Date(),
    send(msg) {
      sent.push(msg);
    },
    onMessage(h) {
      handler = h;
    },
    onLifecycle() {
      /* no-op */
    },
    disconnect() {
      /* no-op */
    },
    pushMessage(msg) {
      if (!handler) throw new Error('no onMessage handler installed');
      handler(msg);
    },
    get sent() {
      return sent;
    },
  };
}

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

describe('AcpAgentClient — orphan session/update replay', () => {
  it('replays a notification that arrived BEFORE the session/new response', () => {
    const conn = createFakeConnection();
    const client = new AcpAgentClient(conn, { logger: silentLogger });

    const sessionId = 'sess-1';
    const orphanUpdate: AcpSessionUpdate = {
      sessionUpdate: 'available_commands_update',
      availableCommands: [
        { name: 'help', description: 'show help', input: null },
      ],
    } as unknown as AcpSessionUpdate;

    // Simulate the agent pushing `session/update` BEFORE we have any
    // listener installed (i.e. before session/new resolves on our side).
    conn.pushMessage({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId, update: orphanUpdate },
    });

    // Now register the long-lived listener (as service.ts would do
    // right after `await client.newSession(...)` resolved).
    const received: AcpSessionUpdate[] = [];
    client.registerSessionListener(sessionId, (u) => received.push(u));

    expect(received).toHaveLength(1);
    expect(received[0]).toBe(orphanUpdate);
  });

  it('does NOT replay the orphan to a SECOND listener for the same session', () => {
    const conn = createFakeConnection();
    const client = new AcpAgentClient(conn, { logger: silentLogger });

    const sessionId = 'sess-2';
    const orphanUpdate: AcpSessionUpdate = {
      sessionUpdate: 'available_commands_update',
      availableCommands: [],
    } as unknown as AcpSessionUpdate;

    conn.pushMessage({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId, update: orphanUpdate },
    });

    const firstReceived: AcpSessionUpdate[] = [];
    client.registerSessionListener(sessionId, (u) => firstReceived.push(u));
    expect(firstReceived).toHaveLength(1);

    // Second registration must NOT see the now-drained orphan —
    // replays are exactly-once.
    const secondReceived: AcpSessionUpdate[] = [];
    client.registerSessionListener(sessionId, (u) => secondReceived.push(u));
    expect(secondReceived).toHaveLength(0);
  });

  it('does not buffer when a turn handler is already installed', async () => {
    const conn = createFakeConnection();
    const client = new AcpAgentClient(conn, { logger: silentLogger });

    const sessionId = 'sess-3';

    // Open a prompt so the turn handler is installed. We don't await
    // the prompt's completion — we just need the handler registered.
    const turnUpdates: AcpSessionUpdate[] = [];
    const promptPromise = client.prompt(sessionId, 'hello', (u) =>
      turnUpdates.push(u),
    );

    // session/prompt request goes out
    expect(conn.sent).toHaveLength(1);

    // Agent pushes an out-of-band update while the turn is in flight.
    const update: AcpSessionUpdate = {
      sessionUpdate: 'available_commands_update',
      availableCommands: [],
    } as unknown as AcpSessionUpdate;
    conn.pushMessage({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId, update },
    });

    // Turn handler saw it; nothing should be buffered.
    expect(turnUpdates).toHaveLength(1);

    // Resolve the prompt so the test doesn't hang on unhandled rejection.
    conn.pushMessage({
      jsonrpc: '2.0',
      id: 1,
      result: { stopReason: 'end_turn' },
    });
    await promptPromise;

    // Late listener should see nothing — there was a handler all along.
    const lateReceived: AcpSessionUpdate[] = [];
    client.registerSessionListener(sessionId, (u) => lateReceived.push(u));
    expect(lateReceived).toHaveLength(0);
  });

  it('caps orphan buffer size and drops oldest on overflow', () => {
    const conn = createFakeConnection();
    const client = new AcpAgentClient(conn, { logger: silentLogger });

    const sessionId = 'sess-4';
    const CAP = 32; // MAX_ORPHAN_UPDATES_PER_SESSION — keep in sync with client.ts

    // Push CAP + 1 orphans so the oldest must be evicted.
    for (let i = 0; i < CAP + 1; i++) {
      conn.pushMessage({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: [
              { name: `cmd-${i}`, description: '', input: null },
            ],
          } as unknown as AcpSessionUpdate,
        },
      });
    }

    const received: AcpSessionUpdate[] = [];
    client.registerSessionListener(sessionId, (u) => received.push(u));

    expect(received).toHaveLength(CAP);
    // The first push (i=0) was dropped; the replayed window starts at i=1.
    const firstReplayed = received[0] as {
      availableCommands: Array<{ name: string }>;
    };
    expect(firstReplayed.availableCommands[0]?.name).toBe('cmd-1');
  });
});
