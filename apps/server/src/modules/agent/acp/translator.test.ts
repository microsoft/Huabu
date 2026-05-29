/**
 * Tests for the ACP `session/update` → `AgentStreamEvent` translator.
 *
 * Coverage matrix:
 *
 *   ✓ schema validation gate rejects malformed payloads
 *   ✓ five active discriminators map to the right SSE variant
 *   ✓ ignored discriminators return null (no false-positive)
 *   ✓ unknown discriminator increments the unknown counter
 *   ✓ `tool_call` without `kind` increments the missing-kind counter
 *   ✓ `tool_call_update` coerces `null` → `undefined` per ACP semantics
 *   ✓ counter accessors are pure snapshots (mutations don't leak)
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  acpUpdateToStreamEvent,
  getTranslatorCounters,
  resetTranslatorCounters,
  type TranslatorLogger,
} from './translator.js';

const silentLogger: TranslatorLogger = {
  info: () => undefined,
  warn: () => undefined,
};

beforeEach(() => {
  resetTranslatorCounters();
});

describe('acpUpdateToStreamEvent — schema validation', () => {
  it('returns null and bumps invalidPayloads on malformed input', () => {
    const evt = acpUpdateToStreamEvent({ not: 'acp' }, silentLogger);
    expect(evt).toBeNull();
    expect(getTranslatorCounters().invalidPayloads).toBe(1);
  });

  it('returns null when sessionUpdate is missing', () => {
    const evt = acpUpdateToStreamEvent({
      content: { type: 'text', text: 'x' },
    });
    expect(evt).toBeNull();
    expect(getTranslatorCounters().invalidPayloads).toBe(1);
  });
});

describe('acpUpdateToStreamEvent — active discriminators', () => {
  it('maps agent_message_chunk(text) → text_delta', () => {
    const evt = acpUpdateToStreamEvent({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'hello' },
    });
    expect(evt).toEqual({ type: 'text_delta', data: { content: 'hello' } });
  });

  it('maps agent_thought_chunk(text) → thinking_delta', () => {
    const evt = acpUpdateToStreamEvent({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'thinking…' },
    });
    expect(evt).toEqual({
      type: 'thinking_delta',
      data: { content: 'thinking…' },
    });
  });

  it('drops agent_message_chunk when content is not text', () => {
    const evt = acpUpdateToStreamEvent({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'image', data: 'b64', mimeType: 'image/png' },
    });
    expect(evt).toBeNull();
  });

  it('maps tool_call with kind → tool_call event', () => {
    const evt = acpUpdateToStreamEvent({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-1',
      title: 'Read file',
      kind: 'read',
      status: 'pending',
      content: [],
      locations: [{ path: '/foo' }],
      rawInput: { path: '/foo' },
    });
    expect(evt).toMatchObject({
      type: 'tool_call',
      data: {
        toolCallId: 'tc-1',
        title: 'Read file',
        toolKind: 'read',
        status: 'pending',
      },
    });
    expect(getTranslatorCounters().toolCallMissingKind).toBe(0);
  });

  it('counts tool_call without kind but still forwards the event', () => {
    const evt = acpUpdateToStreamEvent({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-2',
      title: 'Mystery tool',
    });
    expect(evt?.type).toBe('tool_call');
    expect(getTranslatorCounters().toolCallMissingKind).toBe(1);
  });

  it('maps tool_call_update with null fields → undefined', () => {
    const evt = acpUpdateToStreamEvent({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-3',
      status: 'completed',
      title: null,
      content: null,
      locations: null,
      rawOutput: { ok: true },
    });
    expect(evt).toEqual({
      type: 'tool_call_update',
      data: {
        toolCallId: 'tc-3',
        status: 'completed',
        title: undefined,
        content: undefined,
        locations: undefined,
        rawOutput: { ok: true },
      },
    });
  });

  it('maps plan → plan event', () => {
    const entries = [
      {
        content: 'step 1',
        status: 'pending' as const,
        priority: 'high' as const,
      },
    ];
    const evt = acpUpdateToStreamEvent({
      sessionUpdate: 'plan',
      entries,
    });
    expect(evt).toEqual({ type: 'plan', data: { entries } });
  });

  it('maps current_mode_update → session_mode_update', () => {
    const evt = acpUpdateToStreamEvent({
      sessionUpdate: 'current_mode_update',
      currentModeId: 'agent',
    });
    expect(evt).toEqual({
      type: 'session_mode_update',
      data: { currentModeId: 'agent' },
    });
  });

  it('maps config_option_update (select option) → config_options_update', () => {
    const options = [
      {
        id: 'model',
        name: 'Model',
        type: 'select',
        currentValue: 'gpt-5',
        options: [
          { name: 'GPT-5', value: 'gpt-5' },
          { name: 'Claude 4', value: 'claude-4' },
        ],
      },
    ];
    const evt = acpUpdateToStreamEvent({
      sessionUpdate: 'config_option_update',
      configOptions: options,
    });
    expect(evt).toMatchObject({
      type: 'config_options_update',
      data: { options },
    });
  });

  it('maps config_option_update (boolean option) → config_options_update', () => {
    const options = [
      {
        id: 'auto_approve',
        name: 'Auto-approve',
        type: 'boolean',
        currentValue: true,
      },
    ];
    const evt = acpUpdateToStreamEvent({
      sessionUpdate: 'config_option_update',
      configOptions: options,
    });
    expect(evt).toEqual({
      type: 'config_options_update',
      data: { options },
    });
  });

  it('maps session_info_update → session_info_update', () => {
    const evt = acpUpdateToStreamEvent({
      sessionUpdate: 'session_info_update',
      title: 'My session',
      updatedAt: '2025-01-01T00:00:00Z',
    });
    expect(evt).toEqual({
      type: 'session_info_update',
      data: {
        title: 'My session',
        updatedAt: '2025-01-01T00:00:00Z',
      },
    });
  });

  it('maps usage_update → session_usage_update', () => {
    const evt = acpUpdateToStreamEvent({
      sessionUpdate: 'usage_update',
      used: 1024,
      size: 200_000,
    });
    expect(evt).toEqual({
      type: 'session_usage_update',
      data: { used: 1024, size: 200_000, cost: null },
    });
  });
});

describe('acpUpdateToStreamEvent — ignored discriminators', () => {
  it.each(['user_message_chunk', 'available_commands_update'])(
    'returns null for %s (no counter bump)',
    (kind) => {
      let payload: unknown;
      if (kind === 'user_message_chunk') {
        payload = {
          sessionUpdate: kind,
          content: { type: 'text', text: 'hi' },
        };
      } else {
        payload = { sessionUpdate: kind, availableCommands: [] };
      }
      expect(acpUpdateToStreamEvent(payload)).toBeNull();
      expect(getTranslatorCounters().unknownSessionUpdate).toBe(0);
      expect(getTranslatorCounters().invalidPayloads).toBe(0);
    },
  );
});

describe('counters', () => {
  it('getTranslatorCounters returns an isolated snapshot', () => {
    acpUpdateToStreamEvent({ bogus: true }, silentLogger);
    const snap = getTranslatorCounters();
    expect(snap.invalidPayloads).toBe(1);
    // Mutating the snapshot must not affect the live counter.
    (snap as { invalidPayloads: number }).invalidPayloads = 999;
    expect(getTranslatorCounters().invalidPayloads).toBe(1);
  });

  it('resetTranslatorCounters zeros every counter', () => {
    acpUpdateToStreamEvent({ bogus: true }, silentLogger);
    expect(getTranslatorCounters().invalidPayloads).toBe(1);
    resetTranslatorCounters();
    expect(getTranslatorCounters()).toEqual({
      invalidPayloads: 0,
      toolCallMissingKind: 0,
      unknownSessionUpdate: 0,
    });
  });
});
