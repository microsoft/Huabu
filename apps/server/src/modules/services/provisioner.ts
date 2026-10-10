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
  ServiceConfig,
  ServiceFieldValue,
  ServiceLease,
  ServiceManifest,
  ServiceSummary,
  ImageModelFamily,
  LLMImageConfigUpdate,
} from '@huabu/shared';

interface AdapterSnapshot {
  values: Record<string, ServiceFieldValue>;
  configuredFields: string[];
}

interface ServiceStorageAdapter {
  read(): AdapterSnapshot;
  update(values: Readonly<Record<string, ServiceFieldValue>>): Promise<void>;
  resolve(): Record<string, ServiceFieldValue>;
}

export class ServiceProvisionError extends Error {
  constructor(
    readonly code:
      | 'service_not_found'
      | 'service_not_agent_accessible'
      | 'service_not_configured'
      | 'invalid_service_config',
    message: string,
  ) {
    super(message);
    this.name = 'ServiceProvisionError';
  }
}

function presentFields(
  values: Readonly<Record<string, ServiceFieldValue>>,
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
  const values: Record<string, ServiceFieldValue> = {
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

const imageAdapter: ServiceStorageAdapter = {
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
      throw new ServiceProvisionError(
        'invalid_service_config',
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
}): ServiceStorageAdapter {
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

const inkOcrAdapter: ServiceStorageAdapter = {
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
      throw new ServiceProvisionError(
        'invalid_service_config',
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

const adapters = new Map<string, ServiceStorageAdapter>([
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

function adapterFor(manifest: ServiceManifest): ServiceStorageAdapter {
  const adapter = adapters.get(manifest.storage.namespace);
  if (!adapter) {
    throw new Error(
      `Unknown Service storage namespace: ${manifest.storage.namespace}`,
    );
  }
  return adapter;
}

function isConfigured(
  manifest: ServiceManifest,
  configuredFields: readonly string[],
): boolean {
  const configured = new Set(configuredFields);
  return manifest.configuration
    .filter((field) => field.required)
    .every((field) => configured.has(field.id));
}

function validateUpdate(
  manifest: ServiceManifest,
  values: Readonly<Record<string, ServiceFieldValue>>,
): void {
  const fields = new Map(
    manifest.configuration.map((field) => [field.id, field]),
  );
  for (const [id, value] of Object.entries(values)) {
    const field = fields.get(id);
    if (!field) {
      throw new ServiceProvisionError(
        'invalid_service_config',
        `Unknown configuration field: ${id}`,
      );
    }
    if (value === null) continue;
    if (field.type === 'boolean') {
      if (typeof value !== 'boolean') {
        throw new ServiceProvisionError(
          'invalid_service_config',
          `${field.label} must be a boolean`,
        );
      }
      continue;
    }
    if (typeof value !== 'string') {
      throw new ServiceProvisionError(
        'invalid_service_config',
        `${field.label} must be text`,
      );
    }
    if (field.type === 'url' && value) {
      try {
        const url = new URL(value);
        if (url.protocol !== 'https:') throw new Error();
      } catch {
        throw new ServiceProvisionError(
          'invalid_service_config',
          `${field.label} must be an HTTPS URL`,
        );
      }
    }
    if (
      field.type === 'enum' &&
      value &&
      !field.options?.some((option) => option.value === value)
    ) {
      throw new ServiceProvisionError(
        'invalid_service_config',
        `Invalid ${field.label}`,
      );
    }
  }
}

export class ServiceProvisioner {
  constructor(
    private readonly manifests: ReadonlyMap<string, ServiceManifest>,
  ) {}

  private manifest(serviceId: string): ServiceManifest {
    const manifest = this.manifests.get(serviceId);
    if (!manifest) {
      throw new ServiceProvisionError(
        'service_not_found',
        `Unknown Service: ${serviceId}`,
      );
    }
    return manifest;
  }

  list(): ServiceSummary[] {
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

  getConfig(serviceId: string): ServiceConfig {
    const manifest = this.manifest(serviceId);
    const snapshot = adapterFor(manifest).read();
    return {
      manifest,
      values: snapshot.values,
      configuredFields: snapshot.configuredFields,
      configured: isConfigured(manifest, snapshot.configuredFields),
    };
  }

  async updateConfig(
    serviceId: string,
    values: Readonly<Record<string, ServiceFieldValue>>,
  ): Promise<ServiceConfig> {
    const manifest = this.manifest(serviceId);
    validateUpdate(manifest, values);
    await adapterFor(manifest).update(values);
    return this.getConfig(serviceId);
  }

  resolveForServer(serviceId: string): Record<string, ServiceFieldValue> {
    const manifest = this.manifest(serviceId);
    const adapter = adapterFor(manifest);
    const snapshot = adapter.read();
    if (!isConfigured(manifest, snapshot.configuredFields)) {
      throw new ServiceProvisionError(
        'service_not_configured',
        `Service "${serviceId}" is not configured`,
      );
    }
    return adapter.resolve();
  }

  lease(serviceId: string): ServiceLease {
    const manifest = this.manifest(serviceId);
    if (!manifest.agent) {
      throw new ServiceProvisionError(
        'service_not_agent_accessible',
        `Service "${serviceId}" is not available to External Agents`,
      );
    }
    return {
      id: manifest.id,
      version: manifest.version,
      config: this.resolveForServer(serviceId),
      ...(manifest.agent?.client ? { client: manifest.agent.client } : {}),
    };
  }
}
