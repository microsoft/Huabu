// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * `generate_image` handler — Azure OpenAI gpt-image family.
 *
 * This is now a thin adapter over the shared hosted-capability service
 * in `../../hosted-capabilities/image-generation.service.ts`. That
 * service owns Azure config/credential resolution, capability-based
 * size/quality validation, reference-artifact lookup and the b64
 * decode/persist step scoped to the supplied canvas, the provider
 * timeout/cancellation contract, and error sanitization. The same
 * service will back the external RFS hosted-capability invocation
 * adapter (docs/proposals/agent-resource-registry.md §11), so native
 * and external callers share one implementation and one Canvas
 * BlobStore write path.
 *
 * Returns `JSON.stringify({src, width, height, revisedPrompt?})` on
 * success — `src` is the persisted artifact key (`gen_xxx.png`) the
 * agent should pass to a follow-up `space_commands` `CREATE_NODES`
 * call (`width`/`height` preserve the image's aspect ratio; the
 * default image node size would otherwise distort it).
 *
 * Errors throw — pi-agent-core wraps them as `isError: true` tool
 * results. `HostedCapabilityError extends Error`, so the service's
 * sanitized `.message` propagates unchanged; native behavior is
 * therefore identical to before the extraction.
 */

import { invokeImageGeneration } from '../../hosted-capabilities/image-generation.service.js';

import type { generateImageParamsSchema } from '../definitions.js';
import type { Static } from '@earendil-works/pi-ai';

export type GenerateImageArgs = Static<typeof generateImageParamsSchema> & {
  canvasId: string;
};

export async function handleGenerateImage(
  args: GenerateImageArgs,
): Promise<string> {
  const result = await invokeImageGeneration(
    {
      prompt: args.prompt,
      referenceArtifactSrcs: args.referenceArtifactSrcs,
      size: args.size,
      quality: args.quality,
    },
    { canvasId: args.canvasId },
  );
  return JSON.stringify(result);
}
