// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  LocalAgentManager,
  type LocalAgentChild,
  type LocalAgentCredential,
} from './local-agent';

class Child extends EventEmitter {
  postMessage = vi.fn(() => {
    queueMicrotask(() => {
      this.emit('message', { type: 'agentlet:stopped' });
      this.emit('exit', 0);
    });
  });
}

function setup(saved: LocalAgentCredential | null = null) {
  const children: Child[] = [];
  const credential = { token: 'secret', maxAgents: 3 };
  const options = {
    readDevice: vi.fn(async () => ({
      agentletId: 'this-device',
      displayName: 'My computer: darwin arm64',
      version: '1.0.0',
    })),
    readCredential: vi.fn(() => saved),
    saveCredential: vi.fn(),
    requestCredential: vi.fn(async () => credential),
    start: vi.fn(async () => {
      const child = new Child();
      children.push(child);
      return child;
    }),
    forceTerminate: vi.fn((_child: LocalAgentChild) => undefined),
    onState: vi.fn(),
  };
  return {
    manager: new LocalAgentManager(options),
    options,
    children,
    credential,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('desktop local Agent lifecycle', () => {
  it('does not fetch credentials or start a worker without prior authorization', async () => {
    const { manager, options } = setup();
    await manager.restore();
    expect(manager.getState()).toEqual({
      enabled: false,
      status: 'disabled',
      error: null,
      device: {
        agentletId: 'this-device',
        displayName: 'My computer: darwin arm64',
        version: '1.0.0',
      },
    });
    expect(options.requestCredential).not.toHaveBeenCalled();
    expect(options.start).not.toHaveBeenCalled();
  });

  it('persists explicit authorization, reports readiness and cooperatively disconnects', async () => {
    const { manager, options, children, credential } = setup();
    await manager.setEnabled(true);
    expect(options.saveCredential).toHaveBeenCalledWith(credential);
    children[0].emit('message', {
      type: 'agentlet:ready',
      agentletId: 'this-device',
    });
    expect(manager.getState().status).toBe('connected');
    expect(manager.getState().agentletId).toBe('this-device');
    expect(JSON.stringify(manager.getState())).not.toContain('secret');
    await manager.setEnabled(false);
    expect(children[0].postMessage).toHaveBeenCalledWith({
      type: 'agentlet:stop',
    });
    expect(options.saveCredential).toHaveBeenLastCalledWith(null);
    expect(manager.getState().status).toBe('disabled');
    expect(manager.getState().agentletId).toBeUndefined();
    expect(options.forceTerminate).not.toHaveBeenCalled();
  });

  it('keeps the device ID while reconnecting and rejects readiness without an ID', async () => {
    const { manager, children } = setup();
    await manager.setEnabled(true);
    children[0].emit('message', { type: 'agentlet:ready', agentletId: 123 });
    expect(manager.getState()).toMatchObject({
      status: 'error',
      error: 'The local worker did not report its device ID.',
    });
    children[0].emit('message', {
      type: 'agentlet:ready',
      agentletId: 'this-device',
    });
    children[0].emit('message', { type: 'agentlet:reconnecting' });
    expect(manager.getState()).toMatchObject({
      status: 'reconnecting',
      agentletId: 'this-device',
    });
    await manager.shutdown();
  });

  it('restores saved credentials without logging in or revealing the token to the UI', async () => {
    const saved = { token: 'saved-token', maxAgents: 7 };
    const { manager, options } = setup(saved);
    await manager.restore();
    expect(options.start).toHaveBeenCalledExactlyOnceWith(saved);
    expect(options.requestCredential).not.toHaveBeenCalled();
    await manager.shutdown();
    expect(options.saveCredential).not.toHaveBeenCalled();
  });

  it('does not restart after authorization rejection', async () => {
    vi.useFakeTimers();
    const { manager, options, children } = setup();
    await manager.setEnabled(true);
    children[0].emit('message', { type: 'agentlet:authorization-required' });
    children[0].emit('message', { type: 'agentlet:stopped' });
    children[0].emit('exit', 1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(manager.getState().status).toBe('authorization-required');
    expect(options.start).toHaveBeenCalledTimes(1);
  });

  it('keeps handshake rejection visible instead of restarting indefinitely', async () => {
    vi.useFakeTimers();
    const { manager, options, children } = setup();
    await manager.setEnabled(true);
    children[0].emit('message', { type: 'agentlet:rejected' });
    children[0].emit('message', { type: 'agentlet:stopped' });
    children[0].emit('exit', 1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(manager.getState()).toMatchObject({
      status: 'error',
      enabled: true,
    });
    expect(options.start).toHaveBeenCalledTimes(1);
  });

  it('blocks automatic and manual restart after an unverified worker exit', async () => {
    vi.useFakeTimers();
    const { manager, options, children } = setup();
    await manager.setEnabled(true);
    children[0].emit('exit', 1);
    await vi.advanceTimersByTimeAsync(60_000);
    await manager.setEnabled(true);
    expect(options.start).toHaveBeenCalledTimes(1);
    expect(options.saveCredential).toHaveBeenLastCalledWith(null);
    expect(manager.getState()).toMatchObject({
      enabled: false,
      status: 'error',
      error: expect.stringContaining('Stop any remaining local Agent tasks'),
    });
  });

  it('awaits a starting child and stops it before shutdown completes', async () => {
    const { manager, options, credential } = setup({
      token: 'saved',
      maxAgents: 1,
    });
    const child = new Child();
    let complete!: (value: Child) => void;
    options.start.mockReturnValue(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    const restoring = manager.restore();
    await vi.waitFor(() => expect(options.start).toHaveBeenCalled());
    const stopping = manager.shutdown();
    complete(child);
    await Promise.all([restoring, stopping]);
    expect(child.postMessage).toHaveBeenCalledExactlyOnceWith({
      type: 'agentlet:stop',
    });
    expect(options.requestCredential).not.toHaveBeenCalled();
    expect(options.saveCredential).not.toHaveBeenCalledWith(credential);
  });

  it('does not start or save credentials after quitting during authorization', async () => {
    const { manager, options, credential } = setup();
    let complete!: (value: LocalAgentCredential) => void;
    options.requestCredential.mockReturnValue(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    const connecting = manager.setEnabled(true);
    await Promise.resolve();
    await manager.shutdown();
    complete(credential);
    await connecting;
    expect(options.start).not.toHaveBeenCalled();
    expect(options.saveCredential).not.toHaveBeenCalled();
  });

  it('refuses to start when credential encryption or persistence fails', async () => {
    const { manager, options } = setup();
    options.saveCredential.mockImplementation(() => {
      throw new Error('Encryption unavailable');
    });
    await manager.setEnabled(true);
    expect(manager.getState()).toMatchObject({
      enabled: false,
      status: 'error',
      error: 'Encryption unavailable',
    });
    expect(options.start).not.toHaveBeenCalled();
  });

  it('allows explicit reconnection after a verified clean exit', async () => {
    vi.useFakeTimers();
    const { manager, options, children } = setup();
    await manager.setEnabled(true);
    children[0].emit('message', { type: 'agentlet:stopped' });
    children[0].emit('exit', 0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(options.start).toHaveBeenCalledTimes(1);
    await manager.setEnabled(true);
    expect(options.start).toHaveBeenCalledTimes(2);
    await manager.shutdown();
  });

  it('rejects concurrent operations rather than starting duplicate workers', async () => {
    const { manager, options } = setup();
    let complete!: (credential: LocalAgentCredential) => void;
    options.requestCredential.mockReturnValue(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    const connecting = manager.setEnabled(true);
    await Promise.resolve();
    await expect(manager.setEnabled(true)).rejects.toThrow(
      'already in progress',
    );
    complete({ token: 'secret', maxAgents: 1 });
    await connecting;
    expect(options.start).toHaveBeenCalledTimes(1);
    await manager.shutdown();
  });

  it('keeps authorization failures visible without saving a success-shaped fallback', async () => {
    const { manager, options } = setup();
    options.requestCredential.mockRejectedValue(new Error('HTTP 403'));
    await manager.setEnabled(true);
    expect(manager.getState()).toMatchObject({
      enabled: false,
      status: 'error',
      error: 'HTTP 403',
    });
    expect(options.saveCredential).not.toHaveBeenCalled();
    expect(options.start).not.toHaveBeenCalled();
  });

  it('surfaces cleanup timeout instead of reporting a successful disconnect', async () => {
    vi.useFakeTimers();
    const { manager, children, options } = setup();
    await manager.setEnabled(true);
    children[0].postMessage.mockImplementation(() => undefined);
    const stopping = manager.setEnabled(false);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(children[0].postMessage).toHaveBeenLastCalledWith({
      type: 'agentlet:force-stop',
    });
    expect(options.forceTerminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3000);
    expect(options.forceTerminate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    await stopping;
    expect(manager.getState()).toMatchObject({
      enabled: false,
      status: 'error',
    });
  });

  it('forces termination and awaits exit when the parent channel rejects stop', async () => {
    vi.useFakeTimers();
    const { manager, children, options } = setup();
    await manager.setEnabled(true);
    children[0].postMessage.mockImplementation(() => {
      throw new Error('Parent channel closed');
    });
    const stopping = manager.setEnabled(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(options.forceTerminate).toHaveBeenCalledTimes(1);
    children[0].emit('exit', 1);
    await stopping;
    expect(manager.getState().error).toContain(
      'cleanup could not be confirmed',
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops tasks even if removing the saved authorization fails', async () => {
    const { manager, options, children } = setup();
    await manager.setEnabled(true);
    options.saveCredential.mockImplementation(() => {
      throw new Error('Vault write failed');
    });
    await manager.setEnabled(false);
    expect(children[0].postMessage).toHaveBeenCalledWith({
      type: 'agentlet:stop',
    });
    expect(manager.getState()).toMatchObject({
      enabled: true,
      status: 'error',
      error: 'Vault write failed',
    });
  });

  it('keeps disconnect available when a crash cannot remove saved authorization', async () => {
    const { manager, options, children } = setup();
    await manager.setEnabled(true);
    options.saveCredential.mockImplementationOnce(() => {
      throw new Error('Vault write failed');
    });
    children[0].emit('exit', 1);
    expect(manager.getState()).toMatchObject({
      enabled: true,
      status: 'error',
      error: expect.stringContaining(
        'Saved authorization could not be removed',
      ),
    });
    await manager.setEnabled(false);
    expect(options.saveCredential).toHaveBeenLastCalledWith(null);
    expect(manager.getState()).toMatchObject({
      enabled: false,
      status: 'error',
    });
  });

  it('accepts verified process-tree cleanup during forced shutdown without claiming success', async () => {
    vi.useFakeTimers();
    const { manager, options, children } = setup();
    await manager.setEnabled(true);
    children[0].postMessage.mockImplementation(() => undefined);
    const stopping = manager.setEnabled(false);
    await vi.advanceTimersByTimeAsync(12_000);
    children[0].emit('message', { type: 'agentlet:stopped' });
    children[0].emit('exit', 1);
    await stopping;
    expect(manager.getState().status).toBe('error');
    expect(options.forceTerminate).not.toHaveBeenCalled();
    await manager.setEnabled(true);
    expect(options.start).toHaveBeenCalledTimes(2);
    await manager.shutdown();
  });
});
