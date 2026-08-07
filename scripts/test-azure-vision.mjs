#!/usr/bin/env node
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const REQUEST_TIMEOUT_MS = 20_000;

dotenv.config({ path: path.join(repoRoot, '.env'), quiet: true });

const imageArgument = process.argv[2];
if (!imageArgument) {
  console.error('Usage: pnpm vision:ocr -- <image-path>');
  process.exitCode = 1;
} else {
  await run(imageArgument);
}

async function run(imagePath) {
  const key = process.env.VISION_KEY;
  const endpoint = process.env.VISION_ENDPOINT;

  if (!key || !endpoint) {
    throw new Error('VISION_KEY and VISION_ENDPOINT must be set in .env');
  }

  const resolvedImagePath = path.resolve(process.cwd(), imagePath);
  const image = await readFile(resolvedImagePath);
  const url = new URL(
    'computervision/imageanalysis:analyze',
    ensureTrailingSlash(endpoint),
  );
  url.searchParams.set('api-version', '2024-02-01');
  url.searchParams.set('features', 'read');

  const response = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      'Content-Type': 'application/octet-stream',
      'Ocp-Apim-Subscription-Key': key,
    },
    body: image,
  });

  if (!response.ok) {
    throw new Error(
      `Azure AI Vision request failed (${response.status}): ${await response.text()}`,
    );
  }

  const result = await response.json();
  const lines = (result.readResult?.blocks ?? []).flatMap(
    (block) => block.lines ?? [],
  );

  if (lines.length === 0) {
    console.log('No text detected.');
    return;
  }

  for (const [index, line] of lines.entries()) {
    const confidence = averageConfidence(line.words ?? []);
    const confidenceLabel =
      confidence === null ? 'n/a' : `${Math.round(confidence * 100)}/100`;
    console.log(`${index + 1}. ${line.text}`);
    console.log(`   Confidence: ${confidenceLabel}`);
  }
}

function ensureTrailingSlash(endpoint) {
  return endpoint.endsWith('/') ? endpoint : `${endpoint}/`;
}

function averageConfidence(words) {
  const values = words
    .map((word) => word.confidence)
    .filter((confidence) => Number.isFinite(confidence));

  if (values.length === 0) return null;
  return (
    values.reduce((sum, confidence) => sum + confidence, 0) / values.length
  );
}
