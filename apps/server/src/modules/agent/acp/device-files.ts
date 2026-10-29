// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { randomUUID } from 'node:crypto';

import {
  ensureAcpSession,
  acpSessionRegistry,
  releaseThread,
} from '@agenetes/acp-driver';
import {
  getAgentProfileRegistry,
  getAgentletGateway,
} from '@agenetes/agentlet-host';
import { FS_MAX_RESPONSE_BYTES } from '@agentlet/protocol';

import { proxyFsResponseSchema } from '@huabu/shared';

import type { AcpSessionEntry } from '@agenetes/acp-driver';
import type { DeviceFilesBody, DeviceFilesResponse } from '@huabu/shared';
import type { FastifyBaseLogger } from 'fastify';

export class DeviceFilesError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface DeviceSession {
  agentletId: string;
  threadId: string;
  entry?: AcpSessionEntry;
  pending: number;
  tail: Promise<void>;
  retired: boolean;
  starting: boolean;
  lastUsed: number;
  cleanup?: Promise<void>;
}

export class DeviceFilesService {
  private readonly sessions = new Map<string, DeviceSession>();
  private disposed = false;
  private readonly unsubscribe: () => void;
  private readonly idleTimer: ReturnType<typeof setInterval>;
  private readonly logger: Parameters<typeof ensureAcpSession>[0]['logger'];

  constructor(private readonly log: Pick<FastifyBaseLogger, 'warn' | 'error'>) {
    const gateway = getAgentletGateway();
    if (!gateway)
      throw new DeviceFilesError(
        'files_unavailable',
        503,
        'Device service is not ready',
      );
    this.unsubscribe = gateway.onAgentletsChanged(({ agentletId }) => {
      const session = this.sessions.get(agentletId);
      if (session)
        void this.retire(session).catch(() =>
          this.log.warn('Filesystem proxy cleanup failed'),
        );
    });
    this.idleTimer = setInterval(() => {
      for (const session of this.sessions.values()) {
        if (!session.pending && Date.now() - session.lastUsed > 60_000)
          void this.retire(session).catch(() =>
            this.log.warn('Filesystem proxy cleanup failed'),
          );
      }
    }, 15_000);
    this.idleTimer.unref();
    // Lower-level logs can include raw remote output; retain only fixed diagnostics.
    this.logger = {
      debug: () => undefined,
      info: () => undefined,
      warn: () => log.warn('Filesystem proxy runtime warning'),
      error: () => log.error('Filesystem proxy runtime error'),
    };
  }

  private assertCurrent(session: DeviceSession) {
    if (
      this.disposed ||
      session.retired ||
      this.sessions.get(session.agentletId) !== session ||
      getAgentletGateway()?.getAgentlet(session.agentletId)?.status !==
        'connected'
    ) {
      throw new DeviceFilesError(
        'files_disconnected',
        409,
        'Device connection changed; try again',
      );
    }
  }

  private async retire(session: DeviceSession) {
    session.retired = true;
    // Keep admission ownership until late startup settles and can be reclaimed.
    if (session.starting) return;
    session.entry?.client.shutdown('Filesystem session retired');
    acpSessionRegistry.remove(session.agentletId, session.threadId);
    session.cleanup ??= releaseThread(session.agentletId, session.threadId)
      .then(() => {
        if (this.sessions.get(session.agentletId) === session)
          this.sessions.delete(session.agentletId);
      })
      .catch(() => {
        session.cleanup = undefined;
        this.log.warn('Filesystem proxy cleanup failed');
        throw new DeviceFilesError(
          'files_cleanup_failed',
          503,
          'Could not stop the previous filesystem proxy; retry',
        );
      });
    await session.cleanup;
  }

  async dispose() {
    this.disposed = true;
    this.unsubscribe();
    clearInterval(this.idleTimer);
    await Promise.all(
      [...this.sessions.values()].map((session) => this.retire(session)),
    );
  }

  async execute(body: DeviceFilesBody): Promise<DeviceFilesResponse> {
    if (
      this.disposed ||
      getAgentletGateway()?.getAgentlet(body.agentletId)?.status !== 'connected'
    ) {
      throw new DeviceFilesError(
        'files_disconnected',
        409,
        'Device is not connected',
      );
    }
    let session = this.sessions.get(body.agentletId);
    if (session?.retired || session?.entry?.client.isClosed) {
      await this.retire(session);
      if (this.sessions.get(body.agentletId) === session)
        throw new DeviceFilesError(
          'files_busy',
          503,
          'Previous filesystem proxy is still stopping',
        );
      session = this.sessions.get(body.agentletId);
    }
    if (!session) {
      if (this.sessions.size >= 4)
        throw new DeviceFilesError(
          'files_busy',
          429,
          'Too many active file devices',
        );
      session = {
        agentletId: body.agentletId,
        threadId: `files-${randomUUID()}`,
        pending: 0,
        tail: Promise.resolve(),
        retired: false,
        starting: false,
        lastUsed: Date.now(),
      };
      this.sessions.set(body.agentletId, session);
    }
    if (session.pending >= 8)
      throw new DeviceFilesError(
        'files_busy',
        429,
        'Too many pending filesystem requests',
      );
    const current = session;
    current.pending++;
    const task = current.tail.then(() => this.run(current, body));
    current.tail = task.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await task;
    } finally {
      current.pending--;
      current.lastUsed = Date.now();
    }
  }

  private async run(
    session: DeviceSession,
    body: DeviceFilesBody,
  ): Promise<DeviceFilesResponse> {
    this.assertCurrent(session);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => {
          timedOut = true;
          void this.retire(session).catch(() =>
            this.log.warn('Filesystem proxy cleanup failed after timeout'),
          );
          reject(
            new DeviceFilesError(
              'files_timeout',
              504,
              'Filesystem request timed out',
            ),
          );
        },
        session.entry ? 10_000 : 60_000,
      );
    });
    const operation = async (): Promise<DeviceFilesResponse> => {
      if (!session.entry || session.entry.client.isClosed) {
        const profile = getAgentProfileRegistry()
          ?.listProfiles()
          .find(
            (candidate) =>
              candidate.agentletId === body.agentletId &&
              candidate.visible === false &&
              candidate.launch.kind === 'acp-harness' &&
              candidate.launch.harnessId === 'proxy' &&
              candidate.customData?.discoveredAgent &&
              typeof candidate.customData.discoveredAgent === 'object' &&
              !Array.isArray(candidate.customData.discoveredAgent) &&
              candidate.customData.discoveredAgent.version === 1 &&
              candidate.customData.discoveredAgent.agentletId ===
                body.agentletId &&
              candidate.customData.discoveredAgent.harnessId === 'proxy',
          );
        if (!profile || profile.launch.kind !== 'acp-harness') {
          throw new DeviceFilesError(
            'files_proxy_missing',
            503,
            'Update Agentlet and detect installed Agents to enable Files',
          );
        }
        session.starting = true;
        try {
          session.entry = await ensureAcpSession({
            agentletId: body.agentletId,
            threadId: session.threadId,
            workloadType: 'Job',
            binding: { alias: profile.alias, profileId: profile.id },
            recipe: {
              launch: profile.launch,
              cwd: profile.workingDirPath,
              autoRestart: false,
              alias: profile.alias,
            },
            cwd: profile.workingDirPath,
            namespace: { name: '' },
            env: {},
            idleTimeoutSecs: 90,
            logger: this.logger,
          });
        } finally {
          session.starting = false;
          if (session.retired) await this.retire(session);
        }
        if (timedOut || session.retired) {
          this.assertCurrent(session);
        }
        if (
          !['fs-list', 'fs-read'].every((name) =>
            session.entry?.availableCommands.some(
              (command) => command.name === name,
            ),
          )
        ) {
          throw new DeviceFilesError(
            'files_proxy_incompatible',
            503,
            'Filesystem proxy does not advertise the required commands',
          );
        }
      }
      this.assertCurrent(session);
      const entry = session.entry;
      let text = '';
      let bytes = 0;
      let invalid = false;
      const result = await entry.client.prompt(
        entry.sessionId,
        [
          {
            type: 'text',
            text: `/${body.operation} ${JSON.stringify(body.args)}`,
          },
        ],
        (update) => {
          if (
            update.sessionUpdate === 'agent_message_chunk' &&
            update.content.type === 'text'
          ) {
            bytes += Buffer.byteLength(update.content.text);
            if (bytes > FS_MAX_RESPONSE_BYTES) {
              invalid = true;
              entry.client.shutdown('Filesystem response exceeds limit');
            } else text += update.content.text;
          } else if (update.sessionUpdate !== 'available_commands_update')
            invalid = true;
        },
        undefined,
        (request) => {
          entry.client.resolvePermission(request.requestId, {
            cancelled: true,
          });
        },
      );
      this.assertCurrent(session);
      if (invalid || result.stopReason !== 'end_turn')
        throw new DeviceFilesError(
          'files_invalid_response',
          502,
          'Invalid filesystem proxy response',
        );
      let decoded: unknown;
      try {
        decoded = JSON.parse(text);
      } catch {
        throw new DeviceFilesError(
          'files_invalid_response',
          502,
          'Invalid filesystem proxy JSON',
        );
      }
      const parsed = proxyFsResponseSchema.safeParse(decoded);
      if (!parsed.success || parsed.data.operation !== body.operation)
        throw new DeviceFilesError(
          'files_invalid_response',
          502,
          'Incompatible filesystem proxy response',
        );
      const response = parsed.data;
      if (!response.ok) {
        const status =
          response.error.code === 'permission_denied'
            ? 403
            : response.error.code === 'not_found'
              ? 404
              : response.error.code === 'io_error'
                ? 502
                : 400;
        throw new DeviceFilesError(
          response.error.code,
          status,
          response.error.message,
        );
      }
      if (response.operation === 'fs-list')
        return { operation: response.operation, result: response.result };
      return { operation: response.operation, result: response.result };
    };
    try {
      return await Promise.race([operation(), timeout]);
    } catch (error) {
      await this.retire(session);
      if (error instanceof DeviceFilesError) throw error;
      this.log.warn('Filesystem proxy request failed');
      throw new DeviceFilesError(
        'files_unavailable',
        503,
        'Filesystem proxy is unavailable',
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
