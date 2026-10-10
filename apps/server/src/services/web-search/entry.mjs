// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

function parseCliArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      help: { type: 'boolean', short: 'h' },
      query: { type: 'string', short: 'q' },
      output: { type: 'string', short: 'o' },
    },
    strict: true,
    allowPositionals: false,
  });
  return { help: values.help, query: values.query, output: values.output };
}

function validateOptions(options) {
  if (!options.query?.trim()) {
    throw new Error('Web search requires --query');
  }
}

function printHelp(manifest) {
  process.stdout.write(`${manifest.name}

Usage:
  node entry.mjs --query <text> [options]

Options:
  -q, --query <text>   Search query
  -o, --output <path>  Write JSON results to a file instead of stdout
  -h, --help           Show this help
`);
}

export async function search({ config, input }) {
  const query =
    typeof input === 'string'
      ? input.trim()
      : typeof input?.query === 'string'
        ? input.query.trim()
        : '';
  if (!query) throw new Error('Web search requires a non-empty query');
  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...(typeof input === 'object' && input ? input : {}),
      api_key: config.apiKey,
      query,
    }),
  });
  if (!response.ok) {
    throw new Error(`Web search provider request failed (${response.status})`);
  }
  return response.json();
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseCliArgs(argv);
  const sdkUrl = process.env.AGENTLET_SERVICE_SDK_URL;
  if (!sdkUrl) throw new Error('AGENTLET_SERVICE_SDK_URL is unavailable');
  const { withServiceContext } = await import(sdkUrl);
  await withServiceContext('web-search', async ({ manifest, config }) => {
    if (options.help) {
      printHelp(manifest);
      return;
    }
    validateOptions(options);
    const result = await search({ config, input: options.query });
    const output = `${JSON.stringify(result, null, 2)}\n`;
    if (options.output) {
      await writeFile(options.output, output);
    } else {
      process.stdout.write(output);
    }
  });
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  await main();
}
