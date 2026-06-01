/**
 * Tests for the ephemeral pairing-token store.
 *
 * Coverage:
 *   ✓ createTicket returns a pending ticket with a fresh code + id
 *   ✓ validate transitions pending → claimed and snapshots the agent info
 *   ✓ validate rejects an unknown code
 *   ✓ validate accepts the same agentId on reconnect after claim
 *   ✓ validate rejects a different agentId trying to re-use a claimed token
 *   ✓ pending ticket auto-expires after the 60s window
 *   ✓ markDisconnected drops every ticket bound to that agentId
 *   ✓ revoke removes the ticket by id and is a no-op for unknown ids
 *   ✓ list snapshots every active ticket
 *   ✓ multiple concurrent pending tickets are independent
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PAIRING_PENDING_TTL_MS,
  _resetTokenStoreForTests,
  getTokenStore,
} from './token-store.js';

import type { BridgeHelloParams } from '@agentlet/protocol';

function hello(
  token: string,
  agentId: string,
  command = 'copilot --acp',
): BridgeHelloParams {
  return {
    token,
    agentId,
    bridge: { name: 'agentlet', version: '0.0.0' },
    agent: { command, pid: 1234 },
    capabilities: { autoRestart: false, bufferLimit: 100 },
  };
}

beforeEach(() => {
  _resetTokenStoreForTests();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  _resetTokenStoreForTests();
});

describe('token-store · createTicket', () => {
  it('mints a pending ticket with a code and id', () => {
    const ticket = getTokenStore().createTicket();
    expect(ticket.status).toBe('pending');
    expect(ticket.code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(ticket.id).toMatch(/^[0-9a-f-]+$/);
    expect(ticket.expiresAt).toBeGreaterThan(Date.now());
    expect(ticket.claimedAgentId).toBeUndefined();
  });

  it('returns distinct codes for back-to-back tickets', () => {
    const a = getTokenStore().createTicket();
    const b = getTokenStore().createTicket();
    expect(a.code).not.toBe(b.code);
    expect(a.id).not.toBe(b.id);
  });
});

describe('token-store · validate', () => {
  it('transitions pending → claimed on the first hello', () => {
    const store = getTokenStore();
    const ticket = store.createTicket();
    const result = store.validate(ticket.code, hello(ticket.code, 'agent-1'));
    expect(result.metadata).toEqual({ ticketId: ticket.id });

    const listed = store.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: ticket.id,
      status: 'claimed',
      claimedAgentId: 'agent-1',
      claimedAlias: 'copilot',
      claimedCommand: 'copilot --acp',
    });
  });

  it('throws on an unknown code', () => {
    expect(() =>
      getTokenStore().validate('NEVER-MIND', hello('NEVER-MIND', 'a')),
    ).toThrowError(/invalid or expired/i);
  });

  it('throws when the hello has no agentId', () => {
    const store = getTokenStore();
    const ticket = store.createTicket();
    expect(() =>
      store.validate(ticket.code, hello(ticket.code, '')),
    ).toThrowError(/missing agentId/i);
  });

  it('accepts the same agentId on reconnect', () => {
    const store = getTokenStore();
    const ticket = store.createTicket();
    store.validate(ticket.code, hello(ticket.code, 'agent-1'));
    // simulate a later reconnect — still authorised
    const result = store.validate(ticket.code, hello(ticket.code, 'agent-1'));
    expect(result.metadata).toEqual({ ticketId: ticket.id });
  });

  it('rejects a different agentId trying to steal a claimed token', () => {
    const store = getTokenStore();
    const ticket = store.createTicket();
    store.validate(ticket.code, hello(ticket.code, 'agent-original'));
    expect(() =>
      store.validate(ticket.code, hello(ticket.code, 'agent-attacker')),
    ).toThrowError(/already claimed/i);
  });
});

describe('token-store · expiry', () => {
  it('auto-expires a pending ticket after the 60s window', () => {
    const store = getTokenStore();
    const ticket = store.createTicket();
    vi.advanceTimersByTime(PAIRING_PENDING_TTL_MS + 10);
    // The pending timer should have dropped the ticket entirely.
    expect(store.list()).toHaveLength(0);
    expect(() =>
      store.validate(ticket.code, hello(ticket.code, 'agent-late')),
    ).toThrowError(/invalid or expired/i);
  });

  it('does NOT expire a ticket that was claimed in time', () => {
    const store = getTokenStore();
    const ticket = store.createTicket();
    // Claim 100ms before the window closes.
    vi.advanceTimersByTime(PAIRING_PENDING_TTL_MS - 100);
    store.validate(ticket.code, hello(ticket.code, 'agent-1'));
    vi.advanceTimersByTime(PAIRING_PENDING_TTL_MS * 10);
    // Still valid for the same agentId.
    expect(() =>
      store.validate(ticket.code, hello(ticket.code, 'agent-1')),
    ).not.toThrow();
  });
});

describe('token-store · disconnect & revoke', () => {
  it('markDisconnected drops every ticket bound to that agentId', () => {
    const store = getTokenStore();
    const t1 = store.createTicket();
    const t2 = store.createTicket();
    const t3 = store.createTicket();
    store.validate(t1.code, hello(t1.code, 'agent-A'));
    store.validate(t2.code, hello(t2.code, 'agent-B'));
    // t3 stays pending.

    store.markDisconnected('agent-A');
    const remaining = store
      .list()
      .map((t) => t.id)
      .sort();
    expect(remaining).toEqual([t2.id, t3.id].sort());
  });

  it('markDisconnected is a no-op when no ticket matches', () => {
    const store = getTokenStore();
    store.createTicket();
    store.markDisconnected('agent-ghost');
    expect(store.list()).toHaveLength(1);
  });

  it('revoke removes by id', () => {
    const store = getTokenStore();
    const ticket = store.createTicket();
    expect(store.revoke(ticket.id)).toBe(true);
    expect(store.list()).toHaveLength(0);
  });

  it('revoke returns false for unknown ids', () => {
    expect(getTokenStore().revoke('nope')).toBe(false);
  });
});

describe('token-store · list', () => {
  it('snapshots every still-active ticket', () => {
    const store = getTokenStore();
    const t1 = store.createTicket();
    const t2 = store.createTicket();
    store.validate(t2.code, hello(t2.code, 'agent-1'));
    const snapshot = store.list();
    expect(snapshot.map((t) => t.id).sort()).toEqual([t1.id, t2.id].sort());
    const claimed = snapshot.find((t) => t.id === t2.id);
    expect(claimed?.status).toBe('claimed');
    expect(claimed?.claimedAgentId).toBe('agent-1');
  });
});
