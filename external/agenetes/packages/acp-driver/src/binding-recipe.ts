/**
 * The self-contained spawn recipe an ACP thread is bound to — the subset
 * of a host `AcpAgentProfile` that determines how the external agent
 * process is (re)launched.
 *
 * It rides the create-time `WorkloadSpec` (L1-baked) and is forwarded
 * verbatim to the agentlet spawn call on every turn. Under
 * recipe-first-via-L1 (README I9.6 / decision R1) L1 owns keeping a
 * returning thread's recipe stable; the driver no longer persists or
 * reads it from an on-disk session store (that store was removed once the
 * durable thread state moved onto the Agenetes `ThreadStore`, I9.7).
 */
export interface AcpBindingRecipe {
  command?: string;
  cwd?: string;
  autoRestart: boolean;
  alias: string;
  agentTeam?: {
    agentDir: string;
    harness?: string;
  };
}
