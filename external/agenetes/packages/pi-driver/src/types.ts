import { z } from 'zod';

import { agentSpecSchema } from '@agenetes/protocol';

import type { Namespace, WorkloadType } from '@agenetes/protocol';
import type { TypedWorkloadSpec } from '@agenetes/runtime';
import type {
  AgentTool,
  ToolExecutionMode,
} from '@earendil-works/pi-agent-core';
import type { Api, Message, Model } from '@earendil-works/pi-ai';

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
  readonly initialPreamble?: readonly string[];
  readonly recipe: PiRecipe;
  /**
   * Optional fresh-create transcript seed. Durable recovery history is
   * supplied separately through AgentCreateContext.
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
export type PiWorkloadSpec = TypedWorkloadSpec<PiSpec>;

const messageSchema = z.custom<Message>(
  (value) =>
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { role?: unknown }).role === 'string',
  'Invalid pi message',
);

export const piSpecSchema = agentSpecSchema.extend({
  recipe: z.object({
    systemPrompt: z.string().optional(),
    model: z.object({
      type: z.literal('host'),
      id: z.string().min(1),
      options: z.record(z.string(), z.unknown()).optional(),
    }),
    tools: z
      .array(
        z.object({
          name: z.string().min(1),
          options: z.record(z.string(), z.unknown()).optional(),
        }),
      )
      .readonly()
      .optional(),
    runtime: z
      .object({
        maxIterations: z.number().int().positive().optional(),
        toolExecution: z.enum(['parallel', 'sequential']).optional(),
      })
      .optional(),
  }),
  initialMessages: z.array(messageSchema).readonly().optional(),
  hostContext: z.record(z.string(), z.unknown()).optional(),
});

export const piDurableStateSchema = z.object({}).strict();
export type PiDurableState = z.infer<typeof piDurableStateSchema>;

export interface PiModelContext {
  readonly workloadType: WorkloadType;
  readonly namespace: Namespace;
  readonly threadId: string;
  readonly hostContext?: JsonObject;
}

export type PiToolContext = PiModelContext;

export type PiRunResult = Message[];

export interface PiDriverPorts {
  resolveModel(ref: PiModelRef, ctx: PiModelContext): Promise<Model<Api>>;
  getApiKey(
    ref: PiModelRef,
    ctx: PiModelContext,
  ): Promise<string | undefined> | string | undefined;
  resolveTools(
    refs: readonly PiToolRef[],
    ctx: PiToolContext,
  ): Promise<AgentTool[]>;
}

export interface PiDriverFactoryConfig {
  readonly ports: PiDriverPorts;
}
