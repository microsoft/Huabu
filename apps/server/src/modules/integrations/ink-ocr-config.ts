// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { inkOcrConfigUpdateSchema, inkOcrEndpointSchema } from '@huabu/shared';

import { getDataDir } from '../../data-dir.js';
import { EnvironmentSecretStore } from '../../security/environment-secret-store.js';
import { SECRET_IDS } from '../../security/secret-ids.js';
import {
  getPersistedSecret,
  isSecretStoreWritable,
  setSecret,
} from '../../security/secret-store.js';
import { readJsonStrict } from '../../utils/fs.js';
import { createKeyedMutex } from '../../utils/keyed-mutex.js';
import { getLogger } from '../../utils/logger.js';
import {
  personalSettingsOwner,
  personalSecretId,
} from '../identity/personal-settings.js';

import type { InkOcrConfig, InkOcrConfigUpdate } from '@huabu/shared';

const endpointConfigSchema = z
  .object({ endpoint: inkOcrEndpointSchema.nullable() })
  .strict();

const configRecordSchema = z
  .object({
    version: z.literal(1),
    endpoint: inkOcrEndpointSchema.nullable(),
    apiKey: z.string().trim().min(1).max(4096).nullable(),
  })
  .strict();
type ConfigRecord = z.infer<typeof configRecordSchema>;

const MAX_RECORD_LENGTH = 32 * 1024;
const environmentStore = new EnvironmentSecretStore();
const withConfigLock = createKeyedMutex();
const log = getLogger('ink-ocr-config');

function configPath(): string {
  return join(getDataDir(), 'ink-ocr-config.json');
}

function readStoredRecord(): ConfigRecord {
  try {
    const raw = getPersistedSecret(SECRET_IDS.inkOcrConfig);
    if (raw !== null) {
      if (raw.length > MAX_RECORD_LENGTH) throw new Error();
      return configRecordSchema.parse(JSON.parse(raw));
    }
    // Legacy values are read only until the first successful single-record write.
    const legacyEndpoint = personalSettingsOwner()
      ? null
      : readJsonStrict<unknown>(configPath());
    return configRecordSchema.parse({
      version: 1,
      endpoint:
        legacyEndpoint === null
          ? null
          : endpointConfigSchema.parse(legacyEndpoint).endpoint,
      apiKey: getPersistedSecret(SECRET_IDS.inkOcrApiKey),
    });
  } catch {
    throw new Error('Invalid stored Ink OCR configuration');
  }
}

function resolveRecord(record: ConfigRecord): {
  endpoint: string | null;
  key: string | null;
} {
  return {
    endpoint:
      record.endpoint ??
      (environmentStore.getEnvironmentValue('VISION_ENDPOINT')?.trim() || null),
    key: record.apiKey ?? environmentStore.get(SECRET_IDS.inkOcrApiKey),
  };
}

export function resolveInkOcrConfiguration(): {
  endpoint: string | null;
  key: string | null;
} {
  return resolveRecord(readStoredRecord());
}

function maskRecord(record: ConfigRecord): InkOcrConfig {
  const { endpoint, key } = resolveRecord(record);
  const parsedEndpoint = inkOcrEndpointSchema.safeParse(endpoint);
  const hasStoredKey = record.apiKey !== null;
  const hasKey = Boolean(key);
  return {
    provider: 'azure-vision',
    endpoint: parsedEndpoint.success ? parsedEndpoint.data : null,
    endpointSource: record.endpoint
      ? 'stored'
      : endpoint
        ? 'environment'
        : 'none',
    keySource: hasStoredKey ? 'stored' : hasKey ? 'environment' : 'none',
    hasStoredKey,
    configured: parsedEndpoint.success && hasKey,
  };
}

/**
 * Keep an Ink OCR endpoint an earlier version saved in the data directory.
 *
 * Until the first save, the effective endpoint is read from the legacy
 * `ink-ocr-config.json`, which a deployment without mounted storage loses on
 * replacement. Saving the effective configuration once moves it into the
 * credential record; afterwards the legacy file is never read.
 *
 * Ink OCR is an optional integration, so a damaged legacy file never stops
 * the Server here: it is left where it is and keeps failing as it always
 * has, wherever the Ink OCR configuration is read: Ink OCR itself and the
 * Services settings that list it. Saving the settings reads it too, so the
 * operator repairs or moves the file aside first, then saves them.
 */
export async function importLegacyInkOcrConfig(): Promise<void> {
  if (!existsSync(configPath()) || !isSecretStoreWritable()) return;
  await withConfigLock(personalSecretId(SECRET_IDS.inkOcrConfig), async () => {
    if (getPersistedSecret(SECRET_IDS.inkOcrConfig) !== null) return;
    let record: ConfigRecord;
    try {
      record = readStoredRecord();
    } catch (error) {
      log.warn(
        { err: error, file: configPath() },
        'Legacy Ink OCR configuration is damaged; Ink OCR and the Services settings fail until the file is repaired or moved aside and the Ink OCR settings saved',
      );
      return;
    }
    await setSecret(SECRET_IDS.inkOcrConfig, JSON.stringify(record));
  });
}

export function getInkOcrConfig(): InkOcrConfig {
  return maskRecord(readStoredRecord());
}

export async function setInkOcrConfig(
  update: InkOcrConfigUpdate,
): Promise<InkOcrConfig> {
  const parsed = inkOcrConfigUpdateSchema.safeParse(update);
  if (!parsed.success) throw new Error('Invalid Ink OCR configuration update');
  return withConfigLock(personalSecretId(SECRET_IDS.inkOcrConfig), async () => {
    if (!isSecretStoreWritable()) {
      throw new Error(
        'Credential storage is read-only. Configure secure credential storage before saving Ink OCR settings.',
      );
    }
    const current = readStoredRecord();
    const next: ConfigRecord = {
      version: 1,
      endpoint:
        parsed.data.endpoint === undefined
          ? current.endpoint
          : parsed.data.endpoint,
      apiKey:
        parsed.data.apiKey === undefined ? current.apiKey : parsed.data.apiKey,
    };
    try {
      // Persist explicit nulls: deleting the record would revive legacy overrides.
      await setSecret(SECRET_IDS.inkOcrConfig, JSON.stringify(next));
    } catch {
      throw new Error('Unable to save Ink OCR configuration');
    }
    return maskRecord(next);
  });
}
