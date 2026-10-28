// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import {
  claimSpace,
  readableSpaces,
  registerSpaceAccess,
} from './space-access.js';
import {
  getRequestAuthorizations,
  setRequestIdentity,
} from '../identity/request.js';
import { UNRESTRICTED_ACCESS } from '../identity/service.js';

import type { FastifyInstance } from 'fastify';

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

/** Carol may write `mine` and read `shared`; the header picks the owner flag. */
function host() {
  const claimed: string[] = [];
  const app = Fastify();
  apps.push(app);
  app.addHook('onRequest', async (request) => {
    setRequestIdentity(request, {
      principal: { principalId: 'carol', kind: 'user' },
      member: true,
      owner: request.headers['x-owner'] === 'yes',
      access: {
        can: async (level, { id }) =>
          id === 'mine' || (id === 'shared' && level === 'read'),
        claim: async ({ id }) => {
          claimed.push(id);
        },
        workspaces: async () => 'all',
      },
    });
  });
  registerSpaceAccess(app);
  const ok = async () => ({ ok: true });
  app.get('/api/canvas/:canvasId', ok);
  app.put('/api/canvas/:canvasId', ok);
  app.post(
    '/api/canvas/:canvasId/search',
    { config: { spaceAccess: 'read' } },
    ok,
  );
  app.get('/api/agent/history/:threadId', ok);
  app.post('/api/agent', ok);
  app.post('/api/acp/threads/:threadId/permission', ok);
  app.get('/api/canvas/:canvasId/threads/:threadId/changes', ok);
  app.post('/api/canvas-titles', ok);
  app.post('/api/rfs/:canvasId/services/:serviceId/lease', ok);
  app.post(
    '/api/interactive-views/:canvasId/:nodeId/actions/:actionId',
    { config: { invokesAgent: true } },
    ok,
  );
  app.post('/api/canvas/:canvasId/move-selection', ok);
  app.patch('/api/canvas/:canvasId/parent', ok);
  app.post('/api/canvas/:canvasId/artifact/clone-from', ok);
  app.get('/api/canvas', async (request) =>
    readableSpaces(request, [
      { canvasId: 'other' },
      { canvasId: 'mine' },
      { canvasId: 'shared' },
    ]),
  );
  app.post('/api/canvas', async (request) => {
    await claimSpace(request, 'created');
    return {};
  });
  return { app, claimed };
}

describe('Space access', () => {
  it('reads and writes only the Spaces the identity provider allows', async () => {
    const { app } = host();
    const status = async (method: 'GET' | 'PUT', id: string) =>
      (
        await app.inject({
          method,
          url: `/api/canvas/${id}`,
          payload: method === 'PUT' ? {} : undefined,
        })
      ).statusCode;
    expect(await status('GET', 'mine')).toBe(200);
    expect(await status('PUT', 'mine')).toBe(200);
    expect(await status('GET', 'shared')).toBe(200);
    expect(await status('PUT', 'shared')).toBe(403);
    // An unreadable Space looks exactly like a missing one.
    const hidden = await app.inject('/api/canvas/other');
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json()).toEqual({ message: 'Canvas not found' });
    // A route that declares itself read-only needs only read access.
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/canvas/shared/search',
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
  });

  it('authorizes the one Space a request names, and refuses conflicting ones', async () => {
    const { app } = host();
    const search = (query: string, payload: object) =>
      app.inject({
        method: 'POST',
        url: `/api/canvas/mine/search${query}`,
        payload,
      });
    expect((await search('', { canvasId: 'mine' })).statusCode).toBe(200);
    // A handler reading the body must never see a Space other than the one
    // authorized from the path or query.
    expect((await search('', { canvasId: 'other' })).statusCode).toBe(400);
    expect((await search('?canvasId=other', {})).statusCode).toBe(400);
    expect((await search('?canvasId=mine&canvasId=other', {})).statusCode).toBe(
      400,
    );
    const titles = (query: string, payload: object) =>
      app.inject({
        method: 'POST',
        url: `/api/canvas-titles${query}`,
        headers: { 'x-owner': 'yes' },
        payload,
      });
    expect((await titles('', { canvasId: 'other' })).statusCode).toBe(404);
    expect(
      (await titles('?canvasId=mine', { canvasId: 'other' })).statusCode,
    ).toBe(400);
    expect((await titles('', { canvasId: ['mine'] })).statusCode).toBe(400);
  });

  it('keeps agents and conversations to owners, whatever Space a request names', async () => {
    const { app } = host();
    const as = (owner: 'yes' | 'no') => ({ 'x-owner': owner });
    for (const request of [
      { url: '/api/agent/history/t1?canvasId=mine' },
      { url: '/api/agent/history/t1' },
      { method: 'POST', url: '/api/agent', payload: { canvasId: 'mine' } },
      { method: 'POST', url: '/api/acp/threads/t1/permission?canvasId=mine' },
      { url: '/api/canvas/mine/threads/t1/changes' },
      // The machine credential's own surface: agent launches, Task Runs and
      // shared service credentials.
      { method: 'POST', url: '/api/rfs/mine/services/web-search/lease' },
      { method: 'POST', url: '/api/interactive-views/mine/n1/actions/a1' },
    ] as const) {
      expect(
        (await app.inject({ ...request, headers: as('no') })).statusCode,
      ).toBe(403);
    }
    expect(
      (
        await app.inject({
          url: '/api/agent/history/t1?canvasId=mine',
          headers: as('yes'),
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          url: '/api/agent/history/t1?canvasId=other',
          headers: as('yes'),
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ url: '/api/agent/history/t1', headers: as('yes') }))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/interactive-views/mine/n1/actions/a1',
          headers: as('yes'),
        })
      ).statusCode,
    ).toBe(200);
  });

  it('records each Space it let a request into', async () => {
    const { app } = host();
    app.get('/api/canvas/:canvasId/granted', async (request) =>
      getRequestAuthorizations(request),
    );
    const response = await app.inject('/api/canvas/mine/granted');
    expect(response.json()).toEqual([
      { level: 'read', resource: { type: 'space', id: 'mine' } },
    ]);
  });

  it('also authorizes the other Space a request moves content to or from', async () => {
    const { app } = host();
    const post = (
      url: string,
      payload: object,
      method: 'POST' | 'PATCH' = 'POST',
    ) => app.inject({ method, url, payload });
    expect(
      (
        await post('/api/canvas/mine/move-selection', {
          destination: { kind: 'existing', canvasId: 'shared' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await post('/api/canvas/mine/move-selection', {
          destination: { kind: 'new', title: 'New' },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await post(
          '/api/canvas/mine/parent',
          { parentSpaceId: 'other' },
          'PATCH',
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await post('/api/canvas/mine/artifact/clone-from', {
          srcCanvasId: 'shared',
          srcKey: 'a.png',
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await post('/api/canvas/mine/artifact/clone-from', {
          srcCanvasId: 'other',
          srcKey: 'a.png',
        })
      ).statusCode,
    ).toBe(404);
  });

  it('leaves unrestricted callers such as the local machine token unguarded', async () => {
    const app = Fastify();
    apps.push(app);
    app.addHook('onRequest', async (request) => {
      setRequestIdentity(request, {
        principal: { principalId: 'huabu-agentlet', kind: 'bot' },
        member: true,
        owner: false,
        access: UNRESTRICTED_ACCESS,
      });
    });
    registerSpaceAccess(app);
    app.get('/api/agent/history/:threadId', async () => ({ ok: true }));
    app.put('/api/canvas/:canvasId', async () => ({ ok: true }));
    expect((await app.inject('/api/agent/history/t1')).statusCode).toBe(200);
    expect(
      (await app.inject({ method: 'PUT', url: '/api/canvas/any', payload: {} }))
        .statusCode,
    ).toBe(200);
  });

  it('lists readable Spaces and claims created ones for the caller', async () => {
    const { app, claimed } = host();
    expect((await app.inject('/api/canvas')).json()).toEqual([
      { canvasId: 'mine' },
      { canvasId: 'shared' },
    ]);
    await app.inject({ method: 'POST', url: '/api/canvas', payload: {} });
    expect(claimed).toEqual(['created']);
  });
});
