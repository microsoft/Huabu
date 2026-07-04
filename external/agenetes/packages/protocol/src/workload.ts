// The `WorkloadSpec` contract — the serializable, per-invocation spec L1
// hands to L2 to create a workload. See
// docs/proposals/layered-architecture.md §3.6.1.
//
// Shape (Option A): a flat tagged union keyed on a top-level, required
// `kind` — the driver route. There are TWO orthogonal top-level
// discriminants:
//   - `kind`         — WHICH driver (route); also fixes the `spec` +
//                      `request` TYPES. Public, required.
//   - `workloadKind` — Job | Deployment (completion semantics). Only
//                      decides whether `request` is required.
// `request` is DRIVER-OWNED (there is no universal request shape): every
// driver declares its own `spec` (create-time config) and `request`
// (per-turn payload), and the same `request` schema also types that
// driver's `submit()`.
//
// "Protocol gives the blocks, the host composes." This package ships
// `defineBinding` (declare one driver's typed member) and
// `composeWorkloadSpec` (fold the host's registered drivers into one
// closed `discriminatedUnion('kind', …)`); it deliberately does NOT
// hard-code any concrete `kind` (e.g. Sediment's `internal`/`external`) —
// those are host registrations that live in the host, never upstream.

import { z } from 'zod';

import { threadIdSchema } from './identity.js';

/**
 * Completion semantics of a workload — the lifecycle axis, owned by the
 * control plane and orthogonal to the driver route. A `Job` runs to
 * completion (must carry an initial `request`); a `Deployment` is
 * long-lived (its first `request` is optional — connect first, then
 * `submit`). See §3.2.
 */
export const workloadKindSchema = z.enum(['Job', 'Deployment']);
export type WorkloadKind = z.infer<typeof workloadKindSchema>;

/**
 * The typed member schema a single driver contributes to the
 * `WorkloadSpec` union: `{ kind, workloadKind, threadId, spec, request? }`.
 * `request` is always `.optional()` at the schema level; the
 * `workloadKind === 'Job' ⇒ request required` invariant is enforced once,
 * at the union level, by {@link composeWorkloadSpec}.
 */
export type BindingMemberSchema<
  Kind extends string,
  Spec extends z.ZodTypeAny,
  Request extends z.ZodTypeAny,
> = z.ZodObject<{
  kind: z.ZodLiteral<Kind>;
  workloadKind: typeof workloadKindSchema;
  threadId: typeof threadIdSchema;
  spec: Spec;
  request: z.ZodOptional<Request>;
}>;

/**
 * A driver's binding definition: its route `kind` plus the schemas for
 * its create-time `spec` and per-turn `request`, and the derived
 * `WorkloadSpec` union member. The `request` schema here is the single
 * source reused by that driver's `submit(request)` signature.
 */
export interface BindingDefinition<
  Kind extends string = string,
  Spec extends z.ZodTypeAny = z.ZodTypeAny,
  Request extends z.ZodTypeAny = z.ZodTypeAny,
> {
  readonly kind: Kind;
  readonly spec: Spec;
  readonly request: Request;
  readonly member: BindingMemberSchema<Kind, Spec, Request>;
}

/** A binding definition with its type parameters erased. */
export type AnyBindingDefinition = BindingDefinition;

/**
 * Declare one driver's contribution to the `WorkloadSpec` union. The host
 * calls this once per registered driver (e.g. `defineBinding({ kind:
 * 'internal', spec: builtinAgentSpec, request: chatEnvelope })`) and
 * reuses `.request` for that driver's `submit()` signature.
 */
export function defineBinding<
  Kind extends string,
  Spec extends z.ZodTypeAny,
  Request extends z.ZodTypeAny,
>(config: {
  kind: Kind;
  spec: Spec;
  request: Request;
}): BindingDefinition<Kind, Spec, Request> {
  const member = z.object({
    kind: z.literal(config.kind),
    workloadKind: workloadKindSchema,
    threadId: threadIdSchema,
    spec: config.spec,
    request: config.request.optional(),
  }) as BindingMemberSchema<Kind, Spec, Request>;

  return {
    kind: config.kind,
    spec: config.spec,
    request: config.request,
    member,
  };
}

/**
 * Fold the host's registered driver bindings into a single closed
 * `WorkloadSpec` schema: a `discriminatedUnion('kind', …)` over their
 * members, plus the union-level invariant that a `Job` must carry a
 * `request`. Validation at the trust boundary is therefore a single typed
 * `safeParse` pass — no `z.unknown()` two-phase is needed on this seam.
 */
export function composeWorkloadSpec<
  const Bindings extends readonly [
    AnyBindingDefinition,
    ...AnyBindingDefinition[],
  ],
>(bindings: Bindings) {
  const members = bindings.map((binding) => binding.member) as unknown as [
    Bindings[number]['member'],
    ...Bindings[number]['member'][],
  ];

  return z.discriminatedUnion('kind', members).superRefine((value, ctx) => {
    if (value.workloadKind === 'Job' && value.request === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'A Job workload requires an initial request.',
        path: ['request'],
      });
    }
  });
}

/**
 * The composed, host-specific `WorkloadSpec` schema type produced by
 * {@link composeWorkloadSpec} — use `z.infer<WorkloadSpecSchema<…>>` to
 * derive the union type in the host.
 */
export type WorkloadSpecSchema<
  Bindings extends readonly [AnyBindingDefinition, ...AnyBindingDefinition[]],
> = ReturnType<typeof composeWorkloadSpec<Bindings>>;
