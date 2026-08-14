// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { getRootErrorMessage } from './error-message.js';

describe('getRootErrorMessage', () => {
  it('returns the actionable message from a nested cause', () => {
    const cause = new Error(
      'Credential storage is read-only. Set HUABU_SECRET_KEY to enable encrypted settings persistence.',
    );
    const error = new Error(
      'Credential store modify failed for github-copilot',
    );
    Object.defineProperty(error, 'cause', { value: cause });

    expect(getRootErrorMessage(error, 'OAuth flow failed')).toBe(
      'Credential storage is read-only. Set HUABU_SECRET_KEY to enable encrypted settings persistence.',
    );
  });

  it('preserves an unwrapped error message', () => {
    expect(
      getRootErrorMessage(new Error('Provider unavailable'), 'OAuth failed'),
    ).toBe('Provider unavailable');
  });

  it('uses the fallback for unknown errors', () => {
    expect(getRootErrorMessage('failed', 'OAuth failed')).toBe('OAuth failed');
  });

  it('does not loop on a cyclic cause chain', () => {
    const outer = new Error('Outer');
    const inner = new Error('Inner');
    Object.defineProperty(inner, 'cause', { value: outer });
    Object.defineProperty(outer, 'cause', { value: inner });

    expect(getRootErrorMessage(outer, 'OAuth failed')).toBe('Inner');
  });
});
