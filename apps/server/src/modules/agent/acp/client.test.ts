// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

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
 *
 * Note on async: since the switch to `@agentclientprotocol/sdk`, the
 * client routes inbound messages through the SDK's `Stream`-based
 * read pump, which dispatches notifications on a microtask boundary
 * rather than synchronously inside `onMessage`. Tests therefore use
 * `flush()` (a few `await Promise.resolve()` + `setImmediate`) between
 * driving an incoming message and asserting on dispatched state.
 */

import { AcpAgentClient, agentSupportsLoadSession } from '@agenetes/acp-driver';
import { describe, expect, it } from 'vitest';

import type { AgentConnection, AcpMessage } from '@agentlet/protocol';
import type { AcpSessionUpdate } from '@huabu/shared';

interface FakeConnection extends AgentConnection {
  pushMessage(msg: AcpMessage): void;
  readonly sent: AcpMessage[];
}

function createFakeConnection(): FakeConnection {
  const sent: AcpMessage[] = [];
  const handlers: Array<(msg: AcpMessage) => void> = [];
  return {
    sessionId: 'fake:session',
    agentletId: 'fake:agentlet',
    role: 'agent-session',
    metadata: {},
    status: 'connected',
    connectedAt: new Date(),
    send(msg) {
      sent.push(msg);
    },
    onMessage(h) {
      handlers.push(h);
    },
    onLifecycle() {
      /* no-op */
    },
    disconnect() {
      /* no-op */
    },
    pushMessage(msg) {
      if (handlers.length === 0) {
        throw new Error('no onMessage handler installed');
      }
      for (const h of handlers) h(msg);
    },
    get sent() {
      return sent;
    },
  };
}

/**
 * Yield to the event loop so the SDK's `receive()` pump processes any
 * queued message and dispatches it through our `Client` handler.
 *
 * The SDK's `Connection.receive()` reads from `stream.readable` with
 * `await reader.read()`, which suspends on a microtask. A small chain
 * of `await Promise.resolve()` plus one `setImmediate` is enough to
 * let the loop iterate once.
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await Promise.resolve();
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  for (let i = 0; i < 4; i++) {
    await Promise.resolve();
  }
}

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

describe('AcpAgentClient — orphan session/update replay', () => {
  it('replays a notification that arrived BEFORE the session/new response', async () => {
    const conn = createFakeConnection();
    const client = new AcpAgentClient(conn, { logger: silentLogger });

    const sessionId = 'sess-1';
    const orphanUpdate = {
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
    // Let the SDK's read pump process the message and call our
    // `sessionUpdate` handler.
    await flush();

    // Now register the long-lived listener (as service.ts would do
    // right after `await client.newSession(...)` resolved).
    const received: AcpSessionUpdate[] = [];
    client.registerSessionListener(sessionId, (u) => received.push(u));

    expect(received).toHaveLength(1);
    // The SDK round-trips the update through zod validation so we
    // can't `toBe(orphanUpdate)`; compare structurally instead.
    expect(received[0]).toEqual(orphanUpdate);
  });

  it('does NOT replay the orphan to a SECOND listener for the same session', async () => {
    const conn = createFakeConnection();
    const client = new AcpAgentClient(conn, { logger: silentLogger });

    const sessionId = 'sess-2';
    const orphanUpdate = {
      sessionUpdate: 'available_commands_update',
      availableCommands: [],
    } as unknown as AcpSessionUpdate;

    conn.pushMessage({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId, update: orphanUpdate },
    });
    await flush();

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
    const promptPromise = client.prompt(
      sessionId,
      [{ type: 'text', text: 'hello' }],
      (u) => turnUpdates.push(u),
    );

    // Let the SDK write the session/prompt request out via the
    // adapter's WritableStream.
    await flush();
    expect(conn.sent).toHaveLength(1);
    const sentPrompt = conn.sent[0] as {
      id?: unknown;
      method?: string;
      params?: unknown;
    };
    expect(sentPrompt.method).toBe('session/prompt');
    const promptRequestId = sentPrompt.id;
    expect(typeof promptRequestId).toBe('number');

    // Agent pushes an out-of-band update while the turn is in flight.
    const update = {
      sessionUpdate: 'available_commands_update',
      availableCommands: [],
    } as unknown as AcpSessionUpdate;
    conn.pushMessage({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId, update },
    });
    await flush();

    // Turn handler saw it; nothing should be buffered.
    expect(turnUpdates).toHaveLength(1);

    // Resolve the prompt so the test doesn't hang on unhandled rejection.
    conn.pushMessage({
      jsonrpc: '2.0',
      id: promptRequestId as number,
      result: { stopReason: 'end_turn' },
    });
    await promptPromise;

    // Late listener should see nothing — there was a handler all along.
    const lateReceived: AcpSessionUpdate[] = [];
    client.registerSessionListener(sessionId, (u) => lateReceived.push(u));
    expect(lateReceived).toHaveLength(0);
  });

  it('caps orphan buffer size and drops oldest on overflow', async () => {
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
    await flush();

    const received: AcpSessionUpdate[] = [];
    client.registerSessionListener(sessionId, (u) => received.push(u));

    expect(received).toHaveLength(CAP);
    // The first push (i=0) was dropped; the replayed window starts at i=1.
    const firstReplayed = received[0] as unknown as {
      availableCommands: Array<{ name: string }>;
    };
    expect(firstReplayed.availableCommands[0]?.name).toBe('cmd-1');
  });

  // Regression cover for the "fewer slash commands than before" bug
  // introduced by the @agentclientprotocol/sdk integration: real agents
  // (Claude Code, Gemini CLI) sometimes emit `AvailableCommand` items
  // with a missing or `null` description, which the SDK's strict
  // `zSessionNotification.parse` rejects — silently dropping the WHOLE
  // notification along with every other command in the array.
  //
  // We now intercept `session/update` in the stream adapter and route
  // raw payloads straight to dispatch, so per-item shape issues no
  // longer wipe the entire update.
  it('forwards available_commands_update even when a command lacks description', async () => {
    const conn = createFakeConnection();
    const client = new AcpAgentClient(conn, { logger: silentLogger });

    const sessionId = 'sess-loose';
    // Three commands: one well-formed, one with `description: null`,
    // one with description omitted entirely. The SDK schema would
    // reject the whole array; our interceptor must let it through.
    const looseUpdate = {
      sessionUpdate: 'available_commands_update',
      availableCommands: [
        { name: 'help', description: 'show help' },
        { name: 'compact', description: null },
        { name: 'init' },
      ],
    } as unknown as AcpSessionUpdate;

    conn.pushMessage({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId, update: looseUpdate },
    });
    // No await needed — the interceptor dispatches synchronously,
    // bypassing the SDK's microtask-boundary read pump.

    const received: AcpSessionUpdate[] = [];
    client.registerSessionListener(sessionId, (u) => received.push(u));

    expect(received).toHaveLength(1);
    const cmds = (received[0] as unknown as { availableCommands: unknown[] })
      .availableCommands;
    expect(cmds).toHaveLength(3);
    expect((cmds[0] as { name: string }).name).toBe('help');
    expect((cmds[1] as { name: string }).name).toBe('compact');
    expect((cmds[2] as { name: string }).name).toBe('init');
  });

  // Belt-and-braces: even unknown `sessionUpdate` discriminators (e.g.
  // an experimental variant the SDK schema hasn't shipped yet) must
  // reach downstream consumers so they can decide how to handle them.
  it('forwards unknown sessionUpdate discriminators verbatim', async () => {
    const conn = createFakeConnection();
    const client = new AcpAgentClient(conn, { logger: silentLogger });

    const sessionId = 'sess-unknown';
    const exotic = {
      sessionUpdate: 'experimental_future_variant',
      payload: { foo: 'bar' },
    } as unknown as AcpSessionUpdate;

    conn.pushMessage({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId, update: exotic },
    });

    const received: AcpSessionUpdate[] = [];
    client.registerSessionListener(sessionId, (u) => received.push(u));

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(exotic);
  });
});

describe('AcpAgentClient — permission handshake', () => {
  it('auto-allows when NO per-turn notifier is installed', async () => {
    const conn = createFakeConnection();
    // Construct for its handler side-effects; no method is called directly.
    void new AcpAgentClient(conn, { logger: silentLogger });

    conn.pushMessage({
      jsonrpc: '2.0',
      id: 42,
      method: 'session/request_permission',
      params: {
        sessionId: 'sess-perm-1',
        toolCall: { toolCallId: 't1', title: 'Read x', kind: 'read' },
        options: [
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
        ],
      },
    });
    await flush();

    const resp = conn.sent.find((m) => (m as { id?: unknown }).id === 42) as
      | { result?: { outcome?: unknown } }
      | undefined;
    expect(resp?.result?.outcome).toEqual({
      outcome: 'selected',
      optionId: 'allow',
    });
  });

  it('suspends until resolvePermission selects an option', async () => {
    const conn = createFakeConnection();
    const client = new AcpAgentClient(conn, { logger: silentLogger });
    const sessionId = 'sess-perm-2';

    let captured:
      | { requestId: string; options: Array<{ optionId: string }> }
      | undefined;
    const promptPromise = client.prompt(
      sessionId,
      [{ type: 'text', text: 'hi' }],
      () => {},
      undefined,
      (req) => {
        captured = req;
      },
    );
    await flush();
    const sentPrompt = conn.sent.find(
      (m) => (m as { method?: string }).method === 'session/prompt',
    ) as { id?: number };
    const promptRequestId = sentPrompt.id as number;

    conn.pushMessage({
      jsonrpc: '2.0',
      id: 99,
      method: 'session/request_permission',
      params: {
        sessionId,
        toolCall: { toolCallId: 't-edit', title: 'Edit f', kind: 'edit' },
        options: [{ optionId: 'ok', name: 'OK', kind: 'allow_once' }],
      },
    });
    await flush();

    // Notifier fired; the agent's request is still suspended.
    expect(captured).toBeDefined();
    expect(captured?.options).toHaveLength(1);
    expect(
      conn.sent.find((m) => (m as { id?: unknown }).id === 99),
    ).toBeUndefined();

    const ok = client.resolvePermission(captured!.requestId, {
      optionId: 'ok',
    });
    expect(ok).toBe(true);
    await flush();

    const resp = conn.sent.find((m) => (m as { id?: unknown }).id === 99) as {
      result?: { outcome?: unknown };
    };
    expect(resp.result?.outcome).toEqual({
      outcome: 'selected',
      optionId: 'ok',
    });

    conn.pushMessage({
      jsonrpc: '2.0',
      id: promptRequestId,
      result: { stopReason: 'end_turn' },
    });
    await promptPromise;
  });

  it('returns a cancelled outcome when the request is cancelled', async () => {
    const conn = createFakeConnection();
    const client = new AcpAgentClient(conn, { logger: silentLogger });
    const sessionId = 'sess-perm-3';

    let requestId = '';
    const promptPromise = client.prompt(
      sessionId,
      [{ type: 'text', text: 'hi' }],
      () => {},
      undefined,
      (req) => {
        requestId = req.requestId;
      },
    );
    await flush();
    const sentPrompt = conn.sent.find(
      (m) => (m as { method?: string }).method === 'session/prompt',
    ) as { id?: number };
    const promptRequestId = sentPrompt.id as number;

    conn.pushMessage({
      jsonrpc: '2.0',
      id: 7,
      method: 'session/request_permission',
      params: {
        sessionId,
        toolCall: { toolCallId: 't-run', title: 'Run', kind: 'execute' },
        options: [{ optionId: 'go', name: 'Go', kind: 'allow_once' }],
      },
    });
    await flush();

    expect(client.resolvePermission(requestId, { cancelled: true })).toBe(true);
    await flush();

    const resp = conn.sent.find((m) => (m as { id?: unknown }).id === 7) as {
      result?: { outcome?: unknown };
    };
    expect(resp.result?.outcome).toEqual({ outcome: 'cancelled' });

    // Second resolve for the same id is a no-op false.
    expect(client.resolvePermission(requestId, { cancelled: true })).toBe(
      false,
    );

    conn.pushMessage({
      jsonrpc: '2.0',
      id: promptRequestId,
      result: { stopReason: 'end_turn' },
    });
    await promptPromise;
  });
});

describe('agentSupportsLoadSession', () => {
  it('returns false for null / undefined / no capabilities', () => {
    expect(agentSupportsLoadSession(null)).toBe(false);
    expect(agentSupportsLoadSession(undefined)).toBe(false);
    expect(agentSupportsLoadSession({ protocolVersion: 1 })).toBe(false);
    expect(
      agentSupportsLoadSession({ protocolVersion: 1, agentCapabilities: {} }),
    ).toBe(false);
  });

  it('returns true when agentCapabilities.loadSession is truthy', () => {
    expect(
      agentSupportsLoadSession({
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
      }),
    ).toBe(true);
    // Permissive: nested objects also count.
    expect(
      agentSupportsLoadSession({
        protocolVersion: 1,
        agentCapabilities: { loadSession: { something: 'else' } },
      }),
    ).toBe(true);
  });

  it('returns false when loadSession is explicitly false', () => {
    expect(
      agentSupportsLoadSession({
        protocolVersion: 1,
        agentCapabilities: { loadSession: false },
      }),
    ).toBe(false);
  });
});

describe('AcpAgentClient — loadSession', () => {
  it('sends a session/load JSON-RPC request with the persisted sessionId + cwd', async () => {
    const conn = createFakeConnection();
    const client = new AcpAgentClient(conn, { logger: silentLogger });

    const loadPromise = client.loadSession({
      sessionId: 'sess-persisted',
      cwd: '/repo',
    });
    await flush();

    const sentLoad = conn.sent.find(
      (m) => (m as { method?: string }).method === 'session/load',
    ) as
      | {
          id?: unknown;
          params?: { sessionId?: string; cwd?: string; mcpServers?: unknown };
        }
      | undefined;
    expect(sentLoad).toBeDefined();
    expect(sentLoad?.params?.sessionId).toBe('sess-persisted');
    expect(sentLoad?.params?.cwd).toBe('/repo');
    expect(Array.isArray(sentLoad?.params?.mcpServers)).toBe(true);

    // Resolve so the test doesn't hang.
    conn.pushMessage({
      jsonrpc: '2.0',
      id: sentLoad!.id as number,
      result: {},
    });
    // `loadSession` now returns the full agent response so the caller
    // can seed session-meta (modes / models / configOptions) from it.
    // The fake agent responds with `{}` here — that's a valid empty
    // payload, so we just assert the resolution succeeds.
    const result = await loadPromise;
    expect(result).toEqual({});
  });

  it('rejects when the agent returns an error (caller falls back to newSession)', async () => {
    const conn = createFakeConnection();
    const client = new AcpAgentClient(conn, { logger: silentLogger });

    const loadPromise = client.loadSession({
      sessionId: 'sess-gone',
      cwd: '/repo',
    });
    await flush();

    const sentLoad = conn.sent.find(
      (m) => (m as { method?: string }).method === 'session/load',
    ) as { id?: number };
    conn.pushMessage({
      jsonrpc: '2.0',
      id: sentLoad.id as number,
      error: { code: -32602, message: 'unknown sessionId' },
    });
    await expect(loadPromise).rejects.toBeDefined();
  });
});
