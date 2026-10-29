// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { registerWorkspaceRequiredGuard } from './workspace-required.js';

vi.mock('./workspace.js', () => ({ isWorkspaceConfigured: () => false }));

describe('Workspace-required guard', () => {
  it('lets a caller sign in and out before any Workspace is configured', async () => {
    const app = Fastify();
    registerWorkspaceRequiredGuard(app);
    const ok = async () => ({ ok: true });
    app.get('/api/identity', ok);
    app.post('/api/identity/session', ok);
    app.delete('/api/identity/session', ok);
    app.get('/api/canvas', ok);
    const status = async (method: 'GET' | 'POST' | 'DELETE', url: string) =>
      (await app.inject({ method, url })).statusCode;

    expect(await status('GET', '/api/identity')).toBe(200);
    expect(await status('POST', '/api/identity/session')).toBe(200);
    expect(await status('DELETE', '/api/identity/session')).toBe(200);
    expect(await status('GET', '/api/canvas')).toBe(503);
    await app.close();
  });
});
