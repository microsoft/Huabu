import { z } from 'zod';

import { agentMetadataSchema } from './agent-metadata.js';

/**
 * The full durable-state snapshot for one thread. `driverState` is opaque to
 * Agenetes and validated by the selected driver; `metadata` is the portable
 * observation surface consumed by the host.
 */
export const agentStateSnapshotSchema = z
  .object({
    driverState: z.unknown(),
    metadata: agentMetadataSchema.optional(),
  })
  .refine((state) => Object.hasOwn(state, 'driverState'), {
    path: ['driverState'],
    message: 'driverState is required',
  });

/** A full snapshot, never a patch; downstream consumers replace wholesale. */
export type AgentStateSnapshot<TDriverState = unknown> = Omit<
  z.infer<typeof agentStateSnapshotSchema>,
  'driverState'
> & {
  driverState: TDriverState;
};
