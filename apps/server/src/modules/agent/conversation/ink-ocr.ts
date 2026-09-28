// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { z } from 'zod';

import { inkOcrEndpointSchema, inkRecognitionSchema } from '@huabu/shared';

import { resolveInkOcrConfiguration } from '../../integrations/ink-ocr-config.js';

import type { InkRecognition } from '@huabu/shared';
import type { FastifyBaseLogger } from 'fastify';

const API_VERSION = '2024-02-01';
const DEADLINE_MS = 2000;
const SLOW_MS = 1500;
const MAX_RESPONSE_BYTES = 1024 * 1024;

const readResponseSchema = z.object({
  readResult: z.object({
    blocks: z.array(
      z.object({
        lines: z.array(
          z.object({
            text: z.string(),
            words: z
              .array(
                z.object({
                  confidence: z.number().min(0).max(1).optional(),
                }),
              )
              .optional(),
          }),
        ),
      }),
    ),
  }),
});

type Configuration =
  | { outcome: 'configured'; key: string; url: URL }
  | { outcome: 'disabled' | 'config_error' };

type RecognitionOutcome =
  | 'disabled'
  | 'config_error'
  | 'success'
  | 'empty'
  | 'timeout'
  | 'remote_error'
  | 'invalid_result'
  | 'aborted';

type RecognitionResult = {
  outcome: RecognitionOutcome;
  recognition?: InkRecognition;
  status?: number;
};

export interface InkOcrRaster {
  png: Buffer;
  width: number;
  height: number;
  originNodeIds: string[];
}

interface RecognizeInkParams {
  raster: InkOcrRaster;
  logger: FastifyBaseLogger;
  signal?: AbortSignal;
}

class InvalidResultError extends Error {}

function readConfiguration(): Configuration {
  try {
    const { key, endpoint } = resolveInkOcrConfiguration();
    if (!key && !endpoint) return { outcome: 'disabled' };
    const parsedEndpoint = inkOcrEndpointSchema.safeParse(endpoint);
    if (!key || !parsedEndpoint.success) return { outcome: 'config_error' };
    const url = new URL(
      'computervision/imageanalysis:analyze',
      parsedEndpoint.data.endsWith('/')
        ? parsedEndpoint.data
        : `${parsedEndpoint.data}/`,
    );
    url.searchParams.set('api-version', API_VERSION);
    url.searchParams.set('features', 'read');
    return { outcome: 'configured', key, url };
  } catch {
    return { outcome: 'config_error' };
  }
}

export function isInkOcrConfigured(logger?: FastifyBaseLogger): boolean {
  const config = readConfiguration();
  if (config.outcome === 'configured') return true;
  if (config.outcome === 'disabled') {
    logger?.debug({ outcome: config.outcome }, '[ink-ocr] not configured');
  } else {
    logger?.warn(
      { outcome: config.outcome },
      '[ink-ocr] invalid configuration',
    );
  }
  return false;
}

async function readResponse(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  const body = response.body;
  if (!body) throw new InvalidResultError();
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
    void body.cancel().catch(() => {});
    throw new InvalidResultError();
  }

  const reader = body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    signal.throwIfAborted();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new InvalidResultError();
      chunks.push(value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
    } catch {
      throw new InvalidResultError();
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
  }
}

async function requestRecognition(
  config: Extract<Configuration, { outcome: 'configured' }>,
  raster: InkOcrRaster,
  signal: AbortSignal,
): Promise<RecognitionResult> {
  let status: number | undefined;
  try {
    signal.throwIfAborted();
    const response = await fetch(config.url, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Ocp-Apim-Subscription-Key': config.key,
      },
      body: new Uint8Array(raster.png),
    });
    status = response.status;
    if (signal.aborted || !response.ok) {
      void response.body?.cancel().catch(() => {});
      return { outcome: signal.aborted ? 'aborted' : 'remote_error', status };
    }

    const parsed = readResponseSchema.safeParse(
      await readResponse(response, signal),
    );
    if (!parsed.success) return { outcome: 'invalid_result', status };
    const lines = parsed.data.readResult.blocks.flatMap((block) =>
      block.lines
        .filter((line) => line.text.trim().length > 0)
        .map((line) => {
          const confidences = (line.words ?? []).flatMap((word) =>
            word.confidence === undefined ? [] : [word.confidence],
          );
          return {
            text: line.text,
            ...(confidences.length > 0
              ? {
                  confidence:
                    confidences.reduce((sum, value) => sum + value, 0) /
                    confidences.length,
                }
              : {}),
          };
        }),
    );
    if (lines.length === 0) return { outcome: 'empty', status };

    const recognition = inkRecognitionSchema.safeParse({
      provider: 'azure-vision',
      apiVersion: API_VERSION,
      originNodeIds: raster.originNodeIds,
      lines,
    });
    return recognition.success
      ? { outcome: 'success', recognition: recognition.data, status }
      : { outcome: 'invalid_result', status };
  } catch (error) {
    return {
      outcome: signal.aborted
        ? 'aborted'
        : error instanceof InvalidResultError
          ? 'invalid_result'
          : 'remote_error',
      status,
    };
  }
}

export async function recognizeInk({
  raster,
  logger,
  signal,
}: RecognizeInkParams): Promise<InkRecognition | undefined> {
  const started = Date.now();
  const config = readConfiguration();
  const requestController = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  let result: RecognitionResult;

  try {
    if (signal?.aborted) {
      result = { outcome: 'aborted' };
    } else if (config.outcome !== 'configured') {
      result = { outcome: config.outcome };
    } else {
      const interrupted = new Promise<RecognitionResult>((resolve) => {
        onAbort = () => {
          resolve({ outcome: 'aborted' });
          requestController.abort();
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => {
          resolve({ outcome: 'timeout' });
          requestController.abort();
        }, DEADLINE_MS);
      });
      result = await Promise.race([
        interrupted,
        requestRecognition(config, raster, requestController.signal),
      ]);
      if (signal?.aborted) {
        result = { outcome: 'aborted' };
      } else if (Date.now() - started >= DEADLINE_MS) {
        result = { outcome: 'timeout' };
      }
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
    requestController.abort();
  }

  const durationMs = Date.now() - started;
  const diagnostics = {
    outcome: result.outcome,
    durationMs,
    slow: durationMs >= SLOW_MS,
    width: raster.width,
    height: raster.height,
    nodeCount: raster.originNodeIds.length,
    lineCount: result.recognition?.lines.length ?? 0,
    ...(result.status === undefined ? {} : { status: result.status }),
  };
  if (
    result.outcome === 'config_error' ||
    result.outcome === 'remote_error' ||
    result.outcome === 'invalid_result' ||
    result.outcome === 'timeout'
  ) {
    logger.warn(diagnostics, '[ink-ocr] recognition completed');
  } else {
    logger.debug(diagnostics, '[ink-ocr] recognition completed');
  }
  return result.recognition;
}
