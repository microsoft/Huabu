// AgentResource — the canonical Agenetes catalogue record for the Resource
// Registry (docs/proposals/agent-resource-registry.md §6). A compact,
// agent-readable record telling an agent what a resource is, who provides
// it, and what source-owned and user-owned text to follow. It
// intentionally never models installation state, runtime availability,
// authorization state, input/output contracts, or provider configuration —
// those remain owned by the subsystem that resolves or invokes the
// resource.
//
// This module also owns the two generic, host-agnostic shapes every Profile
// resource selection builds on: a bounded resource-ID list (reused for a
// Profile's `resourceIds` and for validating catalogue references), and a
// generic override envelope mirroring the existing working-directory
// launch-override semantics — present means "completely replace the
// selectable list", absent means "leave it untouched".

import { z } from 'zod';

/**
 * Version of the common `AgentResource` record format (§6, §15). Only this
 * shared shape is versioned here; a hosted capability contract, Skill
 * revision, or receipt schema is independently owned and versioned outside
 * the catalogue.
 */
export const AGENT_RESOURCE_SCHEMA_VERSION = 2;

const RESOURCE_ID_MAX_LENGTH = 128;
const RESOURCE_NAME_MAX_LENGTH = 128;
const RESOURCE_PROVIDER_MAX_LENGTH = 128;
const RESOURCE_SOURCE_CONTENT_MAX_LENGTH = 100_000;
const RESOURCE_USER_CONTENT_MAX_LENGTH = 20_000;

/**
 * Bound on how many resource IDs a single Profile, override, or patch may
 * carry. Generous enough for real catalogues (§7) while keeping the wire
 * payload and any downstream preamble bounded.
 */
export const MAX_PROFILE_RESOURCE_IDS = 64;

/**
 * Stable, globally unique, human-readable kebab-case resource identifier
 * (§6). IDs never encode resource type, provider, machine, or storage
 * location (§7) — those facts live in `provider` and `sourceContent`.
 */
export const resourceIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(RESOURCE_ID_MAX_LENGTH)
  .regex(
    /^[a-z0-9]+(-[a-z0-9]+)*$/,
    'Resource ID must be lowercase kebab-case',
  );
export type AgentResourceId = z.infer<typeof resourceIdSchema>;

/**
 * A bounded, deduplicated list of resource IDs. Reused wherever a Profile
 * selects resources: the canonical Profile `resourceIds` field, launch
 * overrides, and create/patch inputs (§9). Order is caller-supplied and not
 * itself meaningful; registry `list()` order is separately guaranteed
 * stable by ID (§6).
 */
export const resourceIdListSchema = z
  .array(resourceIdSchema)
  .max(MAX_PROFILE_RESOURCE_IDS)
  .refine((ids) => new Set(ids).size === ids.length, {
    message: 'resourceIds must not contain duplicates',
  });
export type ResourceIdList = z.infer<typeof resourceIdListSchema>;

/**
 * The canonical, minimal Agenetes catalogue record (§6). Every record has
 * the same shape regardless of provider or placement — no discriminated
 * resource kinds.
 */
export const agentResourceSchema = z.object({
  /** Version of this record's common field format; see {@link AGENT_RESOURCE_SCHEMA_VERSION}. */
  schemaVersion: z.literal(AGENT_RESOURCE_SCHEMA_VERSION),
  /** Stable, globally unique, human-readable kebab-case identifier. */
  id: resourceIdSchema,
  /** Source-owned canonical name. */
  name: z.string().trim().min(1).max(RESOURCE_NAME_MAX_LENGTH),
  /** Optional user-owned presentation name. */
  displayName: z
    .string()
    .trim()
    .min(1)
    .max(RESOURCE_NAME_MAX_LENGTH)
    .optional(),
  /**
   * Stable authority ID publishing the record. Phase 1 uses `huabu` or the
   * exact Agentlet machine ID (§6). Agenetes treats this opaquely; it never
   * hard-codes a specific provider value.
   */
  provider: z.string().trim().min(1).max(RESOURCE_PROVIDER_MAX_LENGTH),
  /**
   * Source-owned agent-readable content. Refresh replaces this field without
   * changing user customization. Never contains a secret value (§6, §12).
   */
  sourceContent: z
    .string()
    .trim()
    .min(1)
    .max(RESOURCE_SOURCE_CONTENT_MAX_LENGTH),
  /**
   * User-owned global instructions supplied to every Profile selecting the
   * Resource. An empty string means no customization.
   */
  userContent: z.string().trim().max(RESOURCE_USER_CONTENT_MAX_LENGTH),
});
export type AgentResource = z.infer<typeof agentResourceSchema>;

/**
 * Generic bounded resource-ID override (§9). Mirrors the existing
 * working-directory launch-override semantics: when `resourceIds` is
 * present it completely replaces the Profile's selectable optional resource
 * IDs (an empty array means no optional resources); when the field is
 * absent the Profile's own `resourceIds` apply unchanged. Hosts compose
 * this alongside their own override fields (e.g. `workingDirPath`) rather
 * than Agenetes owning the full host-specific override envelope.
 */
export const resourceIdsOverrideSchema = z.object({
  resourceIds: resourceIdListSchema.optional(),
});
export type ResourceIdsOverride = z.infer<typeof resourceIdsOverrideSchema>;
