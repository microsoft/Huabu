// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { randomUUID } from 'node:crypto';

import type { SecretStore } from './secret-store-types.js';

interface ParentPort {
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}

interface SecretBridgeResult {
  type: 'secret:result';
  requestId: string;
  ok: boolean;
  error?: string;
}

const enabled = process.env.HUABU_SECRET_BRIDGE === '1';
const parentPort = (
  process as NodeJS.Process & { parentPort?: ParentPort | null }
).parentPort;
const secrets = new Map<string, string>();
const pending = new Map<
  string,
  { resolve: () => void; reject: (error: Error) => void }
>();
let ready = !enabled;
let resolveReady: (() => void) | null = null;
const readyPromise = enabled
  ? new Promise<void>((resolve) => {
      resolveReady = resolve;
    })
  : Promise.resolve();

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).every((item) => typeof item === 'string');
}

function isResult(value: unknown): value is SecretBridgeResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.type === 'secret:result' &&
    typeof record.requestId === 'string' &&
    typeof record.ok === 'boolean' &&
    (record.error === undefined || typeof record.error === 'string')
  );
}

if (enabled) {
  if (!parentPort) {
    throw new Error(
      'HUABU_SECRET_BRIDGE requires an Electron utility parent port',
    );
  }
  parentPort.on('message', (event) => {
    const message = event.data;
    if (message && typeof message === 'object' && !Array.isArray(message)) {
      const record = message as Record<string, unknown>;
      if (record.type === 'secret:init' && isStringRecord(record.secrets)) {
        secrets.clear();
        for (const [key, value] of Object.entries(record.secrets)) {
          secrets.set(key, value);
        }
        ready = true;
        resolveReady?.();
        resolveReady = null;
        return;
      }
    }
    if (!isResult(message)) return;
    const request = pending.get(message.requestId);
    if (!request) return;
    pending.delete(message.requestId);
    if (message.ok) request.resolve();
    else
      request.reject(new Error(message.error ?? 'Secure secret write failed'));
  });
}

export function isDesktopSecretBridgeEnabled(): boolean {
  return enabled;
}

/** Wait until Electron main has supplied the decrypted in-memory snapshot. */
export async function initializeDesktopSecretBridge(): Promise<void> {
  if (!enabled || ready) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      readyPromise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Timed out waiting for secure credentials')),
          15_000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Synchronous read from the snapshot held only in server process memory. */
export function getDesktopSecret(key: string): string | null {
  return enabled ? (secrets.get(key) ?? null) : null;
}

/** Persist through Electron main, then update the server's memory snapshot. */
export async function setDesktopSecret(
  key: string,
  value: string | null,
): Promise<void> {
  if (!enabled || !parentPort) {
    throw new Error('Desktop secure secret bridge is not enabled');
  }
  const requestId = randomUUID();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error('Timed out writing secure credential'));
    }, 10_000);
    pending.set(requestId, {
      resolve: () => {
        clearTimeout(timer);
        resolve();
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    parentPort.postMessage({
      type: 'secret:mutate',
      requestId,
      key,
      value,
    });
  });
  if (value === null) secrets.delete(key);
  else secrets.set(key, value);
}

/** SecretStore adapter over Electron main's safeStorage bridge. */
export class ElectronSecretStore implements SecretStore {
  readonly kind = 'electron-safe-storage';
  readonly writable = true;

  async initialize(): Promise<void> {
    await initializeDesktopSecretBridge();
  }

  get(id: string): string | null {
    return getDesktopSecret(id);
  }

  async set(id: string, value: string | null): Promise<void> {
    await setDesktopSecret(id, value);
  }

  async setMany(updates: Record<string, string | null>): Promise<void> {
    // The Electron bridge writes one secret per round-trip, so this is a
    // sequential best-effort apply rather than a single atomic replacement.
    for (const [id, value] of Object.entries(updates)) {
      await setDesktopSecret(id, value);
    }
  }
}
