/**
 * `generate_image` handler — Azure OpenAI gpt-image family.
 *
 * Calls the Azure image deployment configured under Settings → LLM
 * Provider → Azure OpenAI → Image Deployment (separate from the chat
 * deployment, since Azure provisions them per-model). The image bytes
 * are decoded from `response_format: b64_json`, written into the
 * canvas's `.artifacts/` folder, and the artifact key (`art_xxx.png`)
 * is returned to the agent so it can compose a follow-up
 * `canvas_commands` call to drop the image onto the canvas.
 *
 * Two modes:
 *   - **text-only**  → POST `/images/generations` with JSON body.
 *   - **with refs**  → POST `/images/edits` with multipart/form-data
 *     including each reference image as a file part. References are
 *     looked up from the canvas's artifact store by key, so the
 *     agent passes opaque artifact keys it obtained via
 *     `rasterize_node` (or that already live on `image` nodes).
 *
 * Returns `JSON.stringify({src, width, height, revisedPrompt?})` on
 * success. Errors throw — pi-agent-core wraps them as
 * `isError: true` tool results.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { createId } from '@sediment/shared';
// FormData must come from the same realm as the fetch implementation used
// at runtime. setup-proxy.ts swaps globalThis.fetch for undici's when a
// proxy is configured, and undici's `instanceof FormData` check is class-
// identity based — globalThis.FormData (Node's bundled copy) silently fails
// the check and undici falls back to String(body) + text/plain.
// (Blob is not exported from undici; the global one is structurally OK as
// a FormData entry.)
import { FormData } from 'undici';

import { getCanvasStore } from '../../../storage/index.js';
import { getAzureImageConfig } from '../../llm.js';

import type { generateImageParamsSchema } from '../definitions.js';
import type { Static } from '@earendil-works/pi-ai';

export type GenerateImageArgs = Static<typeof generateImageParamsSchema> & {
  canvasId: string;
};

// Azure's gpt-image-1 has a hard cap on prompt length; trim early so we
// surface a clean local error rather than a 4xx from upstream.
const MAX_PROMPT_LEN = 4000;
const REQUEST_TIMEOUT_MS = 120_000;

interface AzureImageResponse {
  data?: Array<{
    b64_json?: string;
    revised_prompt?: string;
  }>;
  error?: {
    message?: string;
    code?: string;
  };
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
  const size = args.size ?? '1024x1024';
  const azure = getAzureImageConfig(); // throws with actionable message

  // ── Resolve reference artifacts to absolute paths upfront ─────────────
  // Any missing/invalid ref is an early hard error — better than sending
  // a partial set to Azure and getting cryptic results.
  const store = getCanvasStore(args.canvasId);
  const refPaths: Array<{ key: string; absPath: string }> = [];
  for (const key of refs) {
    if (typeof key !== 'string' || !key.trim()) {
      throw new Error(
        `Invalid reference artifact key: ${JSON.stringify(key)}. Use the bare \`src\` string returned by rasterize_node.`,
      );
    }
    const abs = store.resolveArtifactFilePath(key);
    if (!abs) {
      throw new Error(
        `Reference artifact "${key}" not found on canvas ${args.canvasId}. It may have been deleted.`,
      );
    }
    refPaths.push({ key, absPath: abs });
  }

  // ── Build request ─────────────────────────────────────────────────────
  // Azure now exposes two completely different protocols for image
  // generation, and the right one is chosen by the *shape of the
  // baseUrl* the user pasted into Settings:
  //
  //   (a) NEW — Azure AI Foundry "OpenAI-compatible v1 path"
  //       baseUrl ends in `/openai/v1` (or `/v1`).
  //       This path mirrors the public OpenAI API 1:1:
  //         POST {endpoint}/images/{generations|edits}
  //         Authorization: Bearer <key>
  //         body: { model: <deployment>, prompt, size, quality, n }
  //         (no api-version, no `response_format` — gpt-image-1
  //          always returns b64_json on this path)
  //
  //   (b) LEGACY — classic Azure deployment routing
  //       baseUrl is the bare resource hostname (no trailing /openai…).
  //         POST {endpoint}/openai/deployments/{name}/images/...
  //                ?api-version=YYYY-MM-DD[-preview]
  //         api-key: <key>
  //         body: { prompt, size, quality, n }
  //
  // We auto-detect which one to use from the endpoint suffix so both
  // styles work without forcing the user to maintain two separate
  // base URLs (chat and images share the same one).
  const trimmedEndpoint = azure.endpoint.replace(/\/+$/, '');
  const v1Match = trimmedEndpoint.match(/^(.*?)(?:\/openai)?\/v1$/i);
  const isV1Style = v1Match !== null;
  const isEdit = refPaths.length > 0;
  const url = isV1Style
    ? `${trimmedEndpoint}/images/${isEdit ? 'edits' : 'generations'}`
    : `${trimmedEndpoint}/openai/deployments/${encodeURIComponent(azure.deployment)}/images/${isEdit ? 'edits' : 'generations'}?api-version=${encodeURIComponent(azure.apiVersion)}`;

  console.log(
    `[generate_image] ${isV1Style ? 'v1' : 'legacy'} POST ${url} (refs=${refPaths.length}, quality=${args.quality ?? azure.quality})`,
  );

  // gpt-image-1 does not accept `response_format` (it is hard-coded to
  // b64_json) — passing it returns a 400. Quality resolution:
  // explicit tool arg > Settings default > 'low' (cheapest).
  const quality = args.quality ?? azure.quality;
  const authHeader: Record<string, string> = isV1Style
    ? { Authorization: `Bearer ${azure.apiKey}` }
    : { 'api-key': azure.apiKey };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    if (isEdit) {
      const form = new FormData();
      form.set('prompt', prompt);
      form.set('size', size);
      form.set('n', '1');
      form.set('quality', quality);
      // On the v1 path the model name must travel in the body,
      // because the URL itself no longer carries the deployment.
      if (isV1Style) form.set('model', azure.deployment);
      for (const ref of refPaths) {
        const bytes = await readFile(ref.absPath);
        // FormData wants a Blob/File; pass mime type explicitly so
        // Azure validates correctly.
        form.append(
          'image[]',
          new Blob([bytes], { type: 'image/png' }),
          path.basename(ref.absPath),
        );
      }
      response = await fetch(url, {
        method: 'POST',
        headers: authHeader,
        body: form,
        signal: controller.signal,
      });
    } else {
      const body: Record<string, unknown> = {
        prompt,
        size,
        n: 1,
        quality,
      };
      if (isV1Style) body.model = azure.deployment;
      response = await fetch(url, {
        method: 'POST',
        headers: {
          ...authHeader,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    }
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') {
      throw new Error(
        `Azure image request timed out after ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s.`,
      );
    }
    throw new Error(
      `Azure image request failed: ${(err as Error)?.message ?? String(err)}`,
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    let detail = '';
    try {
      const body = (await response.json()) as AzureImageResponse;
      detail = body?.error?.message
        ? ` — ${body.error.message}${body.error.code ? ` (${body.error.code})` : ''}`
        : '';
    } catch {
      // Body wasn't JSON; ignore.
    }
    // Include the URL that 4xx'd so users can quickly tell whether the
    // endpoint / deployment / api-version is the problem. The API key
    // is sent as a header, not in the URL, so this is safe to log.
    const hint =
      response.status === 404
        ? ` Common causes: (1) the deployment "${azure.deployment}" doesn't exist on this Azure resource, (2) the api-version "${azure.apiVersion}" is malformed (must be YYYY-MM-DD, e.g. 2025-04-01-preview), (3) your region doesn't host gpt-image-1.`
        : '';
    throw new Error(
      `Azure image request failed with HTTP ${response.status}${detail}.\nURL: ${url}${hint}`,
    );
  }

  // ── Decode + persist ──────────────────────────────────────────────────
  const body = (await response.json()) as AzureImageResponse;
  const first = body?.data?.[0];
  const b64 = first?.b64_json;
  if (!b64 || typeof b64 !== 'string') {
    throw new Error(
      `Azure response missing data[0].b64_json. Did you set response_format correctly?`,
    );
  }
  const png = Buffer.from(b64, 'base64');
  const record = await store.writeArtifactBuffer(
    { id: createId('artifact'), ext: '.png', mimeType: 'image/png' },
    png,
  );

  // size is fixed by the request; we don't decode the PNG header to
  // double-check (gpt-image-1 honours the request size).
  const [w, h] = size.split('x').map((n) => Number.parseInt(n, 10));
  const result: Record<string, unknown> = {
    src: record.filename,
    width: w,
    height: h,
  };
  if (first?.revised_prompt) {
    result.revisedPrompt = first.revised_prompt;
  }
  return JSON.stringify(result);
}
