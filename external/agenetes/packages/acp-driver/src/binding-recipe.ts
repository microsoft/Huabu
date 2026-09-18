import { z } from 'zod';

/**
 * The self-contained spawn recipe an ACP thread is bound to — the subset
 * of a host profile that determines how the external process is relaunched.
 */
export interface AcpBindingRecipe {
  command: string;
  cwd?: string;
  autoRestart: boolean;
  alias: string;
}

export const acpBindingRecipeSchema: z.ZodType<AcpBindingRecipe> = z
  .object({
    command: z.string().refine((value) => value.trim().length > 0),
    cwd: z.string().optional(),
    autoRestart: z.boolean(),
    alias: z.string(),
  })
  .strict();
