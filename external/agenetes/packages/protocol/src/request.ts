// The `AgentRequest` contract — the per-turn payload a caller sends to a
// running agent. See docs/proposals/layered-architecture.md §3.6.1.
//
// A request is INDEPENDENT of the driver route (`kind`): the same driver's
// `submit()` may receive heterogeneous requests (e.g. a canvas selection vs
// a dictionary to render as a markdown table), each with completely
// different rendering. So the polymorphism lives on the REQUEST VARIANT,
// not on the driver. Every variant only has to carry:
//
//   - `type`    — the string-literal discriminant (tells variants apart).
//   - `content` — the payload data member (shape is variant-specific).
//
// The request itself is plain, JSON-serializable data — persisting the raw
// request to the durable log is just `JSON.stringify(request)`, and the raw
// request (not any rendered result) is the source of truth for replay.
//
// Rendering — turning a request into the uniform `AgentInput` fed to L3 —
// is a SEPARATE, driver-agnostic concern. Each variant declares its own
// `render`; `composeRequest` folds the registered variants into one wire
// `schema` plus a single type-dispatching `render` function. A driver's
// `submit(request, render)` receives that composed renderer explicitly and
// invokes it at the last moment — the driver never owns rendering.
//
// "Protocol gives the blocks, the host composes." This package ships
// `defineRequest` / `composeRequest`; concrete variants (e.g. Sediment's
// `huabu.selection`) and their `render` implementations are host
// registrations, never upstream.

import { z } from 'zod';

/**
 * The uniform, driver-agnostic input every `render` produces and every
 * driver's `submit()` ultimately feeds to L3. Kept minimal for M1 — this
 * is the L2<->L3 (ACP) seam and will grow (parts / attachments / …) when
 * the drivers are wired.
 */
export interface AgentInput {
  readonly message: string;
}

/**
 * The driver-agnostic *base* shape every composed request variant
 * satisfies: a string-literal `type` discriminant plus a variant-specific
 * `content`. A host composes a closed union of concrete variants
 * ({@link composeRequest}); this base is what the framework persists and
 * replays — the raw request is plain JSON-serializable data, so persisting
 * it to the durable turn log (README I9.8) is just `JSON.stringify`, and
 * the raw request (never a rendered result) is the source of truth for
 * replay. Any concrete variant value is assignable to this base.
 */
export const agentRequestBaseSchema = z.object({
  type: z.string(),
  content: z.unknown(),
});

/** The persisted, driver-agnostic per-turn request (see {@link agentRequestBaseSchema}). */
export type AgentRequest = z.infer<typeof agentRequestBaseSchema>;

/**
 * A request variant's object schema. It MUST carry the string-literal
 * discriminant `type` (so variants can be told apart on the wire) and a
 * `content` payload member; anything else is variant-specific.
 */
export type RequestVariantSchema<Type extends string> = z.ZodObject<
  {
    type: z.ZodLiteral<Type>;
    content: z.ZodTypeAny;
  },
  z.core.$catchall<z.ZodTypeAny> | z.core.$strip
>;

/**
 * A type-dispatching renderer over a composed request schema: maps any
 * validated request to the uniform {@link AgentInput}.
 */
export type Renderer<Schema extends z.ZodTypeAny> = (
  request: z.infer<Schema>,
) => AgentInput;

/**
 * One request variant: its wire-data `schema` plus the `render` behaviour
 * that belongs to it. `render` is typed against this variant's own data.
 */
export interface RequestDefinition<
  Type extends string = string,
  Schema extends RequestVariantSchema<Type> = RequestVariantSchema<Type>,
> {
  readonly type: Type;
  readonly schema: Schema;
  readonly render: (data: z.infer<Schema>) => AgentInput;
}

/** A request definition with its type parameters erased. */
export type AnyRequestDefinition = RequestDefinition;

/**
 * Declare one request variant. The host calls this once per registered
 * variant (e.g. `defineRequest({ type: 'huabu.selection', schema, render
 * })`) and passes the collection to {@link composeRequest}.
 */
export function defineRequest<
  Type extends string,
  Schema extends RequestVariantSchema<Type>,
>(config: {
  type: Type;
  schema: Schema;
  render: (data: z.infer<Schema>) => AgentInput;
}): RequestDefinition<Type, Schema> {
  return config;
}

/**
 * Fold the host's registered request variants into a closed request
 * contract: a `discriminatedUnion('type', …)` `schema` for wire validation
 * (yielding plain data) and a single `render` function that dispatches on
 * `type` to the matching variant's renderer. The composed `render` is what
 * a driver's `submit(request, render)` receives — one renderer shared
 * across every driver.
 */
export function composeRequest<
  const Variants extends readonly [
    AnyRequestDefinition,
    ...AnyRequestDefinition[],
  ],
>(variants: Variants) {
  const byType = new Map(
    variants.map((variant) => [variant.type, variant] as const),
  );

  const schemas = variants.map((variant) => variant.schema) as unknown as [
    Variants[number]['schema'],
    ...Variants[number]['schema'][],
  ];

  const schema = z.discriminatedUnion('type', schemas);

  const render: Renderer<typeof schema> = (request) => {
    const variant = byType.get(request.type);
    if (variant === undefined) {
      // Unreachable: `schema` already rejected unknown `type`.
      throw new Error(
        `No request variant registered for type "${request.type}".`,
      );
    }
    return variant.render(request);
  };

  return { schema, render };
}

/**
 * The composed request contract produced by {@link composeRequest} — the
 * wire `schema` plus its type-dispatching `render`. Use
 * `z.infer<ComposedRequest<…>['schema']>` to derive the request union type
 * in the host.
 */
export type ComposedRequest<
  Variants extends readonly [AnyRequestDefinition, ...AnyRequestDefinition[]],
> = ReturnType<typeof composeRequest<Variants>>;
