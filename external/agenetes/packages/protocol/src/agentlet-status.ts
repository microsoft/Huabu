// Agentlet daemon status — the wire snapshot the L2 control plane
// surfaces about the single embedded agentlet it supervises.
//
// This lives in @agenetes/protocol (not the fastify-bound
// @agenetes/agentlet-host package) because the L1 UI consumes it as a
// browser-safe wire type: the web bundle reaches it transitively through
// @huabu/shared, which must never depend on a package that drags in
// Fastify or WebSocket runtime dependencies. Keeping it here (zod-only) lets
// both the supervisor's `getStatus()` return type and the browser share
// one definition without a layering leak.

import { z } from 'zod';

/**
 * Status of the single agentlet known to an Agenetes instance. Surfaced
 * to L1 (and the browser) only so the UI can render a troubleshooting
 * affordance when the supervisor gives up; on the happy path the user
 * never sees it.
 */
export const agentletStatusSchema = z.object({
  /** True when an agentlet is currently connected to the server. */
  online: z.boolean(),
  /** Opaque agentlet id when online. */
  agentletId: z.string().min(1).optional(),
  /** Hostname reported via agentlet/hello. */
  hostname: z.string().min(1).optional(),
  /** Platform string (e.g. `'darwin'`, `'win32'`). */
  platform: z.string().min(1).optional(),
  /** ISO timestamp of the most recent successful agentlet connection. */
  connectedAt: z.string().min(1).optional(),
  /**
   * Most recent supervisor error message when the agentlet is offline.
   * Empty / undefined on the happy path.
   */
  lastError: z.string().optional(),
  /**
   * Epoch ms of the next scheduled restart attempt while in backoff.
   * Undefined when not in backoff (either online or supervisor gave up).
   */
  nextRestartAt: z.number().int().nonnegative().optional(),
});

export type AgentletStatus = z.infer<typeof agentletStatusSchema>;
