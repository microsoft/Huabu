// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type { APIRequestContext, APIResponse } from '@playwright/test';

/**
 * An Agent's write, made the way an Agent makes it: `POST
 * /api/rfs/:canvasId/execute` with the deployment's machine credential and
 * the `{ commands }` body the Agent guide documents.
 *
 * The credential is the Server's connection token. A deployment fixes it
 * with `HUABU_CONNECTION_TOKEN`; `playwright.config.ts` sets that variable
 * for the backend it boots, so the suite presents the same value here. There
 * is no other way for a test to write as an Agent: a browser session is a
 * person's, whatever the request says.
 */
export function agentCredential(): string {
  const token = process.env.HUABU_CONNECTION_TOKEN?.trim();
  if (!token)
    throw new Error(
      'HUABU_CONNECTION_TOKEN is not set; the Playwright config that boots the backend must supply it',
    );
  return token;
}

/** The part of an RFS execute response these specs read. */
export interface AgentExecuteResponse {
  fromVersion: number;
  toVersion: number;
  basis?: string;
  results: Array<{
    index: number;
    type: string;
    applied: boolean;
    reason?: string;
    nodes?: Array<{ nodeId: string }>;
    edges?: Array<{ edgeId: string }>;
  }>;
  revisions: Array<{ nodeId: string; rev: string }>;
}

export function agentExecute(
  request: APIRequestContext,
  canvasId: string,
  commands: readonly unknown[],
  options: {
    /** The Agent's conversation (`HUABU_THREAD_ID`), for Review records. */
    threadId?: string;
    /** Read version the commands were made on. */
    basis?: string;
  } = {},
): Promise<APIResponse> {
  return request.post(`/api/rfs/${canvasId}/execute`, {
    headers: {
      Authorization: `Bearer ${agentCredential()}`,
      ...(options.threadId
        ? { 'X-Huabu-Host-Thread-Id': options.threadId }
        : {}),
    },
    data: {
      commands,
      ...(options.basis !== undefined ? { basis: options.basis } : {}),
    },
  });
}
