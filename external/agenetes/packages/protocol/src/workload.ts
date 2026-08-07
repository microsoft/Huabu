import { z } from 'zod';

import { namespaceSchema } from './namespace.js';

/**
 * Completion semantics of a workload. A Job creates a fresh handle for one
 * invocation; a Deployment keeps one live handle per thread.
 */
export const workloadTypeSchema = z.enum(['Job', 'Deployment']);
export type WorkloadType = z.infer<typeof workloadTypeSchema>;

/**
 * Portable realization semantics every standard driver spec supports.
 * Driver-specific fields extend this object inside the driver package.
 */
export const agentSpecSchema = z.object({
  initialPreamble: z.array(z.string()).readonly().optional(),
});
export type AgentSpec = z.infer<typeof agentSpecSchema>;

/**
 * The opaque durable declaration Agenetes accepts. The selected driver owns
 * and validates `spec`; Agenetes reads only the routing, lifecycle, identity,
 * and persistence fields.
 *
 * `threadId` remains a plain string because the current runtime uses an empty
 * value for transient Jobs that intentionally leave no durable footprint.
 */
export const workloadSpecSchema = z
  .object({
    kind: z.string().min(1),
    workloadType: workloadTypeSchema,
    namespace: z.union([
      namespaceSchema,
      z.object({ name: z.literal(''), storage: z.undefined().optional() }),
    ]),
    threadId: z.string(),
    spec: z.unknown(),
  })
  .superRefine((workload, ctx) => {
    if (
      workload.workloadType === 'Deployment' &&
      workload.threadId.length === 0
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['threadId'],
        message: 'A Deployment requires a non-empty threadId.',
      });
    }
    if (
      workload.workloadType === 'Deployment' &&
      workload.namespace.name.length === 0
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['namespace', 'name'],
        message: 'A Deployment requires a non-empty namespace.',
      });
    }
  });
export type WorkloadSpec = z.infer<typeof workloadSpecSchema>;
