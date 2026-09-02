// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Hosted Huabu capability services — barrel.
 *
 * One shared implementation per hosted capability (`web-search`,
 * `generate-image`), used today by the native `web_search` /
 * `generate_image` tool adapters and by the external RFS
 * hosted-capability invocation adapter described in
 * docs/proposals/agent-resource-registry.md §11. See that proposal
 * for the full contract this module implements: canonical capability
 * IDs, server-side SecretStore/config resolution, input validation,
 * timeout/cancellation, sanitized stable errors, and result shaping.
 */

export {
  HOSTED_CAPABILITY_IDS,
  type HostedCapabilityId,
} from './capability-ids.js';
export {
  HostedCapabilityError,
  isHostedCapabilityError,
  toInternalError,
  type HostedCapabilityErrorCode,
} from './errors.js';
export type { HostedCapabilityInvocationOptions } from './types.js';
export {
  GENERATE_IMAGE_CAPABILITY_ID,
  invokeImageGeneration,
  type ImageGenerationContext,
  type ImageGenerationInvocationInput,
  type ImageGenerationInvocationResult,
} from './image-generation.service.js';
export {
  WEB_SEARCH_CAPABILITY_ID,
  invokeWebSearch,
  type WebSearchInvocationInput,
  type WebSearchInvocationResult,
  type WebSearchResultItem,
} from './web-search.service.js';
