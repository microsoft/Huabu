import { z } from 'zod';

/**
 * The self-contained spawn recipe an ACP thread is bound to — the subset
 * of a host profile that determines how the external process is relaunched.
 */
export interface AcpBindingRecipe {
  command?: string;
  cwd?: string;
  autoRestart: boolean;
  alias: string;
  agentTeam?:
    | {
        manifestPath: string;
        workingDirPath: string;
        harness: string;
      }
    | {
        agentDir: string;
        harness?: string;
      };
}

export const acpBindingRecipeSchema: z.ZodType<AcpBindingRecipe> = z.object({
  command: z.string().optional(),
  cwd: z.string().optional(),
  autoRestart: z.boolean(),
  alias: z.string(),
  agentTeam: z
    .union([
      z.object({
        manifestPath: z.string(),
        workingDirPath: z.string(),
        harness: z.string(),
      }),
      z.object({
        agentDir: z.string(),
        harness: z.string().optional(),
      }),
    ])
    .optional(),
});
