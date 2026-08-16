// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { resolve } from 'node:path';

import {
  AgentTeamError,
  getAgentTeamRegistry,
  getSupervisedAgentletId,
  type AgentTeamRegistry,
} from '@agenetes/agentlet-host';

import {
  agentTeamMemberDetailQuerySchema,
  agentTeamProfileActionParamsSchema,
  createAgentTeamProfileBodySchema,
  createId,
  patchAgentProfileBodySchema,
  updateAgentTeamMemberConfigsBodySchema,
} from '@huabu/shared';

import { getDataDir } from '../../data-dir.js';
import { isOwnerRequest } from '../security/owner.js';

import type {
  AgentProfileParams,
  AgentProfileView,
  AgentTeamMemberDetailQuery,
  AgentTeamMemberDetailView,
  AgentTeamSettingsState,
  ApiResult,
  CreateAgentTeamProfileBody,
  PatchAgentProfileBody,
  UpdateAgentTeamMemberConfigsBody,
} from '@huabu/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

export type AgentTeamSettingsRegistry = Pick<
  AgentTeamRegistry,
  | 'cancelProfileSetup'
  | 'createProfile'
  | 'deleteProfile'
  | 'getMemberDetail'
  | 'listMachines'
  | 'listMemberSummaries'
  | 'patchProfile'
  | 'setupProfile'
  | 'updateMemberConfigs'
>;

function workspaceSegment(value: string): string {
  const segment = value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return segment || 'agent';
}

export function defaultAgentTeamWorkingDir(input: {
  root: string;
  memberName: string;
  harness: string;
  profileId: string;
}): string {
  return resolve(
    input.root,
    workspaceSegment(input.memberName),
    workspaceSegment(input.harness),
    workspaceSegment(input.profileId),
  );
}

function denyRemote(request: FastifyRequest, reply: FastifyReply): boolean {
  if (isOwnerRequest(request)) return false;
  reply.status(403).send({
    message: 'Forbidden: Agent Team Settings are only available on localhost',
    code: 'loopback_required',
  });
  return true;
}

function requireRegistry(
  reply: FastifyReply,
  getRegistry: () => AgentTeamSettingsRegistry | null,
): AgentTeamSettingsRegistry | null {
  const registry = getRegistry();
  if (registry) return registry;
  reply.status(503).send({
    message: 'Agent Team control plane is not ready',
    code: 'agent_team_unavailable',
  });
  return null;
}

function settingsState(
  registry: AgentTeamSettingsRegistry,
  localMachine: string,
): AgentTeamSettingsState {
  return {
    machines: registry.listMachines(),
    localMachine,
    roots: [],
    members: registry
      .listMemberSummaries()
      .filter((member) => member.status === 'active'),
  };
}

const badRequestCodes = new Set([
  'config_field_not_found',
  'invalid_agentlet',
  'invalid_alias',
  'invalid_command',
  'invalid_config_value',
  'invalid_profile_kind',
  'invalid_profile_patch',
  'invalid_root',
  'invalid_working_directory',
  'unsupported_harness',
]);
const notFoundCodes = new Set([
  'member_not_found',
  'profile_not_found',
  'root_not_found',
]);

function sendAgentTeamError(error: unknown, reply: FastifyReply): FastifyReply {
  if (!(error instanceof AgentTeamError)) throw error;
  const status = badRequestCodes.has(error.code)
    ? 400
    : notFoundCodes.has(error.code)
      ? 404
      : 409;
  return reply.status(status).send({
    message: error.message,
    code: error.code,
  });
}

function firstIssueMessage(
  result: { success: false; error: { issues: { message: string }[] } },
  fallback: string,
): string {
  return result.error.issues[0]?.message ?? fallback;
}

export function createAgentTeamRoutes(
  getRegistry: () => AgentTeamSettingsRegistry | null,
  getLocalMachine: () => string,
  getDefaultWorkspaceRoot: () => string = () =>
    resolve(getDataDir(), 'agent-team', 'workspaces'),
): FastifyPluginAsync {
  return async (app) => {
    const readState = (registry: AgentTeamSettingsRegistry) =>
      settingsState(registry, getLocalMachine());
    app.get<{ Reply: ApiResult<AgentTeamSettingsState> }>(
      '/settings',
      async (request, reply) => {
        if (denyRemote(request, reply)) return;
        const registry = requireRegistry(reply, getRegistry);
        if (!registry) return;
        return readState(registry);
      },
    );

    app.get<{
      Querystring: AgentTeamMemberDetailQuery;
      Reply: ApiResult<AgentTeamMemberDetailView>;
    }>('/settings/member-detail', async (request, reply) => {
      if (denyRemote(request, reply)) return;
      const parsed = agentTeamMemberDetailQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(400).send({
          message: firstIssueMessage(parsed, 'Invalid Agent Team member'),
          code: 'validation_failed',
        });
      }
      const registry = requireRegistry(reply, getRegistry);
      if (!registry) return;
      try {
        return registry.getMemberDetail(
          parsed.data.machine,
          parsed.data.manifestPath,
        );
      } catch (error) {
        return sendAgentTeamError(error, reply);
      }
    });

    app.put<{
      Body: UpdateAgentTeamMemberConfigsBody;
      Reply: ApiResult<AgentTeamMemberDetailView>;
    }>('/settings/configs', async (request, reply) => {
      if (denyRemote(request, reply)) return;
      const parsed = updateAgentTeamMemberConfigsBodySchema.safeParse(
        request.body,
      );
      if (!parsed.success) {
        return reply.status(400).send({
          message: firstIssueMessage(parsed, 'Invalid Agent Team Configs'),
          code: 'validation_failed',
        });
      }
      const registry = requireRegistry(reply, getRegistry);
      if (!registry) return;
      try {
        await registry.updateMemberConfigs(
          parsed.data.machine,
          parsed.data.manifestPath,
          parsed.data.values,
        );
        return registry.getMemberDetail(
          parsed.data.machine,
          parsed.data.manifestPath,
        );
      } catch (error) {
        return sendAgentTeamError(error, reply);
      }
    });

    app.post<{
      Body: CreateAgentTeamProfileBody;
      Reply: ApiResult<AgentProfileView>;
    }>('/settings/profiles', async (request, reply) => {
      if (denyRemote(request, reply)) return;
      const parsed = createAgentTeamProfileBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          message: firstIssueMessage(parsed, 'Invalid Agent Profile'),
          code: 'validation_failed',
        });
      }
      if (parsed.data.launch.kind !== 'agent-team-manifest') {
        return reply.status(400).send({
          message: 'Agent Team Settings accepts only manifest Profiles',
          code: 'invalid_profile_kind',
        });
      }
      const registry = requireRegistry(reply, getRegistry);
      if (!registry) return;
      try {
        const profileId = createId('profile');
        const workingDirPath =
          parsed.data.workingDirectory.kind === 'custom'
            ? parsed.data.workingDirectory.path
            : (() => {
                if (parsed.data.agentletId !== getLocalMachine()) {
                  throw new AgentTeamError(
                    'invalid_working_directory',
                    'Default working directories require the local Agentlet',
                  );
                }
                const detail = registry.getMemberDetail(
                  parsed.data.agentletId,
                  parsed.data.launch.manifestPath,
                );
                return defaultAgentTeamWorkingDir({
                  root: getDefaultWorkspaceRoot(),
                  memberName: detail.member.name,
                  harness: parsed.data.launch.harness,
                  profileId,
                });
              })();
        return registry.createProfile({
          id: profileId,
          launchKind: 'agent-team-manifest',
          alias: parsed.data.alias,
          agentletId: parsed.data.agentletId,
          workingDirPath,
          manifestPath: parsed.data.launch.manifestPath,
          harness: parsed.data.launch.harness,
          ...(parsed.data.customData === undefined
            ? {}
            : { customData: parsed.data.customData }),
        });
      } catch (error) {
        return sendAgentTeamError(error, reply);
      }
    });

    app.patch<{
      Params: AgentProfileParams;
      Body: PatchAgentProfileBody;
      Reply: ApiResult<AgentProfileView>;
    }>('/settings/profiles/:id', async (request, reply) => {
      if (denyRemote(request, reply)) return;
      const params = agentTeamProfileActionParamsSchema.safeParse(
        request.params,
      );
      const body = patchAgentProfileBodySchema.safeParse(request.body);
      if (!params.success) {
        return reply.status(400).send({
          message: firstIssueMessage(params, 'Invalid Profile ID'),
          code: 'validation_failed',
        });
      }
      if (!body.success) {
        return reply.status(400).send({
          message: firstIssueMessage(body, 'Invalid Agent Profile patch'),
          code: 'validation_failed',
        });
      }
      const registry = requireRegistry(reply, getRegistry);
      if (!registry) return;
      try {
        return registry.patchProfile(params.data.id, body.data);
      } catch (error) {
        return sendAgentTeamError(error, reply);
      }
    });

    app.delete<{
      Params: AgentProfileParams;
      Reply: ApiResult<{ deleted: true }>;
    }>('/settings/profiles/:id', async (request, reply) => {
      if (denyRemote(request, reply)) return;
      const parsed = agentTeamProfileActionParamsSchema.safeParse(
        request.params,
      );
      if (!parsed.success) {
        return reply.status(400).send({
          message: firstIssueMessage(parsed, 'Invalid Profile ID'),
          code: 'validation_failed',
        });
      }
      const registry = requireRegistry(reply, getRegistry);
      if (!registry) return;
      try {
        if (!registry.deleteProfile(parsed.data.id)) {
          return reply.status(404).send({
            message: 'Agent Profile not found',
            code: 'profile_not_found',
          });
        }
        return { deleted: true as const };
      } catch (error) {
        return sendAgentTeamError(error, reply);
      }
    });

    const setupAction = (
      action: 'setup' | 'cancel',
      run: (
        registry: AgentTeamSettingsRegistry,
        id: string,
      ) => Promise<AgentProfileView>,
    ) => {
      app.post<{
        Params: AgentProfileParams;
        Reply: ApiResult<AgentProfileView>;
      }>(`/settings/profiles/:id/${action}`, async (request, reply) => {
        if (denyRemote(request, reply)) return;
        const parsed = agentTeamProfileActionParamsSchema.safeParse(
          request.params,
        );
        if (!parsed.success) {
          return reply.status(400).send({
            message: firstIssueMessage(parsed, 'Invalid Profile ID'),
            code: 'validation_failed',
          });
        }
        const registry = requireRegistry(reply, getRegistry);
        if (!registry) return;
        try {
          return await run(registry, parsed.data.id);
        } catch (error) {
          return sendAgentTeamError(error, reply);
        }
      });
    };

    setupAction('setup', (registry, id) => registry.setupProfile(id));
    setupAction('cancel', (registry, id) => registry.cancelProfileSetup(id));
  };
}

export default createAgentTeamRoutes(
  getAgentTeamRegistry,
  getSupervisedAgentletId,
);
