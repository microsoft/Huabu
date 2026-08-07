// The `Namespace` contract — L2's storage / metadata isolation scope, the
// level above `threadId` in the identity model. See
// docs/proposals/layered-architecture.md §7 (M5.0) and §8.
//
// A namespace is L2's tenant / isolation boundary (the Kubernetes namespace
// / Virtual Cluster analogue): a group-of-threads scope with its own storage
// (and, from M5.5, its own metadata surface). Every `threadId` belongs to
// exactly one namespace, giving a three-level model:
//   namespace -> threadId -> sessionId
//
// Like `threadId`, L2 treats a namespace opaquely — it is pure data L2
// persists under but never interprets. L1 gives it meaning (in Sediment
// `canvasId` is the de-facto namespace key). The full namespace object rides
// the `WorkloadSpec`, so `create(spec)` owns its persistence scope without a
// bootstrap path root.

import { z } from 'zod';

/**
 * The storage / metadata isolation scope a workload belongs to.
 *
 * - `name` — the stable scope id, addressed by L2 and treated opaque (the
 *   K8s `metadata.name` of the namespace). L1 decides what it represents.
 * - `storage` — OPTIONAL description of where this scope's L2 state
 *   persists. It is plain serializable data (it rides the `WorkloadSpec`,
 *   so it carries no methods/closures): `storage.root` is the absolute
 *   directory below which every L2 consumer derives its own sub-path (the
 *   session store → `<root>/acp-sessions.json`, the thread table → its own
 *   sub-path, …). When omitted, L2's store derives a default location from
 *   `name` under the runtime's default data root; a caller that does not
 *   care about layout supplies only a `name`.
 *
 * Extensible: `storage` may later grow typed per-purpose fields (or handles
 * to persistence services), and future metadata-scope / quota fields land
 * on the namespace itself.
 */
export const namespaceSchema = z.object({
  name: z.string().min(1),
  storage: z.object({ root: z.string() }).optional(),
});

export type Namespace = z.infer<typeof namespaceSchema>;
