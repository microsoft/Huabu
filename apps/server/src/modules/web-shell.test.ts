// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import staticPlugin from '@fastify/static';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerWebShell } from './web-shell.js';
import { registerWorkspaceRequiredGuard } from './workspace-required.js';

import type { FastifyInstance } from 'fastify';

// A fresh install: no Workspace configured yet.
vi.mock('./workspace.js', () => ({ isWorkspaceConfigured: () => false }));

describe('Web shell', () => {
  let root: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'huabu-web-shell-'));
    writeFileSync(
      join(root, 'index.html'),
      '<!doctype html><title>app</title>',
    );
    writeFileSync(join(root, 'app.js'), 'console.log(1);');
    app = Fastify();
    // The host's own registration, which decorates `reply.sendFile`.
    await app.register(staticPlugin, { root: tmpdir(), serve: false });
    registerWorkspaceRequiredGuard(app);
    app.get('/api/canvas', async () => ({ canvases: [] }));
    registerWebShell(app, root);
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('answers an API path no route serves with a JSON 404, whatever the method', async () => {
    for (const method of ['GET', 'POST', 'PATCH', 'DELETE'] as const) {
      for (const url of ['/api', '/api/nope', '/api/canvas/c1/nope?x=1']) {
        const response = await app.inject({ method, url });
        expect(response.statusCode, `${method} ${url}`).toBe(404);
        expect(response.headers['content-type']).toMatch(/json/);
        expect(response.json().message).toContain('not found');
      }
    }
  });

  it('still guards real API routes and serves the app everywhere else', async () => {
    expect((await app.inject({ url: '/api/canvas' })).statusCode).toBe(503);
    const page = await app.inject({ url: '/spaces' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('<title>app</title>');
    // A path that merely starts with "api" is a client route, not the API.
    expect((await app.inject({ url: '/apiary' })).body).toContain(
      '<title>app</title>',
    );
    expect((await app.inject({ url: '/app.js' })).body).toBe('console.log(1);');
  });
});
