// The `WorkloadSpec` contract — the serializable, per-invocation spec L1
// hands to L2 to create a workload. See
// docs/proposals/layered-architecture.md §3.6.1.
//
// Shape (Option A): a flat tagged union keyed on a top-level, required
// `kind` — the driver route. There are TWO orthogonal top-level
// discriminants:
//   - `kind`         — WHICH driver (route); also fixes the `spec` TYPE.
//                      Public, required.
//   - `workloadType` — Job | Deployment (completion semantics). Only
//                      decides whether `request` is required. Named
//                      `workloadType`, not `workloadKind`, so it never
//                      collides with the driver-route `kind`.
// The per-turn `request` is NOT owned by the driver: it is a separately
// composed, polymorphic, driver-agnostic union (see ./request.ts) shared
// across every `kind`. A driver contributes only its create-time `spec`.
//
// "Protocol gives the blocks, the host composes." This package ships
// `defineBinding` (declare one driver's typed member) and
// `composeWorkloadSpec` (fold the host's registered drivers + the shared
// request union into one closed `discriminatedUnion('kind', …)`); it
// deliberately does NOT hard-code any concrete `kind` (e.g. Sediment's
// `internal`/`external`) — those are host registrations that live in the
// host, never upstream.

import { z } from 'zod';

import { threadIdSchema } from './identity.js';
import { namespaceSchema } from './namespace.js';

/**
 * Completion semantics of a workload — the lifecycle axis, owned by the
 * control plane and orthogonal to the driver route. A `Job` runs to
 * completion (must carry an initial `request`); a `Deployment` is
 * long-lived (its first `request` is optional — connect first, then
 * `submit`). See §3.2.
 */
export const workloadTypeSchema = z.enum(['Job', 'Deployment']);
export type WorkloadType = z.infer<typeof workloadTypeSchema>;

/**
 * The typed member schema a single driver contributes to the
 * `WorkloadSpec` union before the shared `request` field is injected:
 * `{ kind, workloadType, namespace, threadId, spec }`.
 * {@link composeWorkloadSpec} extends each member with `request` and
 * enforces the `workloadType === 'Job' ⇒ request required` invariant once,
 * at the union level.
 */
export type BindingMemberSchema<
  Kind extends string,
  Spec extends z.ZodTypeAny,
> = z.ZodObject<{
  kind: z.ZodLiteral<Kind>;
  workloadType: typeof workloadTypeSchema;
  namespace: typeof namespaceSchema;
  threadId: typeof threadIdSchema;
  initialPreamble: z.ZodOptional<z.ZodReadonly<z.ZodArray<z.ZodString>>>;
  spec: Spec;
}>;

/**
 * A driver's binding definition: its route `kind`, the schema for its
 * create-time `spec`, and the derived (request-less) `WorkloadSpec` union
 * member.
 */
export interface BindingDefinition<
  Kind extends string = string,
  Spec extends z.ZodTypeAny = z.ZodTypeAny,
> {
  readonly kind: Kind;
  readonly spec: Spec;
  readonly member: BindingMemberSchema<Kind, Spec>;
}

/** A binding definition with its type parameters erased. */
export type AnyBindingDefinition = BindingDefinition;

/**
 * Declare one driver's contribution to the `WorkloadSpec` union. The host
 * calls this once per registered driver (e.g. `defineBinding({ kind:
 * 'internal', spec: builtinAgentSpec })`). The per-turn `request` is NOT
 * declared here — it is the shared union passed to
 * {@link composeWorkloadSpec}.
 */
export function defineBinding<
  Kind extends string,
  Spec extends z.ZodTypeAny,
>(config: { kind: Kind; spec: Spec }): BindingDefinition<Kind, Spec> {
  const member = z.object({
    kind: z.literal(config.kind),
    workloadType: workloadTypeSchema,
    namespace: namespaceSchema,
    threadId: threadIdSchema,
    initialPreamble: z.array(z.string()).readonly().optional(),
    spec: config.spec,
  }) as BindingMemberSchema<Kind, Spec>;

  return {
    kind: config.kind,
    spec: config.spec,
    member,
  };
}

/**
 * Fold the host's registered driver bindings and the shared `request`
 * union into a single closed `WorkloadSpec` schema: a
 * `discriminatedUnion('kind', …)` over the members (each extended with the
 * shared, always-`.optional()` `request`), plus the union-level invariant
 * that a `Job` must carry a `request`. Validation at the trust boundary is
 * therefore a single typed `safeParse` pass — no `z.unknown()` two-phase is
 * needed on this seam.
 */
export function composeWorkloadSpec<
  const Bindings extends readonly [
    AnyBindingDefinition,
    ...AnyBindingDefinition[],
  ],
  Request extends z.ZodTypeAny,
>(config: { bindings: Bindings; request: Request }) {
  const members = config.bindings.map((binding) =>
    binding.member.extend({ request: config.request.optional() }),
  ) as unknown as [z.ZodObject, z.ZodObject, ...z.ZodObject[]];

  return z.discriminatedUnion('kind', members).superRefine((value, ctx) => {
    if (value.workloadType === 'Job' && value.request === undefined) {
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
  Request extends z.ZodTypeAny,
> = ReturnType<typeof composeWorkloadSpec<Bindings, Request>>;
