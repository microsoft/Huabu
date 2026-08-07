import { agentSpecSchema } from '@agenetes/protocol';
import { z } from 'zod';

import type { AgentTurn, Namespace, WorkloadType } from '@agenetes/protocol';
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

/**
 * The reasoning-effort values the driver accepts \u2014 pi-ai's thinking levels
 * plus `off` (no explicit effort / model default). Constrains the durable
 * state so an out-of-set value can never be persisted or cast into the
 * agent's `thinkingLevel`.
 */
export const PI_THINKING_LEVELS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export const piDurableStateSchema = z
  .object({
    /**
     * Per-thread model override. Opaque to the driver \u2014 it is handed to the
     * host `resolveModel` port as the {@link PiModelRef} id, which resolves
     * the concrete model. Absent \u21d2 use the recipe's default model ref.
     */
    modelId: z.string().optional(),
    /**
     * Per-thread reasoning effort, applied as the agent's `thinkingLevel`.
     * One of {@link PI_THINKING_LEVELS}; `off` maps to no explicit effort.
     * The host clamps it against the resolved model's capability on switch.
     * Absent \u21d2 model default.
     */
    reasoningEffort: z.enum(PI_THINKING_LEVELS).optional(),
  })
  .strict();
export type PiDurableState = z.infer<typeof piDurableStateSchema>;

export interface PiModelContext {
  readonly workloadType: WorkloadType;
  readonly namespace: Namespace;
  readonly threadId: string;
  readonly hostContext?: JsonObject;
}

export type PiToolContext = PiModelContext;

export type PiRunResult = Message[];

/** The durable history a handle is about to replay into a fresh agent. */
export interface PiHistoryInput {
  readonly mode: 'recover' | 'fork';
  readonly turns: readonly AgentTurn[];
}

/** A host-lowered replay payload plus the size it should be authorized at. */
export interface PiHistoryReplay {
  readonly messages: readonly Message[];
  /**
   * Size of `messages` in the unit the instance's `safeHistoryLoadLimit`
   * uses. Only the host knows how its payload prices out (inline images cost
   * far less than their base64 length suggests), so it reports the number.
   */
  readonly estimatedSize: number;
}

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
  /**
   * Lower durable turns into the native messages to seed a recovered or
   * forked agent with. Omit it to fall back to the driver's built-in text
   * seed, which flattens every turn into one JSON Lines user message and so
   * cannot carry image parts or per-role attribution.
   */
  materializeHistory?(
    input: PiHistoryInput,
    ctx: PiModelContext,
  ): Promise<PiHistoryReplay>;
}

export interface PiDriverFactoryConfig {
  readonly ports: PiDriverPorts;
}
