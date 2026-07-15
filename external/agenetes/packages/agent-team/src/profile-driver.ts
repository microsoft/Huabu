import type {
  AgentProfileSnapshot,
  AgentTeamManifestRuntime,
} from './types.js';
import type {
  AgentCapabilities,
  AgentStateSnapshot,
  AgentStreamEvent,
  AgentSubmission,
  ControlAck,
  ControlMsg,
  Namespace,
} from '@agenetes/protocol';
import type {
  AgentCreateContext,
  AgentDriver,
  AgentHandle,
} from '@agenetes/runtime';


export interface AgentProfileWorkloadSpec {
  readonly threadId: string;
  readonly namespace: Namespace;
  readonly binding: { readonly alias: string; readonly profileId: string };
  readonly profile: AgentProfileSnapshot;
  readonly initialPreamble?: readonly string[];
  readonly env?: Record<string, string>;
  readonly kind?: string;
}

export interface LegacyAgentProfileWorkloadSpec {
  readonly threadId: string;
  readonly namespace: Namespace;
  readonly binding: { readonly alias: string; readonly profileId: string };
  readonly initialPreamble?: readonly string[];
  readonly env?: Record<string, string>;
  readonly kind?: string;
  readonly agentletId?: string;
  readonly cwd?: string;
  readonly recipe?: unknown;
}

export type AgentProfileDriverInput =
  | AgentProfileWorkloadSpec
  | LegacyAgentProfileWorkloadSpec;

export interface LoweredAgentProfileWorkloadSpec extends AgentProfileWorkloadSpec {
  readonly agentletId: string;
  readonly cwd: string;
  readonly recipe?: {
    readonly command?: string;
    readonly cwd?: string;
    readonly autoRestart: true;
    readonly alias: string;
    readonly agentTeam?: {
      readonly manifestPath: string;
      readonly workingDirPath: string;
      readonly harness: string;
    };
  };
  readonly resolveRecipe?: () => Promise<{
    recipe: NonNullable<LoweredAgentProfileWorkloadSpec['recipe']>;
    env?: Record<string, string>;
  }>;
}

export type AgentProfileDelegateWorkloadSpec =
  | LoweredAgentProfileWorkloadSpec
  | LegacyAgentProfileWorkloadSpec;

export interface AgentProfileRuntimePorts {
  resolveManifestRuntime(
    snapshot: AgentProfileSnapshot,
  ): Promise<AgentTeamManifestRuntime>;
}

export interface AgentProfileDriverConfig<
  TSubmission extends AgentSubmission,
  TResult,
  TEvent extends AgentStreamEvent,
  TTurnCtx,
> {
  delegate: AgentDriver<
    AgentProfileDelegateWorkloadSpec,
    TSubmission,
    TResult,
    TEvent,
    TTurnCtx
  >;
  delegateCapabilities: AgentCapabilities;
  ports: AgentProfileRuntimePorts;
}

function lowerCommandProfile(
  spec: AgentProfileWorkloadSpec,
): LoweredAgentProfileWorkloadSpec {
  if (spec.profile.launch.kind !== 'acp-command') {
    throw new Error(
      'Command Profile lowering requires an ACP command snapshot',
    );
  }
  return {
    ...spec,
    agentletId: spec.profile.agentletId,
    cwd: spec.profile.workingDirPath,
    recipe: {
      command: spec.profile.launch.command,
      cwd: spec.profile.workingDirPath,
      autoRestart: true,
      alias: spec.binding.alias,
    },
  };
}

function delegateContext(
  context: AgentCreateContext<AgentProfileDriverInput>,
  spec: AgentProfileDelegateWorkloadSpec,
): AgentCreateContext<AgentProfileDelegateWorkloadSpec> {
  const durableInput = context.durableInput;
  return {
    recovery: context.recovery,
    ...(durableInput
      ? {
          durableInput: {
            ...durableInput,
            record: {
              ...durableInput.record,
              spec,
            },
          },
        }
      : {}),
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
    private readonly spec: AgentProfileDriverInput,
    private readonly context: AgentCreateContext<AgentProfileDriverInput>,
    private readonly config: AgentProfileDriverConfig<
      TSubmission,
      TResult,
      TEvent,
      TTurnCtx
    >,
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
    const lowered =
      'profile' in this.spec
        ? this.spec.profile.launch.kind === 'acp-command'
          ? lowerCommandProfile(this.spec)
          : this.lowerManifestProfile()
        : this.spec;
    const delegate = this.config.delegate.create(
      lowered,
      delegateContext(this.context, lowered),
    );
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

  private lowerManifestProfile(): LoweredAgentProfileWorkloadSpec {
    if (!('profile' in this.spec)) {
      throw new Error('Manifest lowering requires a Profile workload');
    }
    const launch = this.spec.profile.launch;
    if (launch.kind !== 'agent-team-manifest') {
      throw new Error('Manifest Profile lowering requires a manifest snapshot');
    }
    const profile = this.spec.profile;
    const hostEnvironment = this.spec.env;
    const alias = this.spec.binding.alias;
    return {
      ...this.spec,
      agentletId: profile.agentletId,
      cwd: profile.workingDirPath,
      resolveRecipe: async () => {
        const runtime = await this.config.ports.resolveManifestRuntime(profile);
        return {
          env: { ...runtime.environment, ...hostEnvironment },
          recipe: {
            autoRestart: true,
            alias,
            agentTeam: {
              manifestPath: launch.manifestPath,
              workingDirPath: profile.workingDirPath,
              harness: launch.harness,
            },
          },
        };
      },
    };
  }

  async *run(
    submission: TSubmission | null,
    ctx: TTurnCtx,
  ): AsyncGenerator<TEvent, TResult> {
    const delegate = await this.realize();
    return yield* delegate.run(submission, ctx);
  }

  async control(msg: ControlMsg): Promise<ControlAck> {
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

export function agentProfileDriverFactory<
  TSubmission extends AgentSubmission = AgentSubmission,
  TResult = unknown,
  TEvent extends AgentStreamEvent = AgentStreamEvent,
  TTurnCtx = unknown,
>(
  config: AgentProfileDriverConfig<TSubmission, TResult, TEvent, TTurnCtx>,
): AgentDriver<
  AgentProfileDriverInput,
  TSubmission,
  TResult,
  TEvent,
  TTurnCtx
> {
  return {
    create: (spec, context) => new AgentProfileHandle(spec, context, config),
  };
}
