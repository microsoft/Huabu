import {
  acpHarnessLaunchSchema,
  harnessLaunchPlanSchema,
  type AcpHarnessLaunch,
  type HarnessLaunchPlan,
} from '@agenetes/protocol';
import { z } from 'zod';

/**
 * The self-contained spawn recipe an ACP thread is bound to — the subset
 * of a host profile that determines how the external process is relaunched.
 */
export interface AcpBindingRecipe {
  command?: string;
  launch?: AcpHarnessLaunch;
  launchPlan?: HarnessLaunchPlan;
  cwd?: string;
  autoRestart: boolean;
  alias: string;
}

export const acpBindingRecipeSchema: z.ZodType<AcpBindingRecipe> = z
  .object({
    command: z
      .string()
      .refine((value) => value.trim().length > 0)
      .optional(),
    launch: acpHarnessLaunchSchema.optional(),
    launchPlan: harnessLaunchPlanSchema.optional(),
    cwd: z.string().optional(),
    autoRestart: z.boolean(),
    alias: z.string(),
  })
  .strict()
  .refine(
    (value) => (value.command !== undefined) !== (value.launch !== undefined),
    {
      message: 'Provide exactly one of command or structured launch',
    },
  )
  .refine(
    (value) => value.launchPlan === undefined || value.launch !== undefined,
    {
      message: 'launchPlan requires a structured launch',
    },
  );
