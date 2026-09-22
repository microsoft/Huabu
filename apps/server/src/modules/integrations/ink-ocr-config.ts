// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { join } from 'node:path';

import { z } from 'zod';

import { inkOcrEndpointSchema } from '@huabu/shared';

import { getDataDir } from '../../data-dir.js';
import { SECRET_IDS } from '../../security/secret-ids.js';
import {
  getPersistedSecret,
  getSecret,
  setSecret,
} from '../../security/secret-store.js';
import { atomicWriteJson, readJsonStrict } from '../../utils/fs.js';

import type { InkOcrConfig, InkOcrConfigUpdate } from '@huabu/shared';

const endpointConfigSchema = z
  .object({ endpoint: inkOcrEndpointSchema.nullable() })
  .strict();

function configPath(): string {
  return join(getDataDir(), 'ink-ocr-config.json');
}

function readStoredEndpoint(): string | null {
  const config = readJsonStrict<unknown>(configPath());
  if (config === null) return null;
  // Parse the file as a strict object so damaged configuration is not
  // mistaken for an absent override and silently sent to a different host.
  const parsed = endpointConfigSchema.safeParse(config);
  if (!parsed.success) throw new Error('Invalid stored Ink OCR configuration');
  return parsed.data.endpoint;
}

export function resolveInkOcrConfiguration(): {
  endpoint: string | null;
  key: string | null;
} {
  return {
    endpoint:
      readStoredEndpoint() ?? (process.env.VISION_ENDPOINT?.trim() || null),
    key: getSecret(SECRET_IDS.inkOcrApiKey)?.trim() || null,
  };
}

export function getInkOcrConfig(): InkOcrConfig {
  const storedEndpoint = readStoredEndpoint();
  const endpoint =
    storedEndpoint ?? (process.env.VISION_ENDPOINT?.trim() || null);
  const parsedEndpoint = inkOcrEndpointSchema.safeParse(endpoint);
  const hasStoredKey = Boolean(getPersistedSecret(SECRET_IDS.inkOcrApiKey));
  const hasKey = Boolean(getSecret(SECRET_IDS.inkOcrApiKey)?.trim());
  return {
    provider: 'azure-vision',
    endpoint: parsedEndpoint.success ? parsedEndpoint.data : null,
    endpointSource: storedEndpoint
      ? 'stored'
      : endpoint
        ? 'environment'
        : 'none',
    keySource: hasStoredKey ? 'stored' : hasKey ? 'environment' : 'none',
    hasStoredKey,
    configured: parsedEndpoint.success && hasKey,
  };
}

export async function setInkOcrConfig(
  update: InkOcrConfigUpdate,
): Promise<InkOcrConfig> {
  if (update.apiKey !== undefined) {
    await setSecret(SECRET_IDS.inkOcrApiKey, update.apiKey);
  }
  if (update.endpoint !== undefined) {
    atomicWriteJson(configPath(), { endpoint: update.endpoint });
  }
  return getInkOcrConfig();
}
