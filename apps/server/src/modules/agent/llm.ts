/**
 * LLM Configuration — pi-ai based
 *
 * Provides a configured Model instance for Azure OpenAI (Responses API).
 * Replaces the previous LangChain AzureChatOpenAI wrapper.
 */

import type { Model } from '@mariozechner/pi-ai';

let cachedModel: Model<'azure-openai-responses'> | null = null;

/**
 * Get a configured Azure OpenAI model via pi-ai.
 *
 * Environment variables:
 *   AZURE_OPENAI_API_KEY
 *   AZURE_OPENAI_API_ENDPOINT (full base URL, e.g. https://xxx.cognitiveservices.azure.com)
 *   AZURE_OPENAI_API_DEPLOYMENT_NAME
 *   AZURE_OPENAI_API_VERSION (default: read by pi-ai from env)
 */
export function getLLMModel(): Model<'azure-openai-responses'> {
  if (cachedModel) return cachedModel;

  const apiKey = process.env.AZURE_OPENAI_API_KEY;
  const endpoint = process.env.AZURE_OPENAI_API_ENDPOINT;
  const deploymentName = process.env.AZURE_OPENAI_API_DEPLOYMENT_NAME;

  if (!apiKey || !endpoint) {
    throw new Error(
      'Azure OpenAI credentials are missing. Set AZURE_OPENAI_API_KEY and AZURE_OPENAI_API_ENDPOINT in apps/server/.env',
    );
  }

  if (!deploymentName) {
    throw new Error(
      'AZURE_OPENAI_API_DEPLOYMENT_NAME is required. Set it in apps/server/.env',
    );
  }

  // The openai SDK's AzureOpenAI class uses baseURL directly.
  // When 'endpoint' is provided to AzureOpenAI, it auto-appends '/openai'.
  // But pi-ai passes our baseUrl as 'baseURL' (not 'endpoint'), so we must
  // include the '/openai' path ourselves.
  const baseUrl = endpoint.replace(/\/+$/, '') + '/openai';

  cachedModel = {
    id: deploymentName,
    name: `Azure OpenAI (${deploymentName})`,
    api: 'azure-openai-responses',
    provider: 'azure-openai',
    baseUrl,
    reasoning: false,
    input: ['text', 'image'] as ('text' | 'image')[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
  } as Model<'azure-openai-responses'>;

  return cachedModel;
}
