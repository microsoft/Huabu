// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * `generate_image` handler — Azure OpenAI gpt-image family.
 *
 * Calls the Azure image deployment configured under Settings → Image
 * Provider → Azure OpenAI. The image bytes are decoded from the
 * `b64_json` response, written into the canvas's `.artifacts/`
 * folder, and the artifact key (`gen_xxx.png`) is returned to the
 * agent so it can compose a follow-up `canvas_commands` call to drop
 * the image onto the canvas.
 *
 * Two modes:
 *   - **text-only**  → `images.generate({...})`
 *   - **with refs**  → `images.edit({ image:[…], prompt, … })` — refs
 *     are looked up from the canvas's artifact store by key.
 *
 * Wire-layer (HTTP / multipart / Azure deployment routing / api
 * versioning / b64 decode / retries / aborts) is delegated to the
 * official `openai` SDK. We auto-pick between two clients based on
 * the configured `baseUrl`:
 *
 *   - When `baseUrl` ends in `/openai/v1` (the Azure AI Foundry
 *     OpenAI-compatible path), use the plain `OpenAI` client so it
 *     posts to `{baseURL}/images/{generations|edits}` with a bearer
 *     token — exactly what that endpoint expects.
 *   - Otherwise treat the URL as a classic Azure resource hostname
 *     and use `AzureOpenAI`, which routes through
 *     `/openai/deployments/{name}/images/...?api-version=…` with the
 *     `api-key` header.
 *
 * Pre-flight validation against the per-family capability registry
 * means the agent gets a structured "size 512x512 not supported by
 * gpt-image-1; try 1024x1024 / 1024x1536 / 1536x1024" before any
 * HTTP call goes out.
 *
 * Returns `JSON.stringify({src, width, height, revisedPrompt?})` on
 * success. Errors throw — pi-agent-core wraps them as
 * `isError: true` tool results.
 */

import path from 'node:path';

import { AzureOpenAI, OpenAI, toFile } from 'openai';

import {
  createId,
  getImageCapabilities,
  validateImageQuality,
  validateImageSize,
} from '@huabu/shared';

import { getLogger } from '../../../../utils/logger.js';
import { space } from '../../../storage/index.js';
import { getAzureImageConfig } from '../../llm.js';

import type { generateImageParamsSchema } from '../definitions.js';
import type { Static } from '@earendil-works/pi-ai';

const log = getLogger('tool.generate-image');

export type GenerateImageArgs = Static<typeof generateImageParamsSchema> & {
  canvasId: string;
};

// Azure caps prompt length on gpt-image-*; trim early so we surface a
// clean local error rather than a 4xx from upstream.
const MAX_PROMPT_LEN = 4000;
const REQUEST_TIMEOUT_MS = 120_000;

/**
 * Format a {@link import('@huabu/shared').ValidationResult}
 * failure as an actionable error message.
 */
function formatValidationFailure(
  label: string,
  reason: string,
  suggestions: string[],
): string {
  if (suggestions.length === 0) return `${label} ${reason}`;
  return `${label} ${reason} Try: ${suggestions.join(' / ')}.`;
}

export async function handleGenerateImage(
  args: GenerateImageArgs,
): Promise<string> {
  const prompt = (args.prompt ?? '').trim();
  if (!prompt) {
    throw new Error('`prompt` is required and must be a non-empty string.');
  }
  if (prompt.length > MAX_PROMPT_LEN) {
    throw new Error(
      `Prompt is ${prompt.length} characters; Azure caps at ${MAX_PROMPT_LEN}. Shorten and retry.`,
    );
  }

  const refs = args.referenceArtifactSrcs ?? [];
  const azure = getAzureImageConfig(); // throws with actionable message
  const caps = getImageCapabilities(azure.modelFamily);

  // ── Capability validation ────────────────────────────────────────────
  // Run BEFORE any artifact IO so the error path is fast and the
  // suggestion list survives back to the agent.
  const size = args.size ?? '1024x1024';
  const sizeCheck = validateImageSize(azure.modelFamily, size);
  if (!sizeCheck.ok) {
    throw new Error(
      formatValidationFailure(
        '[generate_image]',
        sizeCheck.reason,
        sizeCheck.suggestions,
      ),
    );
  }
  // Tool arg > Settings default > family default. The Settings value
  // is a user-set override; the family default is the safe baseline
  // when neither is set.
  const quality = args.quality ?? azure.quality ?? caps.defaultQuality;
  const qualityCheck = validateImageQuality(azure.modelFamily, quality);
  if (!qualityCheck.ok) {
    throw new Error(
      formatValidationFailure(
        '[generate_image]',
        qualityCheck.reason,
        qualityCheck.suggestions,
      ),
    );
  }

  // ── Load reference artifacts upfront ──────────────────────────────────
  // Any missing/invalid ref is an early hard error — better than sending
  // a partial set to Azure and getting cryptic results.
  const blobs = space(args.canvasId).blobs;
  const refImages: Array<{ key: string; bytes: Buffer }> = [];
  for (const key of refs) {
    if (typeof key !== 'string' || !key.trim()) {
      throw new Error(
        `Invalid reference artifact key: ${JSON.stringify(key)}. Use the bare \`src\` string returned by snapshot_nodes.`,
      );
    }
    const bytes = await blobs.read(key);
    if (!bytes) {
      throw new Error(
        `Reference artifact "${key}" not found on canvas ${args.canvasId}. It may have been deleted.`,
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
  let revisedPrompt: string | undefined;
  let b64: string | undefined;
  try {
    if (isEdit) {
      const imageFiles = await Promise.all(
        refImages.map(async (ref) =>
          toFile(ref.bytes, path.basename(ref.key), { type: 'image/png' }),
        ),
      );
      const res = await client.images.edit({
        model: azure.deployment,
        prompt,
        image: imageFiles,
        size: size as 'auto',
        quality: quality as 'auto',
        n: 1,
      });
      const first = res.data?.[0];
      b64 = first?.b64_json;
      revisedPrompt = first?.revised_prompt ?? undefined;
    } else {
      const res = await client.images.generate({
        model: azure.deployment,
        prompt,
        size: size as 'auto',
        quality: quality as 'auto',
        n: 1,
      });
      const first = res.data?.[0];
      b64 = first?.b64_json;
      revisedPrompt = first?.revised_prompt ?? undefined;
    }
  } catch (err) {
    // OpenAI SDK throws `APIError` with `.status` / `.code` /
    // `.message`. Surface a short, agent-friendly message plus a
    // 404-only hint that matches the most common misconfig.
    const apiErr = err as { status?: number; code?: string; message?: string };
    const status = apiErr?.status;
    const code = apiErr?.code ? ` (${apiErr.code})` : '';
    const msg = apiErr?.message ?? String(err);
    const hint =
      status === 404
        ? ` Common causes: (1) the deployment "${azure.deployment}" doesn't exist on this Azure resource, (2) the api-version "${azure.apiVersion}" is malformed (must be YYYY-MM-DD, e.g. 2025-04-01-preview), (3) your region doesn't host ${azure.modelFamily}.`
        : '';
    throw new Error(
      `Azure image request failed${status ? ` (HTTP ${status})` : ''}${code}: ${msg}.${hint}`,
    );
  }

  if (!b64 || typeof b64 !== 'string') {
    throw new Error(
      `Azure response missing data[0].b64_json — the deployment may have returned a URL instead. Confirm the deployment is a gpt-image-* model (not dall-e-3).`,
    );
  }

  // ── Decode + persist ──────────────────────────────────────────────────
  const png = Buffer.from(b64, 'base64');
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
  //
  // IMPORTANT: the returned `width` and `height` should be passed to
  // the `size` parameter when creating the image node via CREATE_NODES,
  // to preserve the correct aspect ratio on the canvas. The default
  // image node size (400×300) distorts square and portrait images.
  let w = 0;
  let h = 0;
  if (size !== 'auto') {
    const parsed = size.split('x').map((n) => Number.parseInt(n, 10));
    if (parsed.length === 2 && parsed.every((n) => Number.isFinite(n))) {
      [w, h] = parsed;
    }
  }
  const result: Record<string, unknown> = {
    src: name,
    width: w,
    height: h,
  };
  if (revisedPrompt) {
    result.revisedPrompt = revisedPrompt;
  }
  return JSON.stringify(result);
}
