// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * The authenticated principal behind a Canvas request or stream, and what a
 * stream is told about events another principal caused.
 *
 * A page id is chosen by its page. It identifies a page only together with
 * the principal of the request that carries it, so every place that acts on
 * a page id — presence, the execute route's "own page", the echo of a
 * content save — pairs it with the value from here.
 */

import { getRequestIdentity } from '../identity/request.js';

import type { CanvasUpdateOrigin } from './canvas-sync.js';
import type { CanvasSyncEvent } from '@huabu/shared';
import type { FastifyRequest } from 'fastify';

/** Used where no identity layer is installed (a route under test). */
export const ANONYMOUS_PRINCIPAL = 'anonymous';

/** The authenticated principal a request, or a stream, speaks for. */
export function callerPrincipalId(request: FastifyRequest): string {
  return (
    getRequestIdentity(request)?.principal.principalId ?? ANONYMOUS_PRINCIPAL
  );
}

/**
 * The event as the stream of `principalId` is sent it.
 *
 * `originPageId` lets the saving page skip the fetch every other page makes
 * for an `invalidate`. A page id is chosen by its page, so another principal
 * could quote it and make that page skip a save it has not seen. The id is
 * therefore passed on only to streams of the principal that made the save;
 * everybody else gets the event without it, and fetches.
 */
export function eventForSubscriber(
  event: CanvasSyncEvent,
  origin: CanvasUpdateOrigin | undefined,
  principalId: string,
): CanvasSyncEvent {
  if (event.type !== 'invalidate' || event.data.originPageId === undefined)
    return event;
  if (origin?.principalId === principalId) return event;
  const { originPageId: _origin, ...data } = event.data;
  void _origin;
  return { ...event, data };
}
