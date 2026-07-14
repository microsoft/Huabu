import {
  AgentTeamError,
  getAgentTeamRegistry,
  getSupervisedAgentletId,
  type AgentTeamRegistry,
} from '@agenetes/agentlet-host';
import {
  AGENT_TEAM_SETTINGS_SSE_EVENTS,
  agentTeamDeploymentParamsSchema,
  agentTeamMemberRefSchema,
  agentTeamRootRefSchema,
  createAgentTeamDeploymentBodySchema,
  updateAgentTeamDeploymentBodySchema,
  updateAgentTeamMemberConfigsBodySchema,
} from '@sediment/shared';

import { isLoopbackRequest } from '../security/peer.js';

import type {
  AgentTeamDeploymentParams,
  AgentTeamMemberRefBody,
  AgentTeamRootRefBody,
  AgentTeamSettingsSseEvent,
  AgentTeamSettingsState,
  ApiResult,
  CreateAgentTeamDeploymentBody,
  UpdateAgentTeamDeploymentBody,
  UpdateAgentTeamMemberConfigsBody,
} from '@sediment/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

export type AgentTeamSettingsRegistry = Pick<
  AgentTeamRegistry,
  | 'addRoot'
  | 'createDeployment'
  | 'deleteDeployment'
  | 'disableDeployment'
  | 'enableDeployment'
  | 'getMemberConfig'
  | 'listDeployments'
  | 'listMachines'
  | 'listMembers'
  | 'listRoots'
  | 'onChange'
  | 'removeRoot'
  | 'rescanRoot'
  | 'retryDeploymentSetup'
  | 'updateDeployment'
  | 'updateMemberConfigs'
>;

function denyRemote(request: FastifyRequest, reply: FastifyReply): boolean {
  if (isLoopbackRequest(request)) return false;
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
  const members = registry.listMembers();
  return {
    machines: registry.listMachines(),
    localMachine,
    roots: registry.listRoots(),
    members,
    deployments: registry.listDeployments(),
    configs: members.map((member) =>
      registry.getMemberConfig(member.machine, member.manifestPath),
    ),
  };
}

const badRequestCodes = new Set([
  'config_field_not_found',
  'invalid_alias',
  'invalid_config_value',
  'invalid_root',
  'invalid_working_directory',
  'unsupported_harness',
]);
const notFoundCodes = new Set([
  'deployment_not_found',
  'member_not_found',
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

function writeSse(
  raw: NodeJS.WritableStream,
  event: AgentTeamSettingsSseEvent,
): void {
  raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
}

export function createAgentTeamRoutes(
  getRegistry: () => AgentTeamSettingsRegistry | null,
  getLocalMachine: () => string,
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

    app.get('/settings/events', async (request, reply) => {
      if (denyRemote(request, reply)) return;
      const registry = requireRegistry(reply, getRegistry);
      if (!registry) return;

      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      reply.raw.flushHeaders?.();
      reply.raw.write(': ok\n\n');

      let unsubscribe = () => {};
      let heartbeat: NodeJS.Timeout | undefined;
      const close = () => {
        unsubscribe();
        if (heartbeat) clearInterval(heartbeat);
        if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
      };
      const publishSnapshot = () => {
        if (reply.raw.destroyed || reply.raw.writableEnded) return;
        try {
          writeSse(reply.raw, {
            type: AGENT_TEAM_SETTINGS_SSE_EVENTS.SNAPSHOT,
            data: readState(registry),
          });
        } catch (error) {
          writeSse(reply.raw, {
            type: AGENT_TEAM_SETTINGS_SSE_EVENTS.ERROR,
            data: {
              message:
                error instanceof Error
                  ? error.message
                  : 'Failed to read Agent Team state',
              code: 'agent_team_state_failed',
            },
          });
          close();
        }
      };

      request.raw.once('close', close);
      reply.raw.once('error', close);
      publishSnapshot();
      if (reply.raw.destroyed || reply.raw.writableEnded) return;
      unsubscribe = registry.onChange(publishSnapshot, (error) => {
        app.log.error({ err: error }, 'Agent Team SSE subscriber failed');
      });
      heartbeat = setInterval(() => {
        if (!reply.raw.destroyed && !reply.raw.writableEnded) {
          reply.raw.write(': keep-alive\n\n');
        }
      }, 15_000);
      heartbeat.unref();
    });

    app.post<{
      Body: AgentTeamRootRefBody;
      Reply: ApiResult<AgentTeamSettingsState>;
    }>('/settings/roots', async (request, reply) => {
      if (denyRemote(request, reply)) return;
      const parsed = agentTeamRootRefSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          message: firstIssueMessage(parsed, 'Invalid Agent Team root'),
          code: 'validation_failed',
        });
      }
      const registry = requireRegistry(reply, getRegistry);
      if (!registry) return;
      try {
        await registry.addRoot(parsed.data);
        return readState(registry);
      } catch (error) {
        return sendAgentTeamError(error, reply);
      }
    });

    app.post<{
      Body: AgentTeamRootRefBody;
      Reply: ApiResult<AgentTeamSettingsState>;
    }>('/settings/roots/rescan', async (request, reply) => {
      if (denyRemote(request, reply)) return;
      const parsed = agentTeamRootRefSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          message: firstIssueMessage(parsed, 'Invalid Agent Team root'),
          code: 'validation_failed',
        });
      }
      const registry = requireRegistry(reply, getRegistry);
      if (!registry) return;
      try {
        await registry.rescanRoot(parsed.data);
        return readState(registry);
      } catch (error) {
        return sendAgentTeamError(error, reply);
      }
    });

    app.delete<{
      Body: AgentTeamRootRefBody;
      Reply: ApiResult<AgentTeamSettingsState>;
    }>('/settings/roots', async (request, reply) => {
      if (denyRemote(request, reply)) return;
      const parsed = agentTeamRootRefSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          message: firstIssueMessage(parsed, 'Invalid Agent Team root'),
          code: 'validation_failed',
        });
      }
      const registry = requireRegistry(reply, getRegistry);
      if (!registry) return;
      if (!registry.removeRoot(parsed.data)) {
        return reply.status(404).send({
          message: 'Agent Team root not found',
          code: 'root_not_found',
        });
      }
      return readState(registry);
    });

    app.put<{
      Body: UpdateAgentTeamMemberConfigsBody;
      Reply: ApiResult<AgentTeamSettingsState>;
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
        return readState(registry);
      } catch (error) {
        return sendAgentTeamError(error, reply);
      }
    });

    app.post<{
      Body: CreateAgentTeamDeploymentBody;
      Reply: ApiResult<AgentTeamSettingsState>;
    }>('/settings/deployments', async (request, reply) => {
      if (denyRemote(request, reply)) return;
      const parsed = createAgentTeamDeploymentBodySchema.safeParse(
        request.body,
      );
      if (!parsed.success) {
        return reply.status(400).send({
          message: firstIssueMessage(parsed, 'Invalid Agent Team deployment'),
          code: 'validation_failed',
        });
      }
      const registry = requireRegistry(reply, getRegistry);
      if (!registry) return;
      try {
        registry.createDeployment(parsed.data);
        return readState(registry);
      } catch (error) {
        return sendAgentTeamError(error, reply);
      }
    });

    app.patch<{
      Params: AgentTeamDeploymentParams;
      Body: UpdateAgentTeamDeploymentBody;
      Reply: ApiResult<AgentTeamSettingsState>;
    }>('/settings/deployments/:id', async (request, reply) => {
      if (denyRemote(request, reply)) return;
      const params = agentTeamDeploymentParamsSchema.safeParse(request.params);
      const body = updateAgentTeamDeploymentBodySchema.safeParse(request.body);
      if (!params.success) {
        return reply.status(400).send({
          message: firstIssueMessage(params, 'Invalid deployment ID'),
          code: 'validation_failed',
        });
      }
      if (!body.success) {
        return reply.status(400).send({
          message: firstIssueMessage(
            body,
            'Invalid Agent Team deployment update',
          ),
          code: 'validation_failed',
        });
      }
      const registry = requireRegistry(reply, getRegistry);
      if (!registry) return;
      try {
        registry.updateDeployment(params.data.id, body.data);
        return readState(registry);
      } catch (error) {
        return sendAgentTeamError(error, reply);
      }
    });

    app.delete<{
      Params: AgentTeamDeploymentParams;
      Reply: ApiResult<AgentTeamSettingsState>;
    }>('/settings/deployments/:id', async (request, reply) => {
      if (denyRemote(request, reply)) return;
      const parsed = agentTeamDeploymentParamsSchema.safeParse(request.params);
      if (!parsed.success) {
        return reply.status(400).send({
          message: firstIssueMessage(parsed, 'Invalid deployment ID'),
          code: 'validation_failed',
        });
      }
      const registry = requireRegistry(reply, getRegistry);
      if (!registry) return;
      try {
        if (!registry.deleteDeployment(parsed.data.id)) {
          return reply.status(404).send({
            message: 'Agent Team deployment not found',
            code: 'deployment_not_found',
          });
        }
        return readState(registry);
      } catch (error) {
        return sendAgentTeamError(error, reply);
      }
    });

    const setupAction = (
      action: 'enable' | 'disable' | 'retry',
      run: (
        registry: AgentTeamSettingsRegistry,
        id: string,
      ) => Promise<unknown>,
    ) => {
      app.post<{
        Params: AgentTeamDeploymentParams;
        Reply: ApiResult<AgentTeamSettingsState>;
      }>(`/settings/deployments/:id/${action}`, async (request, reply) => {
        if (denyRemote(request, reply)) return;
        const parsed = agentTeamDeploymentParamsSchema.safeParse(
          request.params,
        );
        if (!parsed.success) {
          return reply.status(400).send({
            message: firstIssueMessage(parsed, 'Invalid deployment ID'),
            code: 'validation_failed',
          });
        }
        const registry = requireRegistry(reply, getRegistry);
        if (!registry) return;
        try {
          await run(registry, parsed.data.id);
          return readState(registry);
        } catch (error) {
          return sendAgentTeamError(error, reply);
        }
      });
    };

    setupAction('enable', (registry, id) => registry.enableDeployment(id));
    setupAction('disable', (registry, id) => registry.disableDeployment(id));
    setupAction('retry', (registry, id) => registry.retryDeploymentSetup(id));
  };
}

export default createAgentTeamRoutes(
  getAgentTeamRegistry,
  getSupervisedAgentletId,
);
