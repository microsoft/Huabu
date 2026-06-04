/**
 * Tests for the pairing-token store.
 *
 * Coverage:
 *   ✓ createTicket returns a pending ticket with a fresh code + id
 *   ✓ validate transitions pending → claimed and snapshots the agent info
 *   ✓ validate rejects an unknown code
 *   ✓ validate accepts the same agentId on reconnect after claim
 *   ✓ validate rejects a different agentId trying to re-use a claimed token
 *   ✓ pending ticket auto-expires after the 60s window
 *   ✓ markDisconnected arms a grace timer (not an immediate drop)
 *   ✓ reconnect within the grace window cancels the grace timer
 *   ✓ grace window elapsing with no reconnect drops the ticket
 *   ✓ revoke removes the ticket by id and is a no-op for unknown ids
 *   ✓ list snapshots every active ticket
 *   ✓ multiple concurrent pending tickets are independent
 *   ✓ persistence: claimed tickets survive a singleton reset (server restart)
 *   ✓ persistence: pending tickets are NOT persisted
 *   ✓ persistence: revoke removes the on-disk entry too
 *   ✓ persistence: grace-window expiry removes the on-disk entry too
 *   ✓ persistence: missing or corrupted file produces a clean empty state
 */

import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PAIRING_PENDING_TTL_MS,
  PAIRING_RECONNECT_GRACE_MS,
  _resetTokenStoreForTests,
  _setPersistPathForTests,
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
    agent: { command, pid: 1234, cwd: '/tmp/fake' },
    capabilities: { autoRestart: false, bufferLimit: 100 },
  };
}

beforeEach(() => {
  _resetTokenStoreForTests();
  // Existing in-memory tests must not touch the real data directory.
  // The persistence suite below opts back in with its own tmpdir path.
  _setPersistPathForTests(null);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  _resetTokenStoreForTests();
  _setPersistPathForTests(null);
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
  it('markDisconnected does NOT immediately drop tickets (grace window)', () => {
    const store = getTokenStore();
    const t1 = store.createTicket();
    const t2 = store.createTicket();
    const t3 = store.createTicket();
    store.validate(t1.code, hello(t1.code, 'agent-A'));
    store.validate(t2.code, hello(t2.code, 'agent-B'));
    // t3 stays pending.

    store.markDisconnected('agent-A');
    // Every ticket should still be present right after the disconnect —
    // the grace timer has just been armed for t1, not fired.
    const remaining = store
      .list()
      .map((t) => t.id)
      .sort();
    expect(remaining).toEqual([t1.id, t2.id, t3.id].sort());
  });

  it('markDisconnected drops the ticket once the grace window elapses', () => {
    const store = getTokenStore();
    const ticket = store.createTicket();
    store.validate(ticket.code, hello(ticket.code, 'agent-A'));
    store.markDisconnected('agent-A');
    vi.advanceTimersByTime(PAIRING_RECONNECT_GRACE_MS + 1_000);
    expect(store.list()).toHaveLength(0);
    expect(() =>
      store.validate(ticket.code, hello(ticket.code, 'agent-A')),
    ).toThrowError(/invalid or expired/i);
  });

  it('reconnect within the grace window cancels the grace timer', () => {
    const store = getTokenStore();
    const ticket = store.createTicket();
    store.validate(ticket.code, hello(ticket.code, 'agent-A'));
    store.markDisconnected('agent-A');
    // Reconnect partway through the grace window.
    vi.advanceTimersByTime(60_000);
    expect(() =>
      store.validate(ticket.code, hello(ticket.code, 'agent-A')),
    ).not.toThrow();
    // Advancing well past the original grace window must not drop the
    // ticket — the timer should have been cleared by the reconnect.
    vi.advanceTimersByTime(PAIRING_RECONNECT_GRACE_MS * 2);
    expect(store.list()).toHaveLength(1);
  });

  it('markDisconnected is idempotent (does not extend the grace window)', () => {
    const store = getTokenStore();
    const ticket = store.createTicket();
    store.validate(ticket.code, hello(ticket.code, 'agent-A'));
    store.markDisconnected('agent-A');
    // Spurious extra close events from `ws` should not extend the window.
    vi.advanceTimersByTime(PAIRING_RECONNECT_GRACE_MS - 100);
    store.markDisconnected('agent-A');
    vi.advanceTimersByTime(200);
    expect(store.list()).toHaveLength(0);
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

  it('revoke during the grace window also clears the grace timer', () => {
    const store = getTokenStore();
    const ticket = store.createTicket();
    store.validate(ticket.code, hello(ticket.code, 'agent-A'));
    store.markDisconnected('agent-A');
    expect(store.revoke(ticket.id)).toBe(true);
    // Advancing past the grace window must not throw / re-fire.
    vi.advanceTimersByTime(PAIRING_RECONNECT_GRACE_MS * 2);
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

describe('token-store · persistence', () => {
  let tmpDir: string;
  let persistPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'acp-tokens-'));
    persistPath = join(tmpDir, `acp-tickets-${randomUUID()}.json`);
    _resetTokenStoreForTests();
    _setPersistPathForTests(persistPath);
  });

  afterEach(() => {
    _resetTokenStoreForTests();
    _setPersistPathForTests(null);
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; ignore.
    }
  });

  it('claimed tickets survive a singleton reset (simulated server restart)', () => {
    const first = getTokenStore();
    const ticket = first.createTicket();
    first.validate(ticket.code, hello(ticket.code, 'agent-A'));

    // Simulate server restart: drop the singleton (but keep the same
    // persistPath so the rehydrate reads the file we just wrote).
    _resetTokenStoreForTests();
    const second = getTokenStore();

    const listed = second.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: ticket.id,
      code: ticket.code,
      status: 'claimed',
      claimedAgentId: 'agent-A',
      claimedAlias: 'copilot',
      claimedCommand: 'copilot --acp',
    });

    // The original agentlet should re-pair using the same code.
    expect(() =>
      second.validate(ticket.code, hello(ticket.code, 'agent-A')),
    ).not.toThrow();
    // An attacker with the code but a different agentId still cannot steal it.
    expect(() =>
      second.validate(ticket.code, hello(ticket.code, 'agent-impostor')),
    ).toThrowError(/already claimed/i);
  });

  it('does NOT persist pending tickets (they expire on restart)', () => {
    const first = getTokenStore();
    const ticket = first.createTicket();

    // No claim yet — nothing should be written.
    expect(existsSync(persistPath)).toBe(false);

    _resetTokenStoreForTests();
    const second = getTokenStore();
    expect(second.list()).toHaveLength(0);
    expect(() =>
      second.validate(ticket.code, hello(ticket.code, 'agent-A')),
    ).toThrowError(/invalid or expired/i);
  });

  it('revoke removes the on-disk entry as well', () => {
    const first = getTokenStore();
    const ticket = first.createTicket();
    first.validate(ticket.code, hello(ticket.code, 'agent-A'));
    first.revoke(ticket.id);

    _resetTokenStoreForTests();
    const second = getTokenStore();
    expect(second.list()).toHaveLength(0);
    expect(() =>
      second.validate(ticket.code, hello(ticket.code, 'agent-A')),
    ).toThrowError(/invalid or expired/i);
  });

  it('grace-window expiry removes the on-disk entry as well', () => {
    const first = getTokenStore();
    const ticket = first.createTicket();
    first.validate(ticket.code, hello(ticket.code, 'agent-A'));
    first.markDisconnected('agent-A');
    vi.advanceTimersByTime(PAIRING_RECONNECT_GRACE_MS + 1_000);

    _resetTokenStoreForTests();
    const second = getTokenStore();
    expect(second.list()).toHaveLength(0);
  });

  it('starts empty when the persistence file is missing', () => {
    expect(existsSync(persistPath)).toBe(false);
    const store = getTokenStore();
    expect(store.list()).toHaveLength(0);
  });

  it('starts empty and recovers when the persistence file is corrupted', () => {
    writeFileSync(persistPath, '{not valid json', 'utf-8');
    const store = getTokenStore();
    expect(store.list()).toHaveLength(0);
    // The corrupt file should have been removed so a fresh claim
    // rewrites it cleanly on the next persist.
    expect(existsSync(persistPath)).toBe(false);

    const ticket = store.createTicket();
    store.validate(ticket.code, hello(ticket.code, 'agent-A'));
    const written = JSON.parse(readFileSync(persistPath, 'utf-8'));
    expect(Array.isArray(written)).toBe(true);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      id: ticket.id,
      code: ticket.code,
      claimedAgentId: 'agent-A',
    });
  });
});
