// The `AgentRequest` contract — the per-turn payload a caller sends to a
// running agent. See docs/proposals/layered-architecture.md §3.6.1.
//
// A request is INDEPENDENT of the driver route (`kind`): the same driver's
// `submit()` may receive heterogeneous requests (e.g. a canvas selection vs
// a dictionary to render as a markdown table), each with completely
// different rendering. So the polymorphism lives on the REQUEST, not on the
// driver. Every request variant only has to satisfy the Agenetes request
// contract below:
//
//   - `content`     — the payload data member (shape is variant-specific).
//   - `render()`    — turn this request into the uniform `AgentInput` fed
//                     to L3. This is where all the per-variant complexity
//                     (selection rendering, dict -> markdown, …) lives.
//   - `serialize()` — the raw, JSON-serializable record for durable logs.
//
// `render()` is invoked INSIDE a driver's `submit()`, at the last moment —
// the driver receives the raw request object, logs `serialize()` (the raw
// request is the source of truth for replay/debug, NOT the rendered
// result), then calls `render()` to obtain the input for L3.
//
// "Protocol gives the blocks, the host composes." This package ships the
// `Renderable`/`Serializable` contracts, `defineRequest` (declare one
// request variant), and `composeRequest` (fold the host's registered
// variants into one closed, method-bearing union). Concrete variants (e.g.
// Sediment's `huabu.selection`) are host registrations, never upstream.

import { z } from 'zod';

/**
 * The uniform, driver-agnostic input every `render()` produces and every
 * driver's `submit()` ultimately feeds to L3. Kept minimal for M1 — this
 * is the L2<->L3 (ACP) seam and will grow (parts / attachments / …) when
 * the drivers are wired.
 */
export interface AgentInput {
  readonly message: string;
}

/**
 * Renders itself into the uniform {@link AgentInput}. Implemented per
 * request variant; called inside a driver's `submit()`.
 */
export interface Renderable {
  render(): AgentInput;
}

/**
 * Produces the raw, JSON-serializable record persisted to the durable log.
 * The raw request — not the rendered result — is the source of truth.
 */
export interface Serializable {
  serialize(): Record<string, unknown>;
}

/**
 * The method-bearing request object produced by {@link composeRequest}
 * after a successful parse: the validated wire data plus the
 * {@link Renderable} / {@link Serializable} behaviour attached by the
 * matching variant.
 */
export type AgentRequest<Data = unknown> = Data & Renderable & Serializable;

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
 * One request variant: its wire-data `schema` plus the `render` /
 * `serialize` behaviour that travels with it. `serialize` defaults to
 * returning the validated data as-is (it is already a plain record).
 */
export interface RequestDefinition<
  Type extends string = string,
  Schema extends RequestVariantSchema<Type> = RequestVariantSchema<Type>,
> {
  readonly type: Type;
  readonly schema: Schema;
  readonly render: (data: z.infer<Schema>) => AgentInput;
  readonly serialize?: (data: z.infer<Schema>) => Record<string, unknown>;
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
  serialize?: (data: z.infer<Schema>) => Record<string, unknown>;
}): RequestDefinition<Type, Schema> {
  return config;
}

/**
 * Fold the host's registered request variants into one closed request
 * schema: a `discriminatedUnion('type', …)` over their wire schemas, then a
 * single union-level `.transform` that attaches the matching variant's
 * `render` / `serialize`. A successful `safeParse` therefore yields a
 * method-bearing {@link AgentRequest}.
 *
 * Order matters: `discriminatedUnion` requires plain object members, so the
 * discriminant must be resolved BEFORE the transform (a transformed schema
 * can no longer participate in a discriminated union).
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

  return z.discriminatedUnion('type', schemas).transform((data) => {
    const variant = byType.get(data.type);
    if (variant === undefined) {
      // Unreachable: discriminatedUnion already rejected unknown `type`.
      throw new Error(`No request variant registered for type "${data.type}".`);
    }
    const serialize = variant.serialize ?? ((value) => value);
    return {
      ...data,
      render: () => variant.render(data),
      serialize: () => serialize(data) as Record<string, unknown>,
    } as AgentRequest<z.infer<Variants[number]['schema']>>;
  });
}

/**
 * The composed, host-specific request schema type produced by
 * {@link composeRequest} — use `z.infer<RequestSchema<…>>` to derive the
 * method-bearing union type in the host.
 */
export type RequestSchema<
  Variants extends readonly [AnyRequestDefinition, ...AnyRequestDefinition[]],
> = ReturnType<typeof composeRequest<Variants>>;
