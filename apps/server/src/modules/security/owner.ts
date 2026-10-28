// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { personalSettingsOwner } from '../identity/personal-settings.js';
import { getRequestIdentity } from '../identity/request.js';

import type { FastifyRequest } from 'fastify';

/** Owner authority comes only from the installed identity service. */
export function isOwnerRequest(request: FastifyRequest): boolean {
  return getRequestIdentity(request)?.owner === true;
}

/**
 * Whether the caller may change the settings this call reads: an owner the
 * deployment's, a Bubble member their own personal ones (model keys, agent
 * defaults, connected credentials).
 */
export function canChangeOwnSettings(request: FastifyRequest): boolean {
  return isOwnerRequest(request) || personalSettingsOwner() !== null;
}
