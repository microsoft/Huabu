// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Canonical hosted-capability resource IDs.
 *
 * These are the stable identifiers the shared hosted-capability
 * service, the native tool adapters (`web_search` / `generate_image`),
 * and the Agenetes Resource Registry and its RFS invocation
 * adapter all agree on. They match the `web-search` / `generate-image`
 * catalogue records described in
 * docs/proposals/agent-resource-registry.md §7 and are the IDs a
 * runtime capability grant (§13) will bind to.
 *
 * Owning them here keeps the mapping from a native tool name to its
 * catalogue resource ID in one place instead of duplicating the
 * string across every future caller.
 */
export const HOSTED_CAPABILITY_IDS = {
  webSearch: 'web-search',
  generateImage: 'generate-image',
} as const;

export type HostedCapabilityId =
  (typeof HOSTED_CAPABILITY_IDS)[keyof typeof HOSTED_CAPABILITY_IDS];
