// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  DEFAULT_AZURE_IMAGE_API_VERSION,
  DEFAULT_IMAGE_MODEL_FAMILY,
  getImageCapabilities,
  inkOcrConfigUpdateSchema,
  llmImageConfigUpdateSchema,
} from '@huabu/shared';

import { SECRET_IDS } from '../../security/secret-ids.js';
import { getSecret } from '../../security/secret-store.js';
import {
  getImageConfig,
  getAzureImageConfig,
  setImageConfig,
} from '../agent/llm.js';
import {
  getInkOcrConfig,
  resolveInkOcrConfiguration,
  setInkOcrConfig,
} from '../integrations/ink-ocr-config.js';
import {
  getRapidApiKey,
  getTavilyApiKey,
  setIntegrationsConfig,
} from '../integrations/integrations.js';

import type {
  CapabilityConfig,
  CapabilityFieldValue,
  CapabilityLease,
  CapabilityManifest,
  CapabilitySummary,
  ImageModelFamily,
  LLMImageConfigUpdate,
} from '@huabu/shared';

interface AdapterSnapshot {
  values: Record<string, CapabilityFieldValue>;
  configuredFields: string[];
}

interface CapabilityStorageAdapter {
  read(): AdapterSnapshot;
  update(values: Readonly<Record<string, CapabilityFieldValue>>): Promise<void>;
  resolve(): Record<string, CapabilityFieldValue>;
}

export class CapabilityServiceError extends Error {
  constructor(
    readonly code:
      | 'capability_not_found'
      | 'capability_not_external'
      | 'capability_not_configured'
      | 'invalid_capability_config',
    message: string,
  ) {
    super(message);
    this.name = 'CapabilityServiceError';
  }
}

function presentFields(
  values: Readonly<Record<string, CapabilityFieldValue>>,
): string[] {
  return Object.entries(values)
    .filter(([, value]) =>
      typeof value === 'string' ? value.trim().length > 0 : value !== null,
    )
    .map(([id]) => id);
}

function imageSnapshot(): AdapterSnapshot {
  const stored = getImageConfig();
  const modelFamily = stored.modelFamily ?? DEFAULT_IMAGE_MODEL_FAMILY;
  const values: Record<string, CapabilityFieldValue> = {
    provider: stored.provider || 'azure-openai',
    baseUrl: stored.baseUrl ?? '',
    modelFamily,
    model: stored.model ?? '',
    apiVersion: stored.apiVersion ?? DEFAULT_AZURE_IMAGE_API_VERSION,
    quality: stored.quality ?? getImageCapabilities(modelFamily).defaultQuality,
    apiKey: null,
  };
  const configuredFields = presentFields(values).filter(
    (field) => field !== 'apiKey',
  );
  if (getSecret(SECRET_IDS.imageApiKey)) configuredFields.push('apiKey');
  return { values, configuredFields };
}

const imageAdapter: CapabilityStorageAdapter = {
  read: imageSnapshot,
  async update(values) {
    const update: LLMImageConfigUpdate = {};
    if ('provider' in values) {
      update.provider =
        typeof values.provider === 'string' ? values.provider : '';
    }
    if ('baseUrl' in values) {
      update.baseUrl = typeof values.baseUrl === 'string' ? values.baseUrl : '';
    }
    if ('model' in values) {
      update.model = typeof values.model === 'string' ? values.model : '';
    }
    if ('modelFamily' in values && typeof values.modelFamily === 'string') {
      update.modelFamily = values.modelFamily as ImageModelFamily;
    }
    if ('apiVersion' in values) {
      update.apiVersion =
        typeof values.apiVersion === 'string' ? values.apiVersion : '';
    }
    if ('quality' in values && typeof values.quality === 'string') {
      update.quality = values.quality as 'low' | 'medium' | 'high' | 'auto';
    }
    if ('apiKey' in values) {
      update.apiKey = typeof values.apiKey === 'string' ? values.apiKey : null;
    }
    const parsed = llmImageConfigUpdateSchema.safeParse(update);
    if (!parsed.success) {
      throw new CapabilityServiceError(
        'invalid_capability_config',
        parsed.error.issues[0]?.message ?? 'Invalid image configuration',
      );
    }
    await setImageConfig(parsed.data);
  },
  resolve() {
    const resolved = getAzureImageConfig();
    return {
      provider: 'azure-openai',
      baseUrl: resolved.endpoint,
      model: resolved.deployment,
      modelFamily: resolved.modelFamily,
      apiVersion: resolved.apiVersion,
      quality:
        resolved.quality ??
        getImageCapabilities(resolved.modelFamily).defaultQuality,
      apiKey: resolved.apiKey,
    };
  },
};

function secretAdapter(options: {
  read: () => string | undefined;
  update: (value: string | null) => Promise<unknown>;
}): CapabilityStorageAdapter {
  return {
    read() {
      const configured = Boolean(options.read());
      return {
        values: { apiKey: null },
        configuredFields: configured ? ['apiKey'] : [],
      };
    },
    async update(values) {
      if (!('apiKey' in values)) return;
      await options.update(
        typeof values.apiKey === 'string' ? values.apiKey : null,
      );
    },
    resolve() {
      return { apiKey: options.read() ?? '' };
    },
  };
}

const inkOcrAdapter: CapabilityStorageAdapter = {
  read() {
    const config = getInkOcrConfig();
    return {
      values: { endpoint: config.endpoint ?? '', apiKey: null },
      configuredFields: [
        ...(config.endpoint ? ['endpoint'] : []),
        ...(config.keySource !== 'none' ? ['apiKey'] : []),
      ],
    };
  },
  async update(values) {
    const update = {
      ...('endpoint' in values
        ? {
            endpoint:
              typeof values.endpoint === 'string' && values.endpoint.trim()
                ? values.endpoint
                : null,
          }
        : {}),
      ...('apiKey' in values
        ? {
            apiKey:
              typeof values.apiKey === 'string' && values.apiKey.trim()
                ? values.apiKey
                : null,
          }
        : {}),
    };
    const parsed = inkOcrConfigUpdateSchema.safeParse(update);
    if (!parsed.success) {
      throw new CapabilityServiceError(
        'invalid_capability_config',
        parsed.error.issues[0]?.message ?? 'Invalid Ink OCR configuration',
      );
    }
    await setInkOcrConfig(parsed.data);
  },
  resolve() {
    const config = resolveInkOcrConfiguration();
    return { endpoint: config.endpoint ?? '', apiKey: config.key ?? '' };
  },
};

const adapters = new Map<string, CapabilityStorageAdapter>([
  ['llm.imageConfig', imageAdapter],
  [
    'integration.tavily',
    secretAdapter({
      read: getTavilyApiKey,
      update: (apiKey) => setIntegrationsConfig({ tavilyApiKey: apiKey }),
    }),
  ],
  [
    'integration.rapidapi',
    secretAdapter({
      read: getRapidApiKey,
      update: (apiKey) => setIntegrationsConfig({ rapidApiKey: apiKey }),
    }),
  ],
  ['integration.azureVisionInkOcr', inkOcrAdapter],
]);

function adapterFor(manifest: CapabilityManifest): CapabilityStorageAdapter {
  const adapter = adapters.get(manifest.storage.namespace);
  if (!adapter) {
    throw new Error(
      `Unknown Capability storage namespace: ${manifest.storage.namespace}`,
    );
  }
  return adapter;
}

function isConfigured(
  manifest: CapabilityManifest,
  configuredFields: readonly string[],
): boolean {
  const configured = new Set(configuredFields);
  return manifest.configuration
    .filter((field) => field.required)
    .every((field) => configured.has(field.id));
}

function validateUpdate(
  manifest: CapabilityManifest,
  values: Readonly<Record<string, CapabilityFieldValue>>,
): void {
  const fields = new Map(
    manifest.configuration.map((field) => [field.id, field]),
  );
  for (const [id, value] of Object.entries(values)) {
    const field = fields.get(id);
    if (!field) {
      throw new CapabilityServiceError(
        'invalid_capability_config',
        `Unknown configuration field: ${id}`,
      );
    }
    if (value === null) continue;
    if (field.type === 'boolean') {
      if (typeof value !== 'boolean') {
        throw new CapabilityServiceError(
          'invalid_capability_config',
          `${field.label} must be a boolean`,
        );
      }
      continue;
    }
    if (typeof value !== 'string') {
      throw new CapabilityServiceError(
        'invalid_capability_config',
        `${field.label} must be text`,
      );
    }
    if (field.type === 'url' && value) {
      try {
        const url = new URL(value);
        if (url.protocol !== 'https:') throw new Error();
      } catch {
        throw new CapabilityServiceError(
          'invalid_capability_config',
          `${field.label} must be an HTTPS URL`,
        );
      }
    }
    if (
      field.type === 'enum' &&
      value &&
      !field.options?.some((option) => option.value === value)
    ) {
      throw new CapabilityServiceError(
        'invalid_capability_config',
        `Invalid ${field.label}`,
      );
    }
  }
}

export class CapabilityProvisionService {
  constructor(
    private readonly manifests: ReadonlyMap<string, CapabilityManifest>,
  ) {}

  private manifest(capabilityId: string): CapabilityManifest {
    const manifest = this.manifests.get(capabilityId);
    if (!manifest) {
      throw new CapabilityServiceError(
        'capability_not_found',
        `Unknown Capability: ${capabilityId}`,
      );
    }
    return manifest;
  }

  list(): CapabilitySummary[] {
    return [...this.manifests.values()].map((manifest) => {
      const snapshot = adapterFor(manifest).read();
      const configured = isConfigured(manifest, snapshot.configuredFields);
      return {
        id: manifest.id,
        version: manifest.version,
        name: manifest.name,
        description: manifest.description,
        configured,
        availableToExternalAgent: configured && Boolean(manifest.agent),
      };
    });
  }

  getConfig(capabilityId: string): CapabilityConfig {
    const manifest = this.manifest(capabilityId);
    const snapshot = adapterFor(manifest).read();
    return {
      manifest,
      values: snapshot.values,
      configuredFields: snapshot.configuredFields,
      configured: isConfigured(manifest, snapshot.configuredFields),
    };
  }

  async updateConfig(
    capabilityId: string,
    values: Readonly<Record<string, CapabilityFieldValue>>,
  ): Promise<CapabilityConfig> {
    const manifest = this.manifest(capabilityId);
    validateUpdate(manifest, values);
    await adapterFor(manifest).update(values);
    return this.getConfig(capabilityId);
  }

  resolveForServer(capabilityId: string): Record<string, CapabilityFieldValue> {
    const manifest = this.manifest(capabilityId);
    const adapter = adapterFor(manifest);
    const snapshot = adapter.read();
    if (!isConfigured(manifest, snapshot.configuredFields)) {
      throw new CapabilityServiceError(
        'capability_not_configured',
        `Capability "${capabilityId}" is not configured`,
      );
    }
    return adapter.resolve();
  }

  lease(capabilityId: string): CapabilityLease {
    const manifest = this.manifest(capabilityId);
    if (!manifest.agent) {
      throw new CapabilityServiceError(
        'capability_not_external',
        `Capability "${capabilityId}" is not available to External Agents`,
      );
    }
    return {
      id: manifest.id,
      version: manifest.version,
      config: this.resolveForServer(capabilityId),
      ...(manifest.agent?.client ? { client: manifest.agent.client } : {}),
    };
  }
}
