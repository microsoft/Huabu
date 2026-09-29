import { z } from 'zod';

/** Only catalogue-defined ACP controls are accepted; no arbitrary argv or env. */
export const harnessLaunchOptionsSchema = z
  .object({ autoApprove: z.boolean().optional() })
  .strict();

export const acpHarnessLaunchSchema = z
  .object({
    kind: z.literal('acp-harness'),
    harnessId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    options: harnessLaunchOptionsSchema.optional(),
  })
  .strict();

export const agentProfileLaunchSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('acp-command'),
      command: z.string().refine((value) => value.trim().length > 0),
    })
    .strict(),
  acpHarnessLaunchSchema,
]);

/** A persisted assertion checked against the target daemon's own catalogue. */
export const harnessLaunchPlanSchema = z
  .object({
    version: z.literal(1),
    executable: z.string().min(1).max(4096),
    argv: z.array(z.string().max(4096)).max(128),
    env: z.record(z.string().max(256), z.string().max(4096)),
  })
  .strict();

export type AcpHarnessLaunch = z.infer<typeof acpHarnessLaunchSchema>;
export type AgentProfileLaunch = z.infer<typeof agentProfileLaunchSchema>;
export type HarnessLaunchOptions = z.infer<typeof harnessLaunchOptionsSchema>;
export type HarnessLaunchPlan = z.infer<typeof harnessLaunchPlanSchema>;
