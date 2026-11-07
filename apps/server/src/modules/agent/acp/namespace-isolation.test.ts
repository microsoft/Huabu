// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { once } from 'node:events';

import {
  AcpAgentHandle,
  _resetSpawnOrchestratorForTests,
  acpSessionRegistry,
  emptyAcpOverlay,
  ensureAcpSession,
} from '@agenetes/acp-driver';
import {
  ACP_UPGRADE_PATH,
  mountAgentletGateway,
} from '@agenetes/agentlet-host';
import {
  AgentletMethods,
  AgentMethods,
  PROTOCOL_VERSION,
  ServerMethods,
} from '@agentlet/protocol';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import type { AcpCreateSpec } from '@agenetes/acp-driver';
import type { Namespace } from '@agenetes/protocol';
import type { JsonRpcMessage, SpawnParams } from '@agentlet/protocol';

const DEVICE_ID = 'namespace-test-device';
const THREAD_ID = 'same-public-thread';
const TOKEN = 'test-only-gateway-token';
const logger = { debug() {}, info() {}, warn() {}, error() {} };
const binding = { alias: 'Fake ACP', profileId: 'same-profile' };

interface FakeProcess {
  appId: string;
  sessionId: string;
  pid: number;
  env: Record<string, string>;
  socket: WebSocket;
  history: string[];
  pending: Array<{ id: unknown; text: string }>;
  controls: string[];
  cancelled: string[];
  closed: boolean;
}

/**
 * Remote boundary following the stock local Agentlet: each spawn RPC creates
 * one native session/process; appId is only the host's correlation id. Stops
 * and cancellation address that native session. Gateway, ACP SDK/client,
 * session registry, startup coalescing, and handles remain real.
 */
class RemoteAgentlet {
  readonly app = Fastify({ logger: false });
  readonly gateway = mountAgentletGateway(this.app, {
    authenticate: (agentletId, token) => {
      if (agentletId !== DEVICE_ID || token !== TOKEN)
        throw new Error('Unknown test Agentlet');
      return { metadata: {} };
    },
  });
  readonly spawns: SpawnParams[] = [];
  readonly processes: FakeProcess[] = [];
  readonly stopped: string[] = [];
  readonly handles: AcpAgentHandle[] = [];
  readonly subscriptions: Array<() => void> = [];
  readonly errors: unknown[] = [];
  holdSpawns = false;
  holdPrompts = false;
  holdSpawnOwner: string | undefined;
  private daemon?: WebSocket;
  private url = '';
  private readonly sockets: WebSocket[] = [];
  private readonly pendingSpawns: Array<{ id: unknown; params: SpawnParams }> =
    [];

  async start(): Promise<void> {
    await this.app.listen({ host: '127.0.0.1', port: 0 });
    const address = this.app.server.address();
    if (!address || typeof address === 'string')
      throw new Error('Expected TCP');
    this.url = `ws://127.0.0.1:${address.port}${ACP_UPGRADE_PATH}`;
    this.daemon = await this.connect('agentlet', DEVICE_ID, {
      jsonrpc: '2.0',
      id: 1,
      method: AgentletMethods.HELLO,
      params: {
        agentletId: DEVICE_ID,
        agentletProfile: {
          bridge: { name: 'agentlet', version: PROTOCOL_VERSION },
          machine: { hostname: DEVICE_ID, platform: process.platform },
          capabilities: { autoRestart: true, bufferLimit: 1000, maxAgents: 20 },
        },
      },
    });
    this.daemon.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as JsonRpcMessage;
      if (!('method' in message)) return;
      if (message.method === ServerMethods.SPAWN && 'id' in message) {
        const params = message.params as unknown as SpawnParams;
        this.spawns.push(params);
        if (
          this.holdSpawns ||
          params.sessionSpec.env?.OWNER === this.holdSpawnOwner
        )
          this.pendingSpawns.push({ id: message.id, params });
        else this.launchAndReply(message.id, params);
      } else if (message.method === ServerMethods.STOP && 'id' in message) {
        const sessionId = (message.params as { sessionId: string }).sessionId;
        const native = this.processes.find(
          (candidate) => candidate.sessionId === sessionId,
        );
        if (native) {
          this.finishPrompts(native, true);
          native.closed = true;
          this.stopped.push(sessionId);
          native.socket.close();
        }
        this.reply(this.daemon, message.id, { stopped: true });
      }
    });
  }

  private reply(
    socket: WebSocket | undefined,
    id: unknown,
    result: unknown,
  ): void {
    if (socket?.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify({ jsonrpc: '2.0', id, result }));
  }

  private async connect(
    role: 'agentlet' | 'session',
    id: string,
    hello: unknown,
  ): Promise<WebSocket> {
    const socket = new WebSocket(
      `${this.url}?role=${role}&id=${encodeURIComponent(id)}&token=${TOKEN}`,
    );
    this.sockets.push(socket);
    await once(socket, 'open');
    const accepted = new Promise<void>((resolve, reject) => {
      const receive = (event: MessageEvent) => {
        const message = JSON.parse(String(event.data)) as JsonRpcMessage;
        if (!('id' in message) || message.id !== 1) return;
        socket.removeEventListener('message', receive);
        if ('error' in message) reject(new Error(message.error.message));
        else resolve();
      };
      socket.addEventListener('message', receive);
    });
    socket.send(JSON.stringify(hello));
    await accepted;
    return socket;
  }

  private launchAndReply(id: unknown, params: SpawnParams): void {
    void this.createProcess(params).then(
      (native) =>
        this.reply(this.daemon, id, {
          sessionId: native.sessionId,
          pid: native.pid,
        }),
      (error: unknown) => {
        this.errors.push(error);
        this.daemon?.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id,
            error: { code: -32000, message: String(error) },
          }),
        );
      },
    );
  }

  private async createProcess(params: SpawnParams): Promise<FakeProcess> {
    const ordinal = this.processes.length + 1;
    const sessionId = `native-${ordinal}`;
    // Reserve an ordinal before awaiting the handshake of another process.
    const native = {
      appId: params.appId,
      sessionId,
      pid: 1000 + ordinal,
      env: { ...params.sessionSpec.env },
      history: [],
      pending: [],
      controls: [],
      cancelled: [],
      closed: false,
    } as Omit<FakeProcess, 'socket'>;
    const slot = native as FakeProcess;
    this.processes.push(slot);
    slot.socket = await this.connect('session', sessionId, {
      jsonrpc: '2.0',
      id: 1,
      method: AgentMethods.HELLO,
      params: {
        sessionId,
        sessionProfile: {
          agentletId: DEVICE_ID,
          bridge: { name: 'agentlet', version: PROTOCOL_VERSION },
          agent: {
            command: params.sessionSpec.command,
            pid: native.pid,
            cwd: params.sessionSpec.cwd,
          },
          session: {
            supportsLoad: false,
            supportsResume: false,
            initializeResult: {
              protocolVersion: 1,
              agentInfo: { name: 'fake-acp', version: '1' },
            },
            newSessionResult: { sessionId },
          },
          capabilities: { autoRestart: false, bufferLimit: 1000 },
        },
      },
    });
    slot.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as JsonRpcMessage;
      if (!('method' in message)) return;
      if (message.method === 'session/prompt' && 'id' in message) {
        const prompt = (message.params as { prompt: Array<{ text?: string }> })
          .prompt;
        const text = prompt.map((part) => part.text ?? '').join('');
        slot.history.push(text);
        slot.pending.push({ id: message.id, text });
        if (!this.holdPrompts) this.finishPrompts(slot);
      } else if (message.method === 'session/cancel') {
        slot.controls.push(message.method);
        this.finishPrompts(slot, true);
      } else if ('id' in message) {
        slot.controls.push(message.method);
        this.reply(slot.socket, message.id, {});
      }
    });
    return slot;
  }

  finishPrompts(native: FakeProcess, cancelled = false): void {
    for (const request of native.pending.splice(0)) {
      if (cancelled) native.cancelled.push(request.text);
      else
        native.socket.send(
          JSON.stringify({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: native.sessionId,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: {
                  type: 'text',
                  text: JSON.stringify({
                    owner: native.env.OWNER,
                    history: native.history,
                  }),
                },
              },
            },
          }),
        );
      this.reply(native.socket, request.id, {
        stopReason: cancelled ? 'cancelled' : 'end_turn',
      });
    }
  }

  releaseSpawns(): void {
    this.holdSpawns = false;
    this.holdSpawnOwner = undefined;
    for (const { id, params } of this.pendingSpawns.splice(0))
      this.launchAndReply(id, params);
  }

  releasePrompts(): void {
    this.holdPrompts = false;
    for (const native of this.processes)
      if (native.socket) this.finishPrompts(native);
  }

  spec(
    namespace: Namespace,
    owner: string,
    threadId = THREAD_ID,
  ): AcpCreateSpec {
    return {
      kind: 'acp',
      workloadType: 'Deployment',
      threadId,
      namespace,
      spec: {
        agentletId: DEVICE_ID,
        binding,
        recipe: {
          alias: 'Fake ACP',
          command: `fake-acp --owner ${owner}`,
          cwd: `/work/${owner}`,
          autoRestart: false,
        },
        env: {
          OWNER: owner,
          HUABU_THREAD_ID: threadId,
          HUABU_RFS_URL: `http://rfs.example.test/w/${owner}/${namespace.name}`,
        },
      },
    };
  }

  handle(spec: AcpCreateSpec): AcpAgentHandle {
    const handle = new AcpAgentHandle(spec, {
      recovery: {
        authorizeHistoryLoad: async () => ({ allowed: true, estimatedSize: 0 }),
      },
    });
    this.handles.push(handle);
    return handle;
  }

  async close(): Promise<void> {
    this.releaseSpawns();
    this.releasePrompts();
    const reclaimed = await Promise.allSettled(
      this.handles.map((handle) => handle.close()),
    );
    for (const unsubscribe of this.subscriptions) unsubscribe();
    for (const socket of this.sockets) socket.close();
    await this.app.close();
    _resetSpawnOrchestratorForTests();
    expect(reclaimed.every((result) => result.status === 'fulfilled')).toBe(
      true,
    );
    expect(this.errors).toEqual([]);
    expect(this.app.server.listening).toBe(false);
    expect(acpSessionRegistry.size).toBe(0);
    expect(this.processes.every((native) => native.closed)).toBe(true);
    await expect
      .poll(() =>
        this.sockets.every((socket) => socket.readyState === WebSocket.CLOSED),
      )
      .toBe(true);
  }
}

async function fixture(
  test: (remote: RemoteAgentlet) => Promise<void>,
): Promise<void> {
  const remote = new RemoteAgentlet();
  try {
    await remote.start();
    await test(remote);
  } finally {
    await remote.close();
  }
}

async function turn(handle: AcpAgentHandle, text: string): Promise<string> {
  let response = '';
  for await (const event of handle.run(
    { type: 'user_text', content: text },
    { logger, overlay: emptyAcpOverlay() },
  )) {
    if (event.type === 'error') throw new Error(event.data.error);
    if (event.type === 'done') response = event.data.message ?? '';
  }
  return response;
}

const pairs = [
  {
    label: 'same Space name across Workspaces',
    a: { name: 'same-space', ownerId: 'workspace-A' },
    b: { name: 'same-space', ownerId: 'workspace-B' },
  },
  {
    label: 'different Spaces in one Workspace',
    a: { name: 'space-A', ownerId: 'workspace-A' },
    b: { name: 'space-B', ownerId: 'workspace-A' },
  },
  {
    label: 'legacy namespaces with distinct names',
    a: { name: 'legacy-A' },
    b: { name: 'legacy-B' },
  },
  {
    label: 'ownerless namespaces with one name but distinct storage roots',
    a: { name: 'same-legacy-space', storage: { root: '/legacy/A' } },
    b: { name: 'same-legacy-space', storage: { root: '/legacy/B' } },
  },
] satisfies Array<{ label: string; a: Namespace; b: Namespace }>;

describe('ACP native process and session namespace ownership', () => {
  it.each(pairs)(
    'isolates history, recipe and reachback for $label',
    ({ a, b }) =>
      fixture(async (remote) => {
        const first = remote.handle(remote.spec(a, 'A'));
        const second = remote.handle(remote.spec(b, 'B'));
        expect(JSON.parse(await turn(first, 'private-A'))).toEqual({
          owner: 'A',
          history: ['private-A'],
        });
        expect
          .soft(JSON.parse(await turn(second, 'private-B')))
          .toEqual({ owner: 'B', history: ['private-B'] });
        expect.soft(remote.processes).toHaveLength(2);
        expect
          .soft(new Set(remote.spawns.map((spawn) => spawn.appId)).size)
          .toBe(2);
        expect.soft(remote.spawns.map((spawn) => spawn.sessionSpec)).toEqual([
          expect.objectContaining({
            command: 'fake-acp --owner A',
            cwd: '/work/A',
            env: expect.objectContaining({
              OWNER: 'A',
              HUABU_THREAD_ID: THREAD_ID,
            }),
          }),
          expect.objectContaining({
            command: 'fake-acp --owner B',
            cwd: '/work/B',
            env: expect.objectContaining({
              OWNER: 'B',
              HUABU_THREAD_ID: THREAD_ID,
              HUABU_RFS_URL: `http://rfs.example.test/w/B/${b.name}`,
            }),
          }),
        ]);
      }),
  );

  it('coalesces only identical namespaces during concurrent native startup', () =>
    fixture(async (remote) => {
      remote.holdSpawns = true;
      const a = remote.spec(
        { name: 'same-space', ownerId: 'workspace-A' },
        'A',
      );
      const b = remote.spec(
        { name: 'same-space', ownerId: 'workspace-B' },
        'B',
      );
      remote.handle(a);
      remote.handle(b);
      const ensure = (spec: AcpCreateSpec) =>
        ensureAcpSession({
          agentletId: DEVICE_ID,
          threadId: THREAD_ID,
          binding,
          namespace: spec.namespace,
          recipe: spec.spec.recipe,
          env: spec.spec.env,
          logger,
        });
      const first = ensure(a);
      await expect.poll(() => remote.spawns.length).toBe(1);
      const duplicate = ensure(a);
      const other = ensure(b);
      const pending = Promise.all([first, duplicate, other]);
      // Capture any startup failure immediately and still rethrow it below.
      void pending.catch(() => {});
      try {
        await expect.poll(() => remote.spawns.length, { timeout: 500 }).toBe(2);
      } finally {
        remote.releaseSpawns();
        await pending;
      }
      const [entryA, entryAgain, entryB] = await pending;
      expect(entryA).toBe(entryAgain);
      expect.soft(entryB).not.toBe(entryA);
      expect.soft(entryB.sessionId).not.toBe(entryA.sessionId);
      expect.soft(entryB.namespace).toEqual(b.namespace);
      expect(entryA.threadId).toBe(THREAD_ID);
      expect(entryB.threadId).toBe(THREAD_ID);
    }));

  it('routes up-reported state only to its owning Namespace listener', () =>
    fixture(async (remote) => {
      const a = remote.handle(
        remote.spec({ name: 'same-space', ownerId: 'workspace-A' }, 'A'),
      );
      const b = remote.handle(
        remote.spec({ name: 'same-space', ownerId: 'workspace-B' }, 'B'),
      );
      const stateA: unknown[] = [];
      const stateB: unknown[] = [];
      remote.subscriptions.push(
        a.onState((state) => stateA.push(state)),
        b.onState((state) => stateB.push(state)),
      );
      await turn(a, 'private-A');
      expect.soft(stateA.length).toBeGreaterThan(0);
      expect.soft(stateB).toEqual([]);
      const aCount = stateA.length;
      await turn(b, 'private-B');
      expect(stateA).toHaveLength(aCount);
      expect(stateB.length).toBeGreaterThan(0);
    }));

  it.each(pairs.slice(0, 2))(
    'targets controls and close without replacing its peer: $label',
    ({ a, b }) =>
      fixture(async (remote) => {
        const first = remote.handle(remote.spec(a, 'A'));
        const second = remote.handle(remote.spec(b, 'B'));
        await turn(first, 'private-A');
        await turn(second, 'private-B');
        expect
          .soft(
            await first.control({
              type: 'set_mode',
              data: { modeId: 'operate' },
            }),
          )
          .toEqual({ ok: true });
        expect
          .soft(
            remote.processes
              .filter((native) => native.controls.includes('session/set_mode'))
              .map((native) => native.env.OWNER),
          )
          .toEqual(['A']);
        expect
          .soft(
            await second.control({
              type: 'set_model',
              data: { modelId: 'model-B' },
            }),
          )
          .toEqual({ ok: true });
        expect
          .soft(
            remote.processes
              .filter((native) => native.controls.includes('session/set_model'))
              .map((native) => native.env.OWNER),
          )
          .toEqual(['B']);
        const peer = remote.processes.find(
          (native) => native.env.OWNER === 'B',
        );
        await first.close();
        expect
          .soft(remote.stopped)
          .toEqual(
            remote.processes
              .filter((native) => native.env.OWNER === 'A')
              .map((native) => native.sessionId),
          );
        expect.soft(peer?.closed).toBe(false);
        expect
          .soft(
            await second.control({ type: 'set_mode', data: { modeId: 'ask' } }),
          )
          .toEqual({ ok: true });
        expect
          .soft(JSON.parse(await turn(second, 'second-B')))
          .toEqual({ owner: 'B', history: ['private-B', 'second-B'] });
        expect.soft(remote.processes).toHaveLength(2);
      }),
  );

  it('cancels one held native prompt without cancelling the other Namespace', () =>
    fixture(async (remote) => {
      remote.holdPrompts = true;
      const a = remote.handle(
        remote.spec({ name: 'same-space', ownerId: 'workspace-A' }, 'A'),
      );
      const b = remote.handle(
        remote.spec({ name: 'same-space', ownerId: 'workspace-B' }, 'B'),
      );
      const first = turn(a, 'private-A');
      const second = turn(b, 'private-B');
      let secondSettled = false;
      const observedSecond = second.then(
        (value) => {
          secondSettled = true;
          return { value };
        },
        (error: unknown) => {
          secondSettled = true;
          return { error };
        },
      );
      const completion = Promise.allSettled([first, observedSecond]);
      try {
        await expect
          .poll(
            () =>
              secondSettled ||
              remote.processes.reduce(
                (count, native) => count + native.pending.length,
                0,
              ) === 2,
          )
          .toBe(true);
        expect.soft(secondSettled).toBe(false);
        expect(await a.control({ type: 'cancel', data: {} })).toEqual({
          ok: true,
        });
        await first;
        expect.soft(secondSettled).toBe(false);
        expect
          .soft(remote.processes.flatMap((native) => native.cancelled))
          .toEqual(['private-A']);
      } finally {
        remote.releasePrompts();
        await completion;
      }
      expect.soft(await observedSecond).toEqual({
        value: JSON.stringify({ owner: 'B', history: ['private-B'] }),
      });
    }));

  it('finishes closing an in-flight startup without late process/registry ownership or harming a peer', () =>
    fixture(async (remote) => {
      const a = remote.handle(
        remote.spec(
          { name: 'space-A', ownerId: 'workspace-A' },
          'A',
          'closing-thread',
        ),
      );
      const b = remote.handle(
        remote.spec(
          { name: 'space-B', ownerId: 'workspace-B' },
          'B',
          'peer-thread',
        ),
      );
      await turn(b, 'private-B');
      remote.holdSpawnOwner = 'A';
      const starting = turn(a, 'private-A').catch(() => 'closed');
      await expect
        .poll(() =>
          remote.spawns.some((spawn) => spawn.sessionSpec.env?.OWNER === 'A'),
        )
        .toBe(true);
      const closing = a.close();
      remote.releaseSpawns();
      await Promise.all([starting, closing]);
      expect
        .soft(
          remote.processes
            .filter((native) => native.env.OWNER === 'A')
            .every((native) => native.closed),
        )
        .toBe(true);
      expect
        .soft(
          remote.processes
            .filter((native) => native.env.OWNER === 'A')
            .flatMap((native) => native.history),
        )
        .toEqual([]);
      expect.soft(acpSessionRegistry.size).toBe(1);
      expect(JSON.parse(await turn(b, 'second-B'))).toEqual({
        owner: 'B',
        history: ['private-B', 'second-B'],
      });
    }));

  it('keeps legacy no-owner reuse and public thread IDs separate from native routing keys', () =>
    fixture(async (remote) => {
      const handle = remote.handle(
        remote.spec({ name: 'legacy-space' }, 'legacy'),
      );
      await turn(handle, 'first');
      expect(JSON.parse(await turn(handle, 'second'))).toEqual({
        owner: 'legacy',
        history: ['first', 'second'],
      });
      expect(remote.spawns).toHaveLength(1);
      expect(remote.spawns[0].sessionSpec.env?.HUABU_THREAD_ID).toBe(THREAD_ID);
    }));

  it('keeps one native session when its Workspace/Space identity moves storage roots', () =>
    fixture(async (remote) => {
      const spec = remote.spec(
        {
          ownerId: 'workspace-A',
          name: 'same-space',
          storage: { root: '/original/storage' },
        },
        'A',
      );
      const moved = {
        ...spec,
        namespace: { ...spec.namespace, storage: { root: '/moved/storage' } },
      };
      const first = remote.handle(spec);
      const second = remote.handle(moved);
      await turn(first, 'first');
      expect(JSON.parse(await turn(second, 'second'))).toEqual({
        owner: 'A',
        history: ['first', 'second'],
      });
      expect(remote.spawns).toHaveLength(1);
      expect(remote.processes).toHaveLength(1);
    }));
});
