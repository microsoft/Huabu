// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * M1 acceptance — L1<->L2 contract conformance.
 *
 * Proves the frozen `@agenetes/protocol` wire schemas can express both
 * drivers' CURRENT behaviour (§7 M1 acceptance criterion 1), without yet
 * wiring the protocol into the server/web runtime (that is M2). Two layers
 * of evidence:
 *
 *   - Type-level: the existing `@huabu/shared` `AgentStreamEvent`, once
 *     the protocol core is re-extended with the two documented host fields
 *     (`meta.mode`, `tool_call.internalToolName`), is assignable to the
 *     shared union — so the protocol schema has not dropped or mistyped
 *     any current field.
 *   - Runtime: representative fixtures typed with the CURRENT shared
 *     interfaces `safeParse` cleanly against the protocol schemas; current
 *     control-route request bodies map onto `ControlMsg`; and a
 *     `WorkloadSpec` for each driver round-trips.
 */

import {
  agentCapabilitiesSchema,
  agentStateSnapshotSchema,
  agentSubmissionSchema,
  agentStreamEventSchema,
  controlAckSchema,
  controlMsgSchema,
  namespaceSchema,
  resolveAgentInputs,
  workloadSpecSchema,
  type AgentStreamEvent as ProtocolStreamEvent,
  type ControlMsg,
  type Namespace,
} from '@agenetes/protocol';
import { describe, expect, it } from 'vitest';

import type {
  AgentConfigOptionsUpdateEventData,
  AgentDoneEventData,
  AgentEndEventData,
  AgentErrorEventData,
  AgentMetaEventData,
  AgentMode,
  AgentPermissionRequestEventData,
  AgentPlanEventData,
  AgentSessionInfoUpdateEventData,
  AgentSessionModeUpdateEventData,
  AgentSessionUsageUpdateEventData,
  AgentStreamEvent as SharedStreamEvent,
  AgentTextDeltaEventData,
  AgentThinkingDeltaEventData,
  AgentToolCallEventData,
  AgentToolCallUpdateEventData,
} from '../agent/agent.js';
import type {
  AcpPermissionDecisionRequest,
  SetAcpSessionConfigOptionRequest,
  SetAcpSessionModeRequest,
  SetAcpSessionModelRequest,
} from '../api/acp.js';

// ── Type-level: protocol core + host fields reconstructs the shared union ──
//
// Re-extend the two protocol events that intentionally omit a host-specific
// field, then assert the reconstructed union is assignable to the current
// shared `AgentStreamEvent`. If the protocol schema had dropped a required
// field or narrowed a field type, this would fail to compile.

type HostStreamEvent = ProtocolStreamEvent extends infer E
  ? E extends { type: 'meta'; data: infer D }
    ? { type: 'meta'; data: D & { mode: AgentMode } }
    : E extends { type: 'tool_call'; data: infer D }
      ? { type: 'tool_call'; data: D & { internalToolName?: string } }
      : E
  : never;

/** Compile-time assertion: `Source` must be assignable to `Target`. */
type AssertAssignable<Target, Source extends Target> = Source;

// Errors at compile time if the reconstructed protocol union is not a
// subtype of the current shared union.
type _HostEventIsSharedEvent = AssertAssignable<
  SharedStreamEvent,
  HostStreamEvent
>;

describe('AgentStreamEvent conformance', () => {
  it('validates a fixture for every current event type', () => {
    // Each fixture is typed with the CURRENT shared interface (so the shape
    // is checked against today's code) and includes the host-specific field
    // where one exists — the protocol core strips it on parse.
    const meta: AgentMetaEventData = { threadId: 'thr_1', mode: 'ask' };
    const textDelta: AgentTextDeltaEventData = { content: 'hi' };
    const thinkingDelta: AgentThinkingDeltaEventData = { content: 'hmm' };
    const toolCall: AgentToolCallEventData = {
      toolCallId: 't1',
      title: 'Read app.ts',
      command: 'cat app.ts',
      status: 'pending',
      locations: [{ path: '/app.ts' }],
      content: [{ type: 'content', content: { type: 'text', text: 'ok' } }],
      rawInput: { path: 'app.ts' },
      internalToolName: 'read',
    };
    const toolCallUpdate: AgentToolCallUpdateEventData = {
      toolCallId: 't1',
      status: 'completed',
      rawOutput: { bytes: 42 },
    };
    const plan: AgentPlanEventData = {
      entries: [{ content: 'step one', priority: 'high', status: 'pending' }],
    };
    const permission: AgentPermissionRequestEventData = {
      requestId: 'r1',
      toolCall: { title: 'rm -rf', kind: 'delete' },
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
    };
    const configOptions: AgentConfigOptionsUpdateEventData = { options: [] };
    const sessionMode: AgentSessionModeUpdateEventData = {
      currentModeId: 'ask',
    };
    const sessionInfo: AgentSessionInfoUpdateEventData = {
      title: 'My thread',
      updatedAt: null,
    };
    const sessionUsage: AgentSessionUsageUpdateEventData = {
      used: 10,
      size: 100,
      cost: null,
    };
    const done: AgentDoneEventData = {
      message: 'all done',
      meta: { stopReason: 'end_turn', iterations: 2 },
    };
    const error: AgentErrorEventData = { error: 'boom' };
    const end: AgentEndEventData = {};

    const frames: SharedStreamEvent[] = [
      { type: 'meta', data: meta },
      { type: 'text_delta', data: textDelta },
      { type: 'thinking_delta', data: thinkingDelta },
      { type: 'tool_call', data: toolCall },
      { type: 'tool_call_update', data: toolCallUpdate },
      { type: 'plan', data: plan },
      { type: 'permission_request', data: permission },
      { type: 'config_options_update', data: configOptions },
      { type: 'session_mode_update', data: sessionMode },
      { type: 'session_info_update', data: sessionInfo },
      { type: 'session_usage_update', data: sessionUsage },
      { type: 'done', data: done },
      { type: 'error', data: error },
      { type: 'end', data: end },
    ];

    for (const frame of frames) {
      const result = agentStreamEventSchema.safeParse(frame);
      expect(result.success, `event "${frame.type}" should validate`).toBe(
        true,
      );
    }
  });

  it('strips the host-specific fields from the core payloads', () => {
    const parsed = agentStreamEventSchema.parse({
      type: 'meta',
      data: { threadId: 'thr_1', mode: 'operate' },
    });
    expect(parsed).toEqual({ type: 'meta', data: { threadId: 'thr_1' } });

    const toolCall = agentStreamEventSchema.parse({
      type: 'tool_call',
      data: { toolCallId: 't1', title: 'x', internalToolName: 'grep' },
    });
    expect(toolCall.data).not.toHaveProperty('internalToolName');
  });
});

// ── ControlMsg — current control-route bodies are expressible ──────────
//
// The protocol renames `configOptionId`->`optionId` and restructures the
// flat permission body into a tagged `decision`; the host-only spawn
// context (profileId / canvasId / cwd) is dropped (threadId already names
// the slot). These mappers show every current control op is expressible.

const toCancel = (): ControlMsg => ({ type: 'cancel', data: {} });

const toSetMode = (req: SetAcpSessionModeRequest): ControlMsg => ({
  type: 'set_mode',
  data: { modeId: req.modeId },
});

const toSetModel = (req: SetAcpSessionModelRequest): ControlMsg => ({
  type: 'set_model',
  data: { modelId: req.modelId },
});

const toSetConfigOption = (
  req: SetAcpSessionConfigOptionRequest,
): ControlMsg => ({
  type: 'set_config_option',
  data: { optionId: req.configOptionId, value: req.value },
});

const toAnswerPermission = (req: AcpPermissionDecisionRequest): ControlMsg => ({
  type: 'answer_permission',
  data: {
    requestId: req.requestId,
    decision:
      req.optionId !== undefined && !req.cancelled
        ? { optionId: req.optionId }
        : { cancelled: true },
  },
});

describe('ControlMsg conformance', () => {
  it('maps every current control-route body onto a valid ControlMsg', () => {
    const msgs: ControlMsg[] = [
      toCancel(),
      toSetMode({ modeId: 'agent', profileId: 'p1', canvasId: 'c1' }),
      toSetModel({ modelId: 'gpt-5', cwd: '/repo' }),
      toSetConfigOption({ configOptionId: 'auto-approve', value: true }),
      toSetConfigOption({ configOptionId: 'thought-level', value: 'high' }),
      toAnswerPermission({ requestId: 'r1', optionId: 'allow' }),
      toAnswerPermission({ requestId: 'r2', cancelled: true }),
    ];

    for (const msg of msgs) {
      const result = controlMsgSchema.safeParse(msg);
      expect(result.success, `control "${msg.type}" should validate`).toBe(
        true,
      );
    }
  });

  it('accepts the ControlAck shapes', () => {
    expect(controlAckSchema.safeParse({ ok: true }).success).toBe(true);
    expect(
      controlAckSchema.safeParse({ ok: false, error: 'unsupported' }).success,
    ).toBe(true);
    expect(controlAckSchema.safeParse({ ok: false }).success).toBe(false);
  });

  it('expresses Job vs Deployment capability sets', () => {
    // A Job's near-empty control plane.
    const job = agentCapabilitiesSchema.parse({
      supportedControlMessages: ['cancel'],
    });
    expect(job.turnInput).toBe('blocking');

    // A Deployment's full, capability-gated surface.
    const deployment = agentCapabilitiesSchema.safeParse({
      supportedControlMessages: [
        'cancel',
        'set_mode',
        'set_model',
        'set_config_option',
        'answer_permission',
        'set_context',
      ],
      loadSession: true,
      turnInput: 'queue',
    });
    expect(deployment.success).toBe(true);
  });
});

// ── Opaque WorkloadSpec — both current drivers are expressible ─────────
//
// Driver payloads stay opaque at the protocol boundary. Each mounted driver
// owns its complete nested schema and validates after direct kind dispatch.

describe('opaque WorkloadSpec conformance', () => {
  it('expresses an internal-driver Job without per-turn input', () => {
    const spec = {
      kind: 'internal',
      workloadType: 'Job',
      namespace: {
        name: 'canvas_1',
        storage: { root: '/data/history/canvas_1' },
      },
      threadId: 'thr_1',
      spec: { agentId: 'ask', tools: ['read', 'space_commands'] },
    };
    expect(workloadSpecSchema.safeParse(spec).success).toBe(true);
  });

  it('allows a transient Job to use the current empty thread sentinel', () => {
    const spec = {
      kind: 'internal',
      workloadType: 'Job',
      namespace: { name: 'canvas_1' },
      threadId: '',
      spec: { agentId: 'ask', tools: [] },
    };
    expect(workloadSpecSchema.safeParse(spec).success).toBe(true);
  });

  it('expresses an external-driver Deployment with nested instructions', () => {
    const spec = {
      kind: 'external',
      workloadType: 'Deployment',
      namespace: {
        name: 'canvas_2',
        storage: { root: '/data/history/canvas_2' },
      },
      threadId: 'thr_2',
      spec: {
        initialPreamble: ['agent identity', 'tool policy'],
        profileId: 'copilot',
        alias: 'Copilot',
        cwd: '/repo',
      },
    };
    expect(workloadSpecSchema.safeParse(spec).success).toBe(true);
  });

  it('preserves canonical inputs and resolves generic fallbacks', () => {
    const rendered = agentSubmissionSchema.parse({
      type: 'huabu.selection',
      content: { nodeIds: ['n1', 'n2'] },
      rendered: [
        { type: 'text', text: 'Selected nodes: n1, n2' },
        {
          type: 'parts',
          parts: [
            { type: 'text', text: 'Reference image' },
            { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
          ],
        },
      ],
    });
    expect(resolveAgentInputs(rendered)).toEqual(rendered.rendered);

    expect(resolveAgentInputs({ type: 'text', content: 'hello' })).toEqual([
      { type: 'text', text: 'hello' },
    ]);
    expect(
      resolveAgentInputs({
        type: 'huabu.selection',
        content: { nodeIds: ['n1', 'n2'] },
      }),
    ).toEqual([
      {
        type: 'text',
        text: '{"nodeIds":["n1","n2"]}',
      },
    ]);
    expect(
      resolveAgentInputs({ type: 'text', content: 'ignored', rendered: [] }),
    ).toEqual([]);
  });

  it('rejects mixed command sequences', () => {
    expect(
      agentSubmissionSchema.safeParse({
        type: 'huabu.chat',
        content: {},
        rendered: [
          { type: 'command', text: '/review', context: [] },
          { type: 'text', text: 'extra' },
        ],
      }).success,
    ).toBe(false);

    expect(
      agentSubmissionSchema.safeParse({
        type: 'huabu.chat',
        content: {},
        rendered: [
          {
            type: 'command',
            text: '/review',
            context: [{ type: 'text', text: 'selected code' }],
          },
        ],
      }).success,
    ).toBe(true);
  });

  it('round-trips durable preamble delivery state independently of sessionId', () => {
    expect(
      agentStateSnapshotSchema.parse({
        driverState: {
          sessionId: 'session_1',
          initialPreambleDelivered: false,
        },
      }),
    ).toEqual({
      driverState: {
        sessionId: 'session_1',
        initialPreambleDelivered: false,
      },
    });
  });

  it('requires a namespace on every WorkloadSpec member', () => {
    const spec = {
      kind: 'external',
      workloadType: 'Deployment',
      threadId: 'thr_3',
      spec: { profileId: 'copilot', alias: 'Copilot' },
    };
    expect(workloadSpecSchema.safeParse(spec).success).toBe(false);
  });
});

// ── Namespace — the storage/metadata scope above threadId (§7 M5.0) ─────
describe('Namespace conformance', () => {
  it('accepts a name-only namespace (storage optional)', () => {
    const parsed = namespaceSchema.safeParse({ name: 'canvas_1' });
    expect(parsed.success).toBe(true);
  });

  it('accepts an explicit storage.root', () => {
    const ns: Namespace = { name: 'canvas_1', storage: { root: '/data/c1' } };
    expect(namespaceSchema.safeParse(ns).success).toBe(true);
  });

  it('rejects an empty name', () => {
    expect(namespaceSchema.safeParse({ name: '' }).success).toBe(false);
  });
});
