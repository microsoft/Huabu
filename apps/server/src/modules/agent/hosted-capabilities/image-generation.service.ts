// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Hosted `generate-image` capability service — Azure OpenAI
 * gpt-image family — shared by the native `generate_image` tool
 * adapter (`../tools/handlers/image-generation.ts`) and the
 * external RFS hosted-capability invocation adapter described in
 * docs/proposals/agent-resource-registry.md §11.
 *
 * Owns:
 *   - the canonical `generate-image` capability ID (`./capability-ids.ts`);
 *   - server-side SecretStore/config resolution of the Azure image
 *     deployment (`getAzureImageConfig`) — the caller can never select
 *     an arbitrary provider, endpoint, credential, or model;
 *   - input validation delegated to the shared per-family capability
 *     registry (`@huabu/shared`'s `validateImageSize` /
 *     `validateImageQuality`);
 *   - the provider timeout/cancellation contract;
 *   - sanitized, stable errors (`./errors.ts`);
 *   - image artifact persistence scoped to the caller-supplied Canvas
 *     context's BlobStore only — never a caller-chosen location
 *     (docs/proposals/agent-resource-registry.md §13);
 *   - result shaping (`{ src, width, height, revisedPrompt? }`)
 *     independent of any particular caller's wire envelope.
 *
 * Wire-layer (HTTP / multipart / Azure deployment routing / api
 * versioning / b64 decode / retries / aborts) is delegated to the
 * official `openai` SDK, auto-selecting between the plain `OpenAI`
 * client (Azure AI Foundry's OpenAI-compatible `/openai/v1` path) and
 * `AzureOpenAI` (classic deployment routing) based on the configured
 * `baseUrl` shape — see the inline comment below.
 */

import path from 'node:path';

import { AzureOpenAI, OpenAI, toFile } from 'openai';

import {
  createId,
  getImageCapabilities,
  validateImageQuality,
  validateImageSize,
} from '@huabu/shared';
import {
  imageGenerationInvocationInputSchema,
  type ImageGenerationInvocationInput,
} from '@huabu/shared';

import { getLogger } from '../../../utils/logger.js';
import { space } from '../../storage/index.js';
import { getAzureImageConfig } from '../llm.js';
import { HOSTED_CAPABILITY_IDS } from './capability-ids.js';
import { HostedCapabilityError } from './errors.js';

import type { HostedCapabilityInvocationOptions } from './types.js';

const log = getLogger('hosted-capability.generate-image');

export const GENERATE_IMAGE_CAPABILITY_ID = HOSTED_CAPABILITY_IDS.generateImage;

// Azure caps prompt length on gpt-image-*; trim early so we surface a
// clean, sanitized local error rather than a 4xx from upstream.
/** Bounded provider deadline (docs/proposals/agent-resource-registry.md §13). */
const REQUEST_TIMEOUT_MS = 120_000;

export type { ImageGenerationInvocationInput } from '@huabu/shared';

const MAX_REFERENCE_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_REFERENCE_BYTES = 50 * 1024 * 1024;
const MAX_GENERATED_IMAGE_BYTES = 50 * 1024 * 1024;

/**
 * Canvas scope bounding artifact persistence. This is the *only*
 * placement input the service accepts — never a caller-chosen
 * provider, endpoint, credential, or model
 * (docs/proposals/agent-resource-registry.md §11-12). The RFS
 * adapter derives `canvasId` from its authorized grant, never from
 * caller input.
 */
export interface ImageGenerationContext {
  canvasId: string;
}

export interface ImageGenerationInvocationResult {
  src: string;
  width: number;
  height: number;
  revisedPrompt?: string;
}

/**
 * Format a {@link import('@huabu/shared').ValidationResult}
 * failure as an actionable, sanitized error message.
 */
function formatValidationFailure(
  label: string,
  reason: string,
  suggestions: string[],
): string {
  if (suggestions.length === 0) return `${label} ${reason}`;
  return `${label} ${reason} Try: ${suggestions.join(' / ')}.`;
}

/**
 * Invoke the hosted `generate-image` capability.
 *
 * Always throws {@link HostedCapabilityError} on failure —
 * unconfigured/misconfigured deployment (`unavailable`), invalid
 * prompt/size/quality/reference input (`invalid_input`), a missing
 * reference artifact (`resource_not_found`), a provider deadline or
 * caller cancellation (`timeout` / `cancelled`), or any other
 * transport/provider failure (`provider_failure`). Never returns a
 * success-shaped result on error
 * (docs/proposals/agent-resource-registry.md §14).
 *
 * Artifacts are written only into `context.canvasId`'s BlobStore.
 */
export async function invokeImageGeneration(
  input: ImageGenerationInvocationInput,
  context: ImageGenerationContext,
  options: HostedCapabilityInvocationOptions = {},
): Promise<ImageGenerationInvocationResult> {
  const parsedInput = imageGenerationInvocationInputSchema.safeParse(input);
  if (!parsedInput.success) {
    throw new HostedCapabilityError(
      'invalid_input',
      parsedInput.error.issues[0]?.message ?? 'Invalid image generation input.',
    );
  }
  input = parsedInput.data;
  const prompt = input.prompt;
  if (!context.canvasId || typeof context.canvasId !== 'string') {
    throw new HostedCapabilityError(
      'invalid_input',
      'A Canvas context is required to persist the generated image artifact.',
    );
  }

  const refs = input.referenceArtifactSrcs ?? [];

  let azure: ReturnType<typeof getAzureImageConfig>;
  try {
    azure = getAzureImageConfig(); // throws with an actionable message
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new HostedCapabilityError('unavailable', message);
  }
  const caps = getImageCapabilities(azure.modelFamily);

  // ── Capability validation ────────────────────────────────────────────
  // Delegated to the shared per-family capability registry and run
  // BEFORE any artifact IO so the error path is fast and the
  // suggestion list survives back to the caller.
  const size = input.size ?? '1024x1024';
  const sizeCheck = validateImageSize(azure.modelFamily, size);
  if (!sizeCheck.ok) {
    throw new HostedCapabilityError(
      'invalid_input',
      formatValidationFailure(
        '[generate_image]',
        sizeCheck.reason,
        sizeCheck.suggestions,
      ),
    );
  }
  // Caller input > Settings default > family default. The Settings
  // value is a user-set override; the family default is the safe
  // baseline when neither is set.
  const quality = input.quality ?? azure.quality ?? caps.defaultQuality;
  const qualityCheck = validateImageQuality(azure.modelFamily, quality);
  if (!qualityCheck.ok) {
    throw new HostedCapabilityError(
      'invalid_input',
      formatValidationFailure(
        '[generate_image]',
        qualityCheck.reason,
        qualityCheck.suggestions,
      ),
    );
  }

  // ── Load reference artifacts upfront, scoped to this Canvas only ─────
  // Any missing/invalid ref is an early hard error — better than sending
  // a partial set to Azure and getting cryptic results.
  const blobs = space(context.canvasId).blobs;
  const refImages: Array<{ key: string; bytes: Buffer }> = [];
  let totalReferenceBytes = 0;
  for (const key of refs) {
    if (typeof key !== 'string' || !key.trim()) {
      throw new HostedCapabilityError(
        'invalid_input',
        `Invalid reference artifact key: ${JSON.stringify(key)}. Use the bare \`src\` string returned by snapshot_nodes.`,
      );
    }
    const bytes = await blobs.read(key);
    if (!bytes) {
      throw new HostedCapabilityError(
        'resource_not_found',
        `Reference artifact "${key}" not found on canvas ${context.canvasId}. It may have been deleted.`,
      );
    }
    totalReferenceBytes += bytes.byteLength;
    if (
      bytes.byteLength > MAX_REFERENCE_IMAGE_BYTES ||
      totalReferenceBytes > MAX_TOTAL_REFERENCE_BYTES
    ) {
      throw new HostedCapabilityError(
        'invalid_input',
        'Reference images exceed the hosted image-generation size limit.',
      );
    }
    refImages.push({ key, bytes });
  }

  // ── Pick the right OpenAI SDK client for the configured baseUrl ───────
  // Azure now exposes two completely different routing styles for
  // image generation and the right one is chosen by the *shape of
  // the baseUrl* the user pasted into Settings:
  //
  //   (a) NEW — Azure AI Foundry "OpenAI-compatible v1 path".
  //       baseUrl ends in `/openai/v1` (or `/v1`).
  //       This path mirrors the public OpenAI API 1:1 (`Bearer`
  //       auth, deployment passed as `model` in the body, no
  //       `api-version` query string). The plain `OpenAI` client
  //       with `baseURL` does the right thing.
  //
  //   (b) LEGACY — classic Azure deployment routing.
  //       baseUrl is the bare resource hostname. The `AzureOpenAI`
  //       client routes through
  //       `/openai/deployments/{name}/images/...?api-version=…`
  //       with the `api-key` header.
  //
  // Auto-detecting from the endpoint suffix means chat + image can
  // share one baseUrl without forcing the user to maintain two.
  const trimmedEndpoint = azure.endpoint.replace(/\/+$/, '');
  const isV1Style = /(?:^|\/)(?:openai\/)?v1$/i.test(trimmedEndpoint);
  const isEdit = refImages.length > 0;

  // The `openai` SDK uses `globalThis.fetch`, which Node routes
  // through the undici global dispatcher installed by `setup-proxy.ts`
  // when HTTPS_PROXY is configured. Built-in fetch + built-in
  // FormData stay realm-aligned, which keeps `images.edit` multipart
  // uploads working.
  const client = isV1Style
    ? new OpenAI({
        baseURL: trimmedEndpoint,
        apiKey: azure.apiKey,
        timeout: REQUEST_TIMEOUT_MS,
      })
    : new AzureOpenAI({
        endpoint: trimmedEndpoint,
        apiKey: azure.apiKey,
        apiVersion: azure.apiVersion,
        deployment: azure.deployment,
        timeout: REQUEST_TIMEOUT_MS,
      });

  log.info(
    {
      style: isV1Style ? 'v1' : 'azure-legacy',
      op: isEdit ? 'edit' : 'generate',
      deployment: azure.deployment,
      family: azure.modelFamily,
      size,
      quality,
      refs: refImages.length,
    },
    'generate_image invoke',
  );

  // ── Call SDK ──────────────────────────────────────────────────────────
  // Both client types expose the same `images.{generate,edit}` API.
  // `model` is `deployment` on Azure but on the v1 path it's the
  // deployment name passed in the body; we always send it so the v1
  // path works and the Azure path treats it as a confirmation.
  //
  // `options.signal` (unused by native tool adapters today) is forwarded
  // as request-level `signal` so the RFS adapter can propagate
  // caller cancellation without changing the client's own provider
  // deadline (`REQUEST_TIMEOUT_MS`, configured above).
  let revisedPrompt: string | undefined;
  let b64: string | undefined;
  try {
    if (isEdit) {
      const imageFiles = await Promise.all(
        refImages.map(async (ref) =>
          toFile(ref.bytes, path.basename(ref.key), { type: 'image/png' }),
        ),
      );
      const res = await client.images.edit(
        {
          model: azure.deployment,
          prompt,
          image: imageFiles,
          size: size as 'auto',
          quality: quality as 'auto',
          n: 1,
        },
        { signal: options.signal },
      );
      const first = res.data?.[0];
      b64 = first?.b64_json;
      revisedPrompt = first?.revised_prompt ?? undefined;
    } else {
      const res = await client.images.generate(
        {
          model: azure.deployment,
          prompt,
          size: size as 'auto',
          quality: quality as 'auto',
          n: 1,
        },
        { signal: options.signal },
      );
      const first = res.data?.[0];
      b64 = first?.b64_json;
      revisedPrompt = first?.revised_prompt ?? undefined;
    }
  } catch (err) {
    // OpenAI SDK throws `APIError` with `.status` / `.code` /
    // `.message`. Surface a short, agent-friendly message plus a
    // 404-only hint that matches the most common misconfig.
    const apiErr = err as {
      name?: string;
      status?: number;
      code?: string;
      message?: string;
    };
    const status = apiErr?.status;
    const code = apiErr?.code ? ` (${apiErr.code})` : '';
    const msg = apiErr?.message ?? String(err);
    const hint =
      status === 404
        ? ` Common causes: (1) the deployment "${azure.deployment}" doesn't exist on this Azure resource, (2) the api-version "${azure.apiVersion}" is malformed (must be YYYY-MM-DD, e.g. 2025-04-01-preview), (3) your region doesn't host ${azure.modelFamily}.`
        : '';
    const message = `Azure image request failed${status ? ` (HTTP ${status})` : ''}${code}: ${msg}.${hint}`;
    const errorCode =
      apiErr?.name === 'APIConnectionTimeoutError'
        ? 'timeout'
        : apiErr?.name === 'APIUserAbortError'
          ? options.signal?.aborted
            ? 'cancelled'
            : 'timeout'
          : 'provider_failure';
    throw new HostedCapabilityError(errorCode, message);
  }

  if (!b64 || typeof b64 !== 'string') {
    throw new HostedCapabilityError(
      'provider_failure',
      `Azure response missing data[0].b64_json — the deployment may have returned a URL instead. Confirm the deployment is a gpt-image-* model (not dall-e-3).`,
    );
  }
  if (b64.length > Math.ceil((MAX_GENERATED_IMAGE_BYTES * 4) / 3) + 4) {
    throw new HostedCapabilityError(
      'provider_failure',
      'Azure returned an image larger than the supported artifact limit.',
    );
  }

  // ── Decode + persist, scoped to this Canvas's BlobStore only ─────────
  const png = Buffer.from(b64, 'base64');
  if (png.byteLength > MAX_GENERATED_IMAGE_BYTES) {
    throw new HostedCapabilityError(
      'provider_failure',
      'Azure returned an image larger than the supported artifact limit.',
    );
  }
  // Use a `gen-` prefix (vs the generic `artifact-` used by uploads and
  // preprocessing) so future GC can distinguish model-generated images
  // — which start life as orphans until the agent follows up with a
  // `canvas_commands` insert or embeds them in a note body — from
  // user-uploaded artifacts that should never be auto-collected.
  const name = `${createId('gen')}.png`;
  await blobs.put(name, png);

  // The requested size string ("auto" included) drives what we
  // report back; gpt-image-* generally honours the request size, and
  // "auto" reports 0×0 because the actual chosen size isn't echoed
  // back in the response body.
  let w = 0;
  let h = 0;
  if (size !== 'auto') {
    const parsed = size.split('x').map((n) => Number.parseInt(n, 10));
    if (parsed.length === 2 && parsed.every((n) => Number.isFinite(n))) {
      [w, h] = parsed;
    }
  }
  const result: ImageGenerationInvocationResult = {
    src: name,
    width: w,
    height: h,
  };
  if (revisedPrompt) {
    result.revisedPrompt = revisedPrompt;
  }
  return result;
}
