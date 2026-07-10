import type { AgentTool, ToolExecutionMode } from '@earendil-works/pi-agent-core';
import type { Api, Message, Model } from '@earendil-works/pi-ai';
import type { Namespace, WorkloadType } from '@agenetes/protocol';
import type { RenderFn as RuntimeRenderFn } from '@agenetes/runtime';

export type JsonObject = Record<string, unknown>;

export interface PiModelRef {
  /**
   * Host-managed symbolic model selector. The driver does not interpret
   * the id; it passes the ref back to the registered ports.
   */
  readonly type: 'host';
  readonly id: string;
  readonly options?: JsonObject;
}

export interface PiToolRef {
  readonly name: string;
  readonly options?: JsonObject;
}

export interface PiRecipe {
  readonly systemPrompt?: string;
  readonly model: PiModelRef;
  readonly tools?: readonly PiToolRef[];
  readonly runtime?: {
    readonly maxIterations?: number;
    readonly toolExecution?: ToolExecutionMode;
  };
}

export interface PiSpec {
  readonly recipe: PiRecipe;
  /**
   * Create-time transcript seed. Job-first Huabu cutover uses this to
   * carry the rebuilt prior transcript; a live Deployment normally seeds
   * it once and then keeps mutating in-memory state.
   */
  readonly initialMessages?: readonly Message[];
  /**
   * Host-owned opaque routing/context facts. The driver only hands this
   * object back to registered ports.
   */
  readonly hostContext?: JsonObject;
}

/**
 * The create-time WorkloadSpec projection the pi handle bakes. A full
 * host WorkloadSpec satisfies this structurally, so the mounted instance
 * can pass the spec straight through.
 */
export interface PiWorkloadSpec {
  readonly kind: string;
  readonly workloadType: WorkloadType;
  readonly namespace: Namespace;
  readonly threadId: string;
  readonly spec: PiSpec;
}

export interface PiModelContext {
  readonly workloadType: WorkloadType;
  readonly namespace: Namespace;
  readonly threadId: string;
  readonly hostContext?: JsonObject;
}

export interface PiToolContext extends PiModelContext {}

export type PiRenderedInput = Message[];
export type PiRunResult = Message[];
export type PiRequestRenderer<TRequest> = RuntimeRenderFn<TRequest, PiRenderedInput>;

export interface PiDriverPorts<TRequest = unknown> {
  resolveModel(ref: PiModelRef, ctx: PiModelContext): Promise<Model<Api>>;
  getApiKey(ref: PiModelRef, ctx: PiModelContext): Promise<string | undefined> | string | undefined;
  resolveTools(refs: readonly PiToolRef[], ctx: PiToolContext): Promise<AgentTool[]>;
  renderFallback?: PiRequestRenderer<TRequest>;
}

export interface PiDriverFactoryConfig<TRequest = unknown> {
  readonly ports: PiDriverPorts<TRequest>;
}
