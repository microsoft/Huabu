import { agentSpecSchema, agentProfileLaunchSchema } from '@agenetes/protocol';
import { defineDriver } from '@agenetes/runtime';
import { z } from 'zod';

import type { AgentProfileSnapshot } from './types.js';
import type {
  AgentCapabilities,
  AgentSpec,
  AgentStateSnapshot,
  AgentStreamEvent,
  AgentSubmission,
} from '@agenetes/protocol';
import type {
  AgentCreateContext,
  AgentHandle,
  MountedAgentDriver,
  RuntimeSchema,
  TypedWorkloadSpec,
} from '@agenetes/runtime';

export interface AgentProfileSpec extends AgentSpec {
  readonly binding: { readonly alias: string; readonly profileId: string };
  readonly profile: AgentProfileSnapshot;
  readonly env?: Record<string, string>;
  readonly initialPreferences?: {
    readonly model?: string;
    readonly thoughtLevel?: string;
  };
}

export type AgentProfileWorkloadSpec = TypedWorkloadSpec<AgentProfileSpec>;

interface AcpDelegateSpec extends AgentSpec {
  readonly binding: { readonly alias: string; readonly profileId: string };
  readonly agentletId: string;
  readonly cwd: string;
  readonly recipe?: {
    readonly command?: string;
    readonly launch?: Extract<
      AgentProfileSnapshot['launch'],
      { kind: 'acp-harness' }
    >;
    readonly cwd?: string;
    readonly autoRestart: true;
    readonly alias: string;
  };
  readonly env?: Record<string, string>;
  readonly initialPreferences?: AgentProfileSpec['initialPreferences'];
}

type AcpDelegateWorkloadSpec = TypedWorkloadSpec<AcpDelegateSpec>;

export interface AgentProfileDriverConfig {
  readonly delegate: MountedAgentDriver;
  readonly delegateCapabilities: AgentCapabilities;
}

const profileSnapshotSchema = z.object({
  profileId: z.string(),
  agentletId: z.string(),
  workingDirPath: z.string(),
  launch: agentProfileLaunchSchema,
});

export const agentProfileSpecSchema = agentSpecSchema.extend({
  binding: z.object({
    alias: z.string(),
    profileId: z.string(),
  }),
  profile: profileSnapshotSchema,
  env: z.record(z.string(), z.string()).optional(),
  initialPreferences: z
    .object({
      model: z.string().optional(),
      thoughtLevel: z.string().optional(),
    })
    .strict()
    .optional(),
});

function lowerProfile(
  workload: AgentProfileWorkloadSpec,
): AcpDelegateWorkloadSpec {
  const { profile, binding, env, initialPreamble, initialPreferences } =
    workload.spec;
  return {
    ...workload,
    spec: {
      initialPreamble,
      binding,
      agentletId: profile.agentletId,
      cwd: profile.workingDirPath,
      env,
      ...(initialPreferences ? { initialPreferences } : {}),
      recipe: {
        ...(profile.launch.kind === 'acp-command'
          ? { command: profile.launch.command }
          : { launch: profile.launch }),
        cwd: profile.workingDirPath,
        autoRestart: true,
        alias: binding.alias,
      },
    },
  };
}

class AgentProfileHandle<
  TSubmission extends AgentSubmission,
  TResult,
  TEvent extends AgentStreamEvent,
  TTurnCtx,
> implements AgentHandle<TSubmission, TResult, TEvent, TTurnCtx> {
  readonly capabilities: AgentCapabilities;
  private delegate?: AgentHandle<TSubmission, TResult, TEvent, TTurnCtx>;
  private delegatePromise?: Promise<
    AgentHandle<TSubmission, TResult, TEvent, TTurnCtx>
  >;
  private readonly stateListeners = new Set<
    (snapshot: AgentStateSnapshot) => void
  >();
  private unsubscribeDelegateState?: () => void;
  private closed = false;

  constructor(
    private readonly workload: AgentProfileWorkloadSpec,
    private readonly context: AgentCreateContext,
    private readonly config: AgentProfileDriverConfig,
  ) {
    this.capabilities = config.delegateCapabilities;
  }

  private async realize(): Promise<
    AgentHandle<TSubmission, TResult, TEvent, TTurnCtx>
  > {
    if (this.delegate) return this.delegate;
    if (this.delegatePromise) return this.delegatePromise;
    this.delegatePromise = this.createDelegate();
    try {
      return await this.delegatePromise;
    } finally {
      this.delegatePromise = undefined;
    }
  }

  private async createDelegate(): Promise<
    AgentHandle<TSubmission, TResult, TEvent, TTurnCtx>
  > {
    const lowered = lowerProfile(this.workload);
    const delegate = this.config.delegate.create(
      lowered,
      this.context,
    ) as AgentHandle<TSubmission, TResult, TEvent, TTurnCtx>;
    if (this.closed) {
      delegate.close();
      throw new Error('Agent Profile handle is closed');
    }
    this.delegate = delegate;
    if (delegate.onState) {
      this.unsubscribeDelegateState = delegate.onState((snapshot) => {
        for (const listener of this.stateListeners) listener(snapshot);
      });
    }
    return delegate;
  }

  async *run(
    submission: TSubmission | null,
    ctx: TTurnCtx,
  ): AsyncGenerator<TEvent, TResult> {
    const delegate = await this.realize();
    return yield* delegate.run(submission, ctx);
  }

  async control(
    msg: Parameters<AgentHandle['control']>[0],
  ): Promise<Awaited<ReturnType<AgentHandle['control']>>> {
    const delegate = await this.realize();
    return delegate.control(msg);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribeDelegateState?.();
    this.delegate?.close();
    this.stateListeners.clear();
  }

  onState(listener: (snapshot: AgentStateSnapshot) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }
}

function delegateStateSchema(
  delegate: MountedAgentDriver,
): RuntimeSchema<unknown> {
  return {
    safeParse(input) {
      try {
        return { success: true, data: delegate.validateState(input) };
      } catch (error) {
        return { success: false, error };
      }
    },
  };
}

export function agentProfileDriverFactory<
  TSubmission extends AgentSubmission = AgentSubmission,
  TResult = unknown,
  TEvent extends AgentStreamEvent = AgentStreamEvent,
  TTurnCtx = unknown,
>(config: AgentProfileDriverConfig): MountedAgentDriver {
  return defineDriver({
    schemaVersion: 1,
    workloadTypes: ['Deployment'],
    specSchema: agentProfileSpecSchema,
    stateSchema: delegateStateSchema(config.delegate),
    initialState: () => config.delegate.initialState(),
    create: (workload, context) =>
      new AgentProfileHandle<TSubmission, TResult, TEvent, TTurnCtx>(
        workload,
        context,
        config,
      ),
  });
}
