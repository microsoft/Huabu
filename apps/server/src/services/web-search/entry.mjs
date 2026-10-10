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
      query: { type: 'string', short: 'q' },
      output: { type: 'string', short: 'o' },
    },
    strict: true,
    allowPositionals: false,
  });
  const options = { query: values.query, output: values.output };
  if (!options.query?.trim()) {
    throw new Error('Web search requires --query');
  }
  return options;
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
  const { withServiceConfig } = await import(sdkUrl);
  await withServiceConfig('web-search', async ({ config }) => {
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
