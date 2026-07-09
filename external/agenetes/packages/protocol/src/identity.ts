// The two-level identity contract for the Agenetes L1<->L2 seam.
// See docs/proposals/layered-architecture.md §8 ("Caller identity vs
// execution identity").
//
// Both are branded strings: nominal at the type level (a raw string is
// NOT assignable to `ThreadId`) while staying plain strings on the wire.

import { z } from 'zod';

/**
 * The caller / slot identity, minted by L1. It is the ONLY id the
 * L1<->L2 wire contract addresses: L2 routes on it, caches the handle on
 * it, and keys the durable log on it, but never interprets its structure
 * (the K8s `metadata.name` — it names the slot, not an execution).
 */
export const threadIdSchema = z.string().min(1).brand<'ThreadId'>();
export type ThreadId = z.infer<typeof threadIdSchema>;

/**
 * The execution-instance identity, owned internally by L2. One concrete
 * agent execution / live process backing a slot (the K8s `uid` / pod). A
 * `threadId` maps to 0..N `sessionId`s over its lifetime. It is NOT an
 * L1<->L2 addressing field — it surfaces only through capability-gated
 * query / resume.
 */
export const sessionIdSchema = z.string().min(1).brand<'SessionId'>();
export type SessionId = z.infer<typeof sessionIdSchema>;
