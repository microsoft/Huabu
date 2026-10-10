// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const QUALITIES = new Set(['low', 'medium', 'high', 'auto']);

function valueAfter(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith('-')) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--prompt' || argument === '-p') {
      options.prompt = valueAfter(argv, index, argument);
      index += 1;
    } else if (argument === '--prompt-file') {
      options.promptFile = valueAfter(argv, index, argument);
      index += 1;
    } else if (argument === '--quality') {
      options.quality = valueAfter(argv, index, argument);
      index += 1;
    } else if (argument === '--output' || argument === '-o') {
      options.output = valueAfter(argv, index, argument);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (options.prompt && options.promptFile) {
    throw new Error('Use either --prompt or --prompt-file, not both');
  }
  if (!options.prompt && !options.promptFile) {
    throw new Error('Image generation requires --prompt or --prompt-file');
  }
  if (!options.output) {
    throw new Error('Image generation requires --output');
  }
  if (options.quality && !QUALITIES.has(options.quality)) {
    throw new Error('--quality must be low, medium, high, or auto');
  }
  return options;
}

async function promptFrom(options) {
  const prompt = options.promptFile
    ? await readFile(options.promptFile, 'utf8')
    : options.prompt;
  if (!prompt?.trim()) {
    throw new Error('Image generation requires a non-empty prompt');
  }
  return prompt.trim();
}

export async function generate({ config, input }) {
  if (!input || typeof input.prompt !== 'string' || !input.prompt.trim()) {
    throw new Error('Image generation requires a non-empty prompt');
  }
  const endpoint = config.baseUrl.replace(/\/+$/, '');
  const deployment = config.model || config.modelFamily;
  const v1Style = /(?:^|\/)(?:openai\/)?v1$/i.test(endpoint);
  const url = v1Style
    ? new URL(`${endpoint}/images/generations`)
    : new URL(
        `${endpoint}/openai/deployments/${encodeURIComponent(deployment)}/images/generations`,
      );
  if (!v1Style) url.searchParams.set('api-version', config.apiVersion);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      ...(v1Style
        ? { authorization: `Bearer ${config.apiKey}` }
        : { 'api-key': config.apiKey }),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      ...input,
      prompt: input.prompt.trim(),
      quality: input.quality || config.quality,
      ...(v1Style ? { model: deployment } : {}),
    }),
  });
  if (!response.ok) {
    throw new Error(`Image provider request failed (${response.status})`);
  }
  return response.json();
}

async function imageBytes(result) {
  const image = result?.data?.[0];
  if (typeof image?.b64_json === 'string') {
    return Buffer.from(image.b64_json, 'base64');
  }
  if (typeof image?.url === 'string') {
    const response = await fetch(image.url);
    if (!response.ok) {
      throw new Error(`Image download failed (${response.status})`);
    }
    return Buffer.from(await response.arrayBuffer());
  }
  throw new Error('Image provider response did not contain image bytes');
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const sdkUrl = process.env.AGENTLET_SERVICE_SDK_URL;
  if (!sdkUrl) throw new Error('AGENTLET_SERVICE_SDK_URL is unavailable');
  const { withServiceConfig } = await import(sdkUrl);
  await withServiceConfig('image-gen', async ({ config }) => {
    const result = await generate({
      config,
      input: {
        prompt: await promptFrom(options),
        ...(options.quality ? { quality: options.quality } : {}),
      },
    });
    await writeFile(options.output, await imageBytes(result));
  });
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  await main();
}
