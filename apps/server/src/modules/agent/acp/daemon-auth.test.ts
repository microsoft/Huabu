/**
 * Tests for the daemon-auth singleton.
 *
 * Coverage:
 *   ✓ rotateToken returns a 64-char hex string and updates getToken
 *   ✓ validate rejects when no token has been set yet
 *   ✓ validate rejects non-daemon handshake modes
 *   ✓ validate rejects mismatched tokens
 *   ✓ validate accepts a matching daemon handshake
 *   ✓ close clears the in-memory token
 *
 * We deliberately do NOT fork the agentlet daemon binary in these
 * unit tests — that would turn this into an integration test. See
 * `daemon-supervisor.ts` for the surrounding fork/restart logic;
 * exercising it requires either a real bridge or a complex mock
 * harness and is covered by the manual smoke tests instead.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { _resetDaemonAuthForTests, getDaemonAuth } from './daemon-auth.js';

import type { BridgeHelloParams } from '@agentlet/protocol';

function makeDaemonHello(): BridgeHelloParams {
  return {
    mode: 'daemon',
    machine: { hostname: 'test', platform: 'linux' },
  } as BridgeHelloParams;
}

beforeEach(() => {
  _resetDaemonAuthForTests();
});

afterEach(() => {
  _resetDaemonAuthForTests();
});

describe('AcpDaemonAuth.rotateToken', () => {
  it('returns a 64-char hex string and stores it', () => {
    const auth = getDaemonAuth();
    const token = auth.rotateToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(auth.getToken()).toBe(token);
  });

  it('produces a different token on each call', () => {
    const auth = getDaemonAuth();
    const a = auth.rotateToken();
    const b = auth.rotateToken();
    expect(a).not.toBe(b);
    expect(auth.getToken()).toBe(b);
  });
});

describe('AcpDaemonAuth.validate', () => {
  it('throws when no token has been minted yet', () => {
    const auth = getDaemonAuth();
    expect(() => auth.validate('anything', makeDaemonHello())).toThrow(
      /not finished initialising/,
    );
  });

  it('rejects non-daemon handshake modes', () => {
    const auth = getDaemonAuth();
    const token = auth.rotateToken();
    expect(() =>
      auth.validate(token, {
        mode: 'bridge',
        machine: { hostname: 't', platform: 'linux' },
      } as BridgeHelloParams),
    ).toThrow(/Only daemon handshakes/);
  });

  it('rejects mismatched tokens', () => {
    const auth = getDaemonAuth();
    auth.rotateToken();
    expect(() => auth.validate('wrong', makeDaemonHello())).toThrow(
      /Invalid daemon token/,
    );
  });

  it('rejects empty tokens', () => {
    const auth = getDaemonAuth();
    auth.rotateToken();
    expect(() => auth.validate('', makeDaemonHello())).toThrow(
      /Invalid daemon token/,
    );
  });

  it('accepts a matching daemon handshake', () => {
    const auth = getDaemonAuth();
    const token = auth.rotateToken();
    const result = auth.validate(token, makeDaemonHello());
    expect(result).toEqual({ metadata: { source: 'daemon' } });
  });
});

describe('AcpDaemonAuth.close', () => {
  it('clears the in-memory token', () => {
    const auth = getDaemonAuth();
    auth.rotateToken();
    auth.close();
    expect(auth.getToken()).toBeNull();
    expect(() => auth.validate('anything', makeDaemonHello())).toThrow(
      /not finished initialising/,
    );
  });
});

describe('setDaemonToken', () => {
  it('replaces the active token without rotation', () => {
    const auth = getDaemonAuth();
    auth.setDaemonToken('my-token');
    expect(auth.getToken()).toBe('my-token');
    expect(() => auth.validate('my-token', makeDaemonHello())).not.toThrow();
  });
});
